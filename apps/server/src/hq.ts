// MedFlow HQ: the platform owner's own server. It keeps the list of pharmacies (customers), their
// plans, licence keys, invoices and payments, and answers each pharmacy's daily check-in with a
// licence signed by HQ's private key. The console (your screens) is served from here too.
// Start: node medflow-hq.mjs   options: --data <folder> --port <n> (default 5299)
// The signing key is created on first start in <install>/hq-keys; keep that folder private and
// backed up: a new key means every pharmacy needs an update before its licence can renew.
import type { PGlite } from '@electric-sql/pglite';
import { exportPublicKey, signClaims } from '@medflow/core';
import { createHash, randomBytes, randomUUID, scryptSync, timingSafeEqual } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { backupNow, scheduleBackups } from './backup.ts';
import { ApiError, asPrincipal, callFunction, openDatabase, type Claims } from './db.ts';
import { isLocal, readJson, send, serveStatic } from './http.ts';

const VERSION = '0.1.0';
const here = path.dirname(fileURLToPath(import.meta.url));
const home = path.basename(here) === 'dist' ? path.dirname(here) : here;
const arg = (name: string) => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? process.argv[i + 1] ?? null : null; };
const abs = (p: string) => (path.isAbsolute(p) ? p : path.resolve(home, p));
const cfg = {
  port: Number(arg('port') ?? 5299),
  data: abs(arg('data') ?? 'hq-data'),
  keys: abs(arg('keys') ?? 'hq-keys'),
  backups: abs(arg('backups') ?? 'hq-backups'),
  releases: abs(arg('releases') ?? 'hq-releases'),
  public: abs(arg('public') ?? 'hq-public'),
  sql: abs(arg('sql') ?? 'sql'),
  logs: abs('logs'),
};
fs.mkdirSync(cfg.logs, { recursive: true });
function log(s: string) {
  const line = `${new Date().toISOString()} ${s}`;
  console.log(line);
  try { fs.appendFileSync(path.join(cfg.logs, 'medflow-hq.log'), `${line}\n`); } catch { /* keep running */ }
}

async function signingKey(): Promise<{ privateKey: CryptoKey; publicRaw: string }> {
  const file = path.join(cfg.keys, 'signing-key.json');
  if (fs.existsSync(file)) {
    const j = JSON.parse(fs.readFileSync(file, 'utf8')) as { pkcs8: string; public: string };
    const privateKey = await crypto.subtle.importKey('pkcs8', Buffer.from(j.pkcs8, 'base64'), { name: 'Ed25519' }, false, ['sign']);
    return { privateKey, publicRaw: j.public };
  }
  const pair = await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify']) as CryptoKeyPair;
  const pkcs8 = Buffer.from(await crypto.subtle.exportKey('pkcs8', pair.privateKey)).toString('base64');
  const publicRaw = await exportPublicKey(pair.publicKey);
  fs.mkdirSync(cfg.keys, { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ pkcs8, public: publicRaw, created_at: new Date().toISOString() }, null, 2), { mode: 0o600 });
  fs.writeFileSync(path.join(cfg.keys, 'public-key.txt'), `${publicRaw}\n`);
  // A second copy with the backups, so copying the backups folder somewhere safe also saves the key.
  fs.mkdirSync(cfg.backups, { recursive: true });
  fs.copyFileSync(file, path.join(cfg.backups, 'HQ-SIGNING-KEY-keep-secret.json'));
  log(`New HQ signing key created in ${cfg.keys} (keep it private and backed up)`);
  return { privateKey: await crypto.subtle.importKey('pkcs8', Buffer.from(pkcs8, 'base64'), { name: 'Ed25519' }, false, ['sign']), publicRaw };
}

const hashPassword = (pw: string, salt = randomBytes(16)) => `scrypt$${salt.toString('base64')}$${scryptSync(pw, salt, 32).toString('base64')}`;
function checkPassword(pw: string, stored: string) {
  const [, salt, hash] = stored.split('$');
  if (!salt || !hash) return false;
  const a = scryptSync(pw, Buffer.from(salt, 'base64'), 32);
  const b = Buffer.from(hash, 'base64');
  return a.length === b.length && timingSafeEqual(a, b);
}

const SERVICE: Claims = { role: 'service_role' };

/** As the service role (check-ins and payments by licence key): set local role service_role. */
async function asService<T>(db: PGlite, fn: (tx: Parameters<Parameters<typeof asPrincipal>[2]>[0]) => Promise<T>): Promise<T> {
  try {
    return await db.transaction(async (tx) => {
      await tx.query(`select set_config('request.jwt.claims', $1, true)`, [JSON.stringify(SERVICE)]);
      await tx.exec('set local role service_role');
      return fn(tx);
    });
  } catch (err) {
    const e = err as { message?: string; code?: string; hint?: string };
    throw new ApiError(e.message ?? String(err), e.code === '42501' ? 403 : 400, e.code ?? '', e.hint ?? null);
  }
}

async function main() {
  log(`MedFlow HQ ${VERSION} starting · data ${cfg.data}`);
  const db = await openDatabase(cfg.data, cfg.sql, log);
  await db.exec(`create table if not exists medflow_local.hq_passwords (admin_id uuid primary key, email text not null unique, hash text not null)`);
  const key = await signingKey();
  log(`HQ public key (built into MedFlow Local): ${key.publicRaw}`);

  // Billing and the lifecycle (trials end, invoices fall due, grace, read-only at closing time).
  const tick = async () => {
    try {
      const r = await db.query<{ n: number; t: unknown }>('select public.platform_run_billing() n, public.platform_tick() t');
      const t = r.rows[0]?.t as { status_changes?: number } | undefined;
      if (r.rows[0]?.n || t?.status_changes) log(`Billing: ${r.rows[0]?.n} invoices, ${t?.status_changes ?? 0} status changes`);
    } catch (e) { log(`Billing run failed: ${(e as Error).message}`); }
  };
  setTimeout(() => void tick(), 5_000);
  setInterval(() => void tick(), 15 * 60_000);
  scheduleBackups(() => backupNow(db, cfg.backups, null, 30, log), cfg.backups, 2, log);

  const sessions = new Map<string, { auth: string; until: number }>();
  const failures = new Map<string, { n: number; until: number }>();
  const hasAdmin = async () => ((await db.query<{ n: number }>('select count(*)::int n from medflow_local.hq_passwords')).rows[0]?.n ?? 0) > 0;

  const api = async (req: http.IncomingMessage, res: http.ServerResponse, route: string) => {
    if (route === 'status' && req.method === 'GET') {
      return send(res, 200, { app: 'medflow-hq', version: VERSION, has_admin: await hasAdmin(), this_pc: isLocal(req), public_key: key.publicRaw });
    }
    // ---- A pharmacy downloads an update (its licence key proves it is a customer) ----
    if (route.startsWith('download/') && req.method === 'GET') {
      const file = route.slice('download/'.length);
      if (!/^medflow-local-[0-9a-z.-]+\.tar\.gz$/.test(file)) throw new ApiError('Not found', 404);
      const key = String(req.headers['x-licence-key'] ?? '');
      const ok = (await db.query<{ t: string | null }>('select app.licence_key_tenant($1) t', [key])).rows[0]?.t;
      if (!ok) throw new ApiError('A valid licence key is required', 403);
      const full = path.join(cfg.releases, file);
      if (!fs.existsSync(full)) throw new ApiError('Not found', 404);
      res.writeHead(200, { 'Content-Type': 'application/gzip', 'Content-Length': String(fs.statSync(full).size) });
      fs.createReadStream(full).pipe(res);
      return;
    }
    // ---- You upload a new MedFlow Local version; HQ signs it ----
    if (route === 'admin/release' && req.method === 'POST') {
      const s = sessions.get((req.headers.authorization ?? '').replace(/^Bearer\s+/i, ''));
      if (!s || s.until < Date.now()) throw new ApiError('Sign in to MedFlow HQ', 401);
      const version = String(req.headers['x-medflow-version'] ?? '');
      const channel = String(req.headers['x-medflow-channel'] ?? 'stable');
      const notes = decodeURIComponent(String(req.headers['x-medflow-notes'] ?? ''));
      if (!/^[0-9]+\.[0-9]+\.[0-9]+(-[a-z0-9.]+)?$/.test(version)) throw new ApiError('Version must look like 1.2.3');
      if (!['internal', 'beta', 'stable'].includes(channel)) throw new ApiError('Unknown channel');
      fs.mkdirSync(cfg.releases, { recursive: true });
      const file = `medflow-local-${version}.tar.gz`;
      const tmp = path.join(cfg.releases, `${file}.part`);
      const hash = createHash('sha256');
      let size = 0;
      const out = fs.createWriteStream(tmp);
      for await (const c of req) {
        size += (c as Buffer).length;
        if (size > 400 * 1048576) { out.destroy(); fs.rmSync(tmp, { force: true }); throw new ApiError('The file is too big (400 MB at most)', 413); }
        hash.update(c as Buffer);
        if (!out.write(c)) await new Promise<void>((r) => out.once('drain', () => r()));
      }
      await new Promise<void>((r, j) => out.end((e?: Error | null) => (e ? j(e) : r())));
      const head = Buffer.alloc(2);
      const fd = fs.openSync(tmp, 'r'); fs.readSync(fd, head, 0, 2, 0); fs.closeSync(fd);
      if (size < 1024 || head[0] !== 0x1f || head[1] !== 0x8b) { fs.rmSync(tmp, { force: true }); throw new ApiError('Upload the medflow-local-x.y.z.tar.gz file made by the build'); }
      fs.renameSync(tmp, path.join(cfg.releases, file));
      const sha256 = hash.digest('hex');
      const signature = await signClaims({ kind: 'release', app: 'local', version, sha256, size_bytes: size }, key.privateKey);
      const claims = { sub: s.auth, role: 'authenticated', aal: 'aal2' };
      const id = await asPrincipal(db, claims, (tx) => callFunction(tx, 'platform_publish_release',
        [{ app: 'local', version, channel, notes, artifact_url: `/hq/download/${file}`, signature, sha256, size_bytes: size }], false));
      log(`Release ${version} (${channel}) published, ${(size / 1048576).toFixed(1)} MB`);
      return send(res, 200, { id, version, sha256, size_bytes: size });
    }
    if (req.method !== 'POST') throw new ApiError('Not found', 404);
    const body = await readJson(req);

    // ---- A pharmacy's MedFlow Local, by licence key ----
    if (route === 'checkin') {
      const claims = await asService(db, (tx) => callFunction(tx, 'hq_checkin', [String(body.key ?? ''), body.install_id ?? null, body.info ?? {}], false));
      const token = await signClaims(claims as object, key.privateKey);
      return send(res, 200, { token });
    }
    if (route === 'payment') {
      const id = await asService(db, (tx) => callFunction(tx, 'hq_submit_payment',
        [String(body.key ?? ''), body.invoice ?? null, String(body.method ?? 'other'), Number(body.amount ?? 0), String(body.reference ?? '')], false));
      log(`Payment reference submitted for invoice ${String(body.invoice)}`);
      return send(res, 200, { id });
    }

    // ---- You (the platform owner) ----
    if (route === 'admin/setup') {
      if (!isLocal(req)) throw new ApiError('Create the HQ admin on the HQ computer itself', 403);
      if (await hasAdmin()) throw new ApiError('The HQ admin already exists', 409);
      const name = String(body.name ?? '').trim();
      const email = String(body.email ?? '').trim().toLowerCase();
      const pw = String(body.password ?? '');
      if (!name || !/^\S+@\S+\.\S+$/.test(email)) throw new ApiError('Enter your name and email');
      if (pw.length < 10) throw new ApiError('Use a password of at least 10 characters');
      const auth = randomUUID();
      await db.transaction(async (tx) => {
        await tx.query('insert into auth.users (id, email) values ($1, $2)', [auth, email]);
        const id = (await tx.query<{ id: string }>('insert into platform_admins (auth_user_id, full_name, email) values ($1, $2, $3) returning id', [auth, name, email])).rows[0]!.id;
        await tx.query('insert into medflow_local.hq_passwords (admin_id, email, hash) values ($1, $2, $3)', [id, email, hashPassword(pw)]);
      });
      log(`HQ admin created: ${email}`);
      return send(res, 200, { ok: true });
    }
    if (route === 'admin/login') {
      const from = req.socket.remoteAddress ?? '?';
      const f = failures.get(from);
      if (f && f.until > Date.now()) throw new ApiError('Too many wrong passwords. Wait a few minutes.', 429);
      const email = String(body.email ?? '').trim().toLowerCase();
      const row = (await db.query<{ hash: string; auth_user_id: string; is_active: boolean }>(`
        select p.hash, a.auth_user_id, a.is_active from medflow_local.hq_passwords p join platform_admins a on a.id = p.admin_id where p.email = $1`, [email])).rows[0];
      if (!row || !row.is_active || !checkPassword(String(body.password ?? ''), row.hash)) {
        const n = (f?.n ?? 0) + 1;
        failures.set(from, { n: n >= 5 ? 0 : n, until: n >= 5 ? Date.now() + 10 * 60_000 : 0 });
        throw new ApiError('Wrong email or password', 403);
      }
      failures.delete(from);
      const token = randomBytes(32).toString('base64url');
      sessions.set(token, { auth: row.auth_user_id, until: Date.now() + 12 * 3600_000 });
      log(`HQ admin signed in from ${from}`);
      return send(res, 200, { token });
    }
    const bearer = (req.headers.authorization ?? '').replace(/^Bearer\s+/i, '');
    const s = sessions.get(bearer);
    if (!s || s.until < Date.now()) { sessions.delete(bearer); throw new ApiError('Sign in to MedFlow HQ', 401); }
    if (route === 'admin/logout') { sessions.delete(bearer); return send(res, 200, { ok: true }); }
    if (route === 'admin/call') {
      const fn = String(body.fn ?? '');
      if (!/^platform_[a-z_]+$/.test(fn)) throw new ApiError('Unknown function', 400);
      const claims = { sub: s.auth, role: 'authenticated', aal: 'aal2' };
      const r = await asPrincipal(db, claims, (tx) => callFunction(tx, fn, Array.isArray(body.args) ? body.args : [], false));
      return send(res, 200, { r });
    }
    throw new ApiError('Not found', 404);
  };

  const server = http.createServer((req, res) => {
    const url = req.url ?? '/';
    if (!url.startsWith('/hq/')) { serveStatic(cfg.public, req, res); return; }
    const route = url.slice(4).split('?')[0]!;
    api(req, res, route).catch((err) => {
      if (err instanceof ApiError) send(res, err.status, { error: err.message, code: err.code, hint: err.hint });
      else { log(`Error on ${route}: ${(err as Error).stack ?? err}`); send(res, 500, { error: 'MedFlow HQ had a problem. See the log.' }); }
    });
  });
  server.on('error', (err: NodeJS.ErrnoException) => {
    log(err.code === 'EADDRINUSE' ? `Port ${cfg.port} is in use: MedFlow HQ is probably already running.` : `Server error: ${err.message}`);
    process.exit(err.code === 'EADDRINUSE' ? 3 : 1);
  });
  server.listen(cfg.port, '0.0.0.0', () => log(`MedFlow HQ is ready: http://localhost:${cfg.port}`));
  const stop = async () => { server.close(); await db.close().catch(() => {}); process.exit(0); };
  process.on('SIGINT', () => void stop());
  process.on('SIGTERM', () => void stop());
}

main().catch((err) => { log(`MedFlow HQ could not start: ${(err as Error).stack ?? err}`); process.exit(1); });
