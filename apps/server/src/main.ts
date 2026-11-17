// MedFlow Local: the pharmacy's own server on the main shop PC. It keeps the database in a folder
// on this PC, serves the MedFlow app to every counter on the shop's network, and backs up nightly.
// No internet and no monthly bill. Start: node medflow-server.mjs  (options below)
//   --data <folder>      where the database lives          (default: <install>/data)
//   --port <n>           the shop network port              (default: 5199)
//   --backups <folder>   where backups go                   (default: <install>/backups)
//   --copy-to <folder>   a second copy of every backup      (e.g. a Google Drive folder)
//   --restore <file>     replace the data with a backup, then exit (stop the server first)
import type { PGlite } from '@electric-sql/pglite';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { backupNow, listBackups, restore, scheduleBackups } from './backup.ts';
import { ApiError, asPrincipal, callFunction, openDatabase } from './db.ts';
import { counterFor, linkCounter, ownerClaims, pharmacy, setupDemo, setupPharmacy } from './setup.ts';

const VERSION = '0.1.0';
const here = path.dirname(fileURLToPath(import.meta.url));
const home = path.basename(here) === 'dist' ? path.dirname(here) : here;

interface Config { port: number; data: string; backups: string; copyTo: string | null; backupHour: number; public: string; sql: string; logs: string }

function loadConfig(): Config & { restore: string | null } {
  let file: Partial<Config> = {};
  const cfgPath = path.join(home, 'config.json');
  if (fs.existsSync(cfgPath)) {
    try { file = JSON.parse(fs.readFileSync(cfgPath, 'utf8')) as Partial<Config>; } catch { /* keep defaults */ }
  }
  const arg = (name: string) => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? process.argv[i + 1] ?? null : null; };
  const abs = (p: string) => (path.isAbsolute(p) ? p : path.resolve(home, p));
  return {
    port: Number(arg('port') ?? file.port ?? 5199),
    data: abs(arg('data') ?? file.data ?? 'data'),
    backups: abs(arg('backups') ?? file.backups ?? 'backups'),
    copyTo: arg('copy-to') ?? file.copyTo ?? null,
    backupHour: Number(file.backupHour ?? 23),
    public: abs(arg('public') ?? file.public ?? 'public'),
    sql: abs(arg('sql') ?? file.sql ?? 'sql'),
    logs: abs(file.logs ?? 'logs'),
    restore: arg('restore'),
  };
}

const cfg = loadConfig();
fs.mkdirSync(cfg.logs, { recursive: true });
const logFile = path.join(cfg.logs, 'medflow.log');
function log(s: string) {
  const line = `${new Date().toISOString()} ${s}`;
  console.log(line);
  try { fs.appendFileSync(logFile, `${line}\n`); } catch { /* disk full: keep running */ }
}

function lanAddresses(port: number): string[] {
  return Object.values(os.networkInterfaces()).flat()
    .filter((a): a is os.NetworkInterfaceInfo => !!a && a.family === 'IPv4' && !a.internal)
    .map((a) => `http://${a.address}:${port}`);
}

const isLocal = (req: http.IncomingMessage) => ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress ?? '');

async function readJson(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > 25 * 1048576) throw new ApiError('Too much data in one request', 413);
    chunks.push(c as Buffer);
  }
  if (!size) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>; } catch { throw new ApiError('Invalid JSON'); }
}

function send(res: http.ServerResponse, status: number, body: unknown) {
  const text = JSON.stringify(body ?? null);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(text);
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json', '.wasm': 'application/wasm', '.data': 'application/octet-stream',
  '.woff2': 'font/woff2', '.txt': 'text/plain; charset=utf-8', '.webmanifest': 'application/manifest+json',
};

function serveStatic(req: http.IncomingMessage, res: http.ServerResponse) {
  const urlPath = decodeURIComponent((req.url ?? '/').split('?')[0]!);
  let file = path.normalize(path.join(cfg.public, urlPath));
  if (!file.startsWith(cfg.public)) { res.writeHead(403).end(); return; }
  if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) file = path.join(cfg.public, 'index.html');
  if (!fs.existsSync(file)) { res.writeHead(404, { 'Content-Type': 'text/plain' }).end('MedFlow app files are missing (public folder).'); return; }
  const hashed = urlPath.startsWith('/assets/');
  res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] ?? 'application/octet-stream', 'Cache-Control': hashed ? 'public, max-age=31536000, immutable' : 'no-cache' });
  fs.createReadStream(file).pipe(res);
}

async function main() {
  if (cfg.restore) {
    await restore(path.resolve(cfg.restore), cfg.data, log);
    return;
  }
  log(`MedFlow Local ${VERSION} starting · data ${cfg.data}`);
  const db: PGlite = await openDatabase(cfg.data, cfg.sql, log);
  const doBackup = () => backupNow(db, cfg.backups, cfg.copyTo, 30, log);
  scheduleBackups(doBackup, cfg.backups, cfg.backupHour, log);

  const api = async (req: http.IncomingMessage, res: http.ServerResponse, route: string) => {
    const token = (req.headers.authorization ?? '').replace(/^Bearer\s+/i, '') || undefined;
    const sessionHeader = req.headers['x-medflow-session'];
    const sessionId = typeof sessionHeader === 'string' && sessionHeader ? sessionHeader : undefined;

    if (route === 'status' && req.method === 'GET') {
      const ph = await pharmacy(db);
      return send(res, 200, { ready: !!ph, pharmacy: ph?.name ?? null, version: VERSION, this_pc: isLocal(req), addresses: lanAddresses(cfg.port) });
    }
    if (req.method !== 'POST' && route !== 'backups') throw new ApiError('Not found', 404);
    const body = req.method === 'POST' ? await readJson(req) : {};

    if (route === 'setup') {
      if (!isLocal(req)) throw new ApiError('Set up MedFlow on the main PC itself (where MedFlow Local is installed)', 403);
      const r = body.mode === 'demo' ? await setupDemo(db) : await setupPharmacy(db, body as never);
      log(body.mode === 'demo' ? 'Set up with the Demo Pharmacy' : `Set up pharmacy "${String(body.pharmacy)}"`);
      return send(res, 200, r);
    }
    if (route === 'link') {
      const r = await linkCounter(db, req.socket.remoteAddress ?? '?', String(body.pin ?? ''), String(body.name ?? ''));
      log(`Linked a counter PC ${r.invoice_prefix} from ${req.socket.remoteAddress}`);
      return send(res, 200, r);
    }

    const counter = await counterFor(db, token);
    const device = { sub: counter.auth_user_id, role: 'authenticated', aal: 'aal1' };

    if (route === 'call') {
      const fn = String(body.fn ?? '');
      const args = Array.isArray(body.args) ? body.args : [];
      // Back-office screens are the owner's: a counter on its own cannot call them.
      if (body.as !== 'owner' && fn.startsWith('office_')) throw new ApiError('Sign in as the owner on this counter', 403);
      const claims = body.as === 'owner' ? await ownerClaims(db, counter, sessionId) : device;
      return send(res, 200, { r: await asPrincipal(db, claims, (tx) => callFunction(tx, fn, args, body.rows === true)) });
    }
    if (route === 'approval-status') {
      const r = await asPrincipal(db, device, async (tx) => (await tx.query<{ status: string }>('select status from approval_requests where id = $1', [String(body.id)])).rows[0]?.status);
      return send(res, 200, { r: r ?? 'expired' });
    }
    if (route === 'command') {
      // Held bills and other counter commands go through the same outbox as an offline counter.
      const r = await asPrincipal(db, device, async (tx) => {
        const seq = (await tx.query<{ n: number }>('select coalesce(max(device_seq), 0)::int + 1 n from device_commands where device_id = $1', [counter.device_id])).rows[0]!.n;
        const who = (await tx.query<{ user_id: string }>('select user_id from user_sessions where id = $1', [String(body.session ?? '')])).rows[0]?.user_id ?? null;
        return (await tx.query<{ r: Array<{ status: string; result?: { error?: string } }> }>('select public.apply_device_commands($1::jsonb) r', [JSON.stringify([{
          id: crypto.randomUUID(), device_seq: seq, kind: String(body.kind), acting_user: who, session_id: body.session ?? null,
          created_on_device_at: new Date().toISOString(), payload: body.payload ?? {} }])])).rows[0]!.r;
      });
      if (r[0]?.status === 'rejected') throw new ApiError(r[0].result?.error ?? 'Could not save');
      return send(res, 200, { r: null });
    }
    if (route === 'backups') {
      await ownerClaims(db, counter, sessionId);
      if (req.method === 'POST') await doBackup();
      return send(res, 200, { folder: cfg.backups, copy_to: cfg.copyTo, list: listBackups(cfg.backups).slice(0, 30) });
    }
    throw new ApiError('Not found', 404);
  };

  const server = http.createServer((req, res) => {
    const url = req.url ?? '/';
    if (!url.startsWith('/api/')) { serveStatic(req, res); return; }
    const route = url.slice(5).split('?')[0]!;
    api(req, res, route).catch((err) => {
      if (err instanceof ApiError) {
        send(res, err.status, { error: err.message, code: err.code, hint: err.hint, detail: err.detail });
      } else {
        log(`Error on ${route}: ${(err as Error).stack ?? err}`);
        send(res, 500, { error: 'MedFlow Local had a problem. Details are in the log file.' });
      }
    });
  });
  server.on('error', (err: NodeJS.ErrnoException) => {
    if (err.code === 'EADDRINUSE') log(`Port ${cfg.port} is in use: MedFlow Local is probably already running.`);
    else log(`Server error: ${err.message}`);
    process.exit(err.code === 'EADDRINUSE' ? 3 : 1);
  });
  server.listen(cfg.port, '0.0.0.0', () => {
    log(`MedFlow is ready on this PC: http://localhost:${cfg.port}`);
    for (const a of lanAddresses(cfg.port)) log(`Other counters on the shop network open: ${a}`);
  });
  const stop = async () => { log('Stopping…'); server.close(); await db.close().catch(() => {}); process.exit(0); };
  process.on('SIGINT', () => void stop());
  process.on('SIGTERM', () => void stop());
}

main().catch((err) => { log(`MedFlow Local could not start: ${(err as Error).stack ?? err}`); process.exit(1); });
