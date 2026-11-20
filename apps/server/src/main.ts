// Nuskha Local: the pharmacy's own server on the main shop PC. It keeps the database in a folder
// on this PC, serves the Nuskha app to every counter on the shop's network, and backs up nightly.
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
import { backupKey, backupNow, keyText, listBackups, parseKey, restore, scheduleBackups } from './backup.ts';
import { ApiError, asPrincipal, callFunction, openDatabase } from './db.ts';
import { claimPort, clientAddress, isLocal, lanAddresses, readJson, send, serveStatic } from './http.ts';
import { Licence } from './licence.ts';
import { startupGuard, startupOk, Updater } from './updater.ts';
import { counterFor, linkCounter, ownerClaims, pharmacy, setupPharmacy } from './setup.ts';

declare const __MEDFLOW_VERSION__: string | undefined;
const VERSION = typeof __MEDFLOW_VERSION__ === 'string' ? __MEDFLOW_VERSION__ : '0.0.0-dev';
const here = path.dirname(fileURLToPath(import.meta.url));
const home = path.basename(here) === 'dist' ? path.dirname(here) : here;

interface Config { hqUrl: string | null; port: number; data: string; backups: string; copyTo: string | null; backupHour: number; public: string; sql: string; logs: string }

function loadConfig(): Config & { restore: string | null; key: string | null } {
  let file: Partial<Config> = {};
  const cfgPath = path.join(home, 'config.json');
  if (fs.existsSync(cfgPath)) {
    try { file = JSON.parse(fs.readFileSync(cfgPath, 'utf8')) as Partial<Config>; } catch { /* keep defaults */ }
  }
  const arg = (name: string) => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? process.argv[i + 1] ?? null : null; };
  const abs = (p: string) => (path.isAbsolute(p) ? p : path.resolve(home, p));
  return {
    hqUrl: arg('hq') ?? file.hqUrl ?? null,
    port: Number(arg('port') ?? file.port ?? 5199),
    data: abs(arg('data') ?? file.data ?? 'data'),
    backups: abs(arg('backups') ?? file.backups ?? 'backups'),
    copyTo: arg('copy-to') ?? file.copyTo ?? null,
    backupHour: Number(file.backupHour ?? 23),
    public: abs(arg('public') ?? file.public ?? 'public'),
    sql: abs(arg('sql') ?? file.sql ?? 'sql'),
    logs: abs(file.logs ?? 'logs'),
    restore: arg('restore'),
    key: arg('key'),
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

async function main() {
  if (!cfg.restore) startupGuard(home, log);
  if (cfg.restore) {
    await restore(path.resolve(cfg.restore), cfg.data, log, cfg.key ? parseKey(cfg.key) : backupKey(home));
    return;
  }
  log(`Nuskha Local ${VERSION} starting · data ${cfg.data}`);
  const { server, ready } = await claimPort(cfg.port, 'Nuskha is starting, one moment…', log);
  const db: PGlite = await openDatabase(cfg.data, cfg.sql, log);
  const bkey = backupKey(home);
  const licence = new Licence(db, cfg.hqUrl, VERSION, log);
  licence.backupKey = keyText(bkey);
  const updater = new Updater(home, VERSION, licence.hqUrl, () => licence.key, () => licence.licenceKey(),
    () => backupNow(db, cfg.backups, cfg.copyTo, 30, log, bkey), log);
  licence.onLicence = (c) => updater.setOffer(c.update);
  licence.extraStats = () => { const f = updater.failedVersion(); return f ? { update_failed: f } : {}; };
  await licence.start();
  if (licence.enabled) updater.start();
  const doBackup = () => backupNow(db, cfg.backups, cfg.copyTo, 30, log, bkey);
  scheduleBackups(doBackup, cfg.backups, cfg.backupHour, log);

  const api = async (req: http.IncomingMessage, res: http.ServerResponse, route: string) => {
    const token = (req.headers.authorization ?? '').replace(/^Bearer\s+/i, '') || undefined;
    const sessionHeader = req.headers['x-medflow-session'];
    const sessionId = typeof sessionHeader === 'string' && sessionHeader ? sessionHeader : undefined;

    if (route === 'status' && req.method === 'GET') {
      const ph = await pharmacy(db);
      return send(res, 200, { ready: !!ph, pharmacy: ph?.name ?? null, version: VERSION, this_pc: isLocal(req), addresses: lanAddresses(cfg.port),
        licence: ph ? await licence.status() : null, licensing: licence.enabled, update: licence.enabled ? updater.status() : null });
    }
    if (req.method !== 'POST' && route !== 'backups') throw new ApiError('Not found', 404);
    const body = req.method === 'POST' ? await readJson(req) : {};

    if (route === 'setup') {
      if (!isLocal(req)) throw new ApiError('Set up Nuskha on the main PC itself (where Nuskha Local is installed)', 403);
      if (body.mode === 'demo') { send(res, 400, { error: 'The demo pharmacy is not part of Nuskha Local.' }); return; }
      const r = await setupPharmacy(db, body as never);
      log(body.mode === 'demo' ? 'Set up with the Demo Pharmacy' : `Set up pharmacy "${String(body.pharmacy)}"`);
      let licence_error: string | null = null;
      if (body.mode !== 'demo' && licence.enabled) {
        const key = String(body.licence_key ?? '').trim();
        if (key) await licence.checkIn(key).catch((e: Error) => { licence_error = e.message; });
        else await licence.apply();
      }
      setTimeout(() => { doBackup().catch((e) => log(`Backup after setup failed: ${(e as Error).message}`)); }, 5_000);
      return send(res, 200, { ...r, licence_error });
    }
    if (route === 'link') {
      const r = await linkCounter(db, clientAddress(req), String(body.pin ?? ''), String(body.name ?? ''));
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
    if (route === 'licence/check') return send(res, 200, await licence.checkIn());
    if (route === 'update/install') {
      await ownerClaims(db, counter, sessionId);
      await updater.install();
      return send(res, 200, { ok: true, restarting: true });
    }
    if (route === 'licence/key') {
      await ownerClaims(db, counter, sessionId);
      return send(res, 200, await licence.checkIn(String(body.key ?? '')));
    }
    if (route === 'licence/payment') {
      await ownerClaims(db, counter, sessionId);
      await licence.submitPayment(String(body.invoice ?? ''), String(body.method ?? 'other'), Number(body.amount ?? 0), String(body.reference ?? ''));
      return send(res, 200, await licence.status());
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
      return send(res, 200, { folder: cfg.backups, copy_to: cfg.copyTo, list: listBackups(cfg.backups).slice(0, 30), recovery_key: keyText(bkey) });
    }
    throw new ApiError('Not found', 404);
  };

  ready((req, res) => {
    const url = req.url ?? '/';
    if (!url.startsWith('/api/')) { serveStatic(cfg.public, req, res); return; }
    const route = url.slice(5).split('?')[0]!;
    api(req, res, route).catch((err) => {
      if (err instanceof ApiError) {
        send(res, err.status, { error: err.message, code: err.code, hint: err.hint, detail: err.detail });
      } else {
        log(`Error on ${route}: ${(err as Error).stack ?? err}`);
        send(res, 500, { error: 'Nuskha Local had a problem. Details are in the log file.' });
      }
    });
  });
  log(`Nuskha ${VERSION} is ready on this PC: http://localhost:${cfg.port}`);
  startupOk(home, VERSION, log);
  for (const a of lanAddresses(cfg.port)) log(`Other counters on the shop network open: ${a}`);
  const stop = async () => { log('Stopping…'); server.close(); await db.close().catch(() => {}); process.exit(0); };
  process.on('SIGINT', () => void stop());
  process.on('SIGTERM', () => void stop());
}

main().catch((err) => {
  if (cfg.restore) log(`Restore failed: ${(err as Error).message ?? err}. Your current data was not changed.`);
  else log(`Nuskha Local could not start: ${(err as Error).stack ?? err}`);
  process.exit(1);
});
