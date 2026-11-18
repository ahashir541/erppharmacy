// MedFlow Local updates itself from MedFlow HQ.
//  1. HQ offers a version at check-in (channel and rollback rules are HQ's).
//  2. At night (01:00–05:00, after the 23:00 backup), or when the owner presses "Install now":
//     download, check HQ's signature and the file's SHA-256, back up the data, unpack with tar,
//     keep a copy of the current program, copy the new one over it, and exit; MedFlow-Server.cmd
//     starts the new version, which runs any new database migrations by itself.
//  3. If the new version fails to start three times, the startup guard puts the old one back.
// The data, backups, logs, config, Node itself and the running scripts are never touched.
import { verifyClaims } from '@medflow/core';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { ApiError } from './db.ts';

export interface UpdateOffer { update_available: boolean; version?: string; notes?: string; url?: string; signature?: string;
  size_bytes?: number; is_rollback?: boolean; must_update?: boolean; min_version?: string | null }
export interface UpdateStatus { current: string; offer: UpdateOffer | null; installing: boolean; last_error: string | null;
  last_result: string | null; install_window: string }

export const TAR = process.platform === 'win32' ? path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe') : 'tar';
const KEEP = new Set(['data', 'backups', 'logs', 'config.json', 'node', 'updates', 'MedFlow-Server.cmd', 'start-hidden.vbs', 'MedFlow.vbs']);
const PROGRAM = (name: string) => !KEEP.has(name) && !name.startsWith('data-before-restore');

/** Runs before anything else at start: counts start attempts after an update and rolls back. */
export function startupGuard(home: string, log: (s: string) => void) {
  const dir = path.join(home, 'updates');
  const stateFile = path.join(dir, 'state.json');
  if (!fs.existsSync(stateFile)) return;
  let st: { version: string; from: string; attempts: number; at: string };
  try { st = JSON.parse(fs.readFileSync(stateFile, 'utf8')); } catch { fs.rmSync(stateFile, { force: true }); return; }
  st.attempts += 1;
  fs.writeFileSync(stateFile, JSON.stringify(st));
  if (st.attempts <= 3) { log(`Starting MedFlow ${st.version} after the update (try ${st.attempts})`); return; }
  const prev = path.join(dir, 'previous');
  log(`MedFlow ${st.version} did not start after 3 tries: putting back ${st.from}`);
  if (fs.existsSync(prev)) {
    for (const name of fs.readdirSync(home)) if (PROGRAM(name) && fs.existsSync(path.join(prev, name))) fs.rmSync(path.join(home, name), { recursive: true, force: true });
    for (const name of fs.readdirSync(prev)) fs.cpSync(path.join(prev, name), path.join(home, name), { recursive: true, force: true });
  }
  fs.writeFileSync(path.join(dir, 'last-result.json'), JSON.stringify({ ok: false, version: st.version, back_to: st.from, at: new Date().toISOString() }));
  fs.rmSync(stateFile, { force: true });
  process.exit(0);   // MedFlow-Server.cmd starts the old version again
}

/** Called once the new version is fully up (database open, listening): the update worked. */
export function startupOk(home: string, version: string, log: (s: string) => void) {
  const dir = path.join(home, 'updates');
  const stateFile = path.join(dir, 'state.json');
  if (!fs.existsSync(stateFile)) return;
  const st = JSON.parse(fs.readFileSync(stateFile, 'utf8')) as { from: string };
  fs.rmSync(stateFile, { force: true });
  fs.writeFileSync(path.join(dir, 'last-result.json'), JSON.stringify({ ok: true, version, from: st.from, at: new Date().toISOString() }));
  log(`Update to ${version} complete (was ${st.from})`);
}

export class Updater {
  private offer: UpdateOffer | null = null;
  private installing = false;
  private lastError: string | null = null;
  private timer: NodeJS.Timeout | null = null;

  constructor(private readonly home: string, private readonly version: string, private readonly hqUrl: string,
              private readonly publicKey: () => CryptoKey | null, private readonly licenceKey: () => Promise<string | null>,
              private readonly backup: () => Promise<unknown>, private readonly log: (s: string) => void) {}

  /** A version that failed to start here is not tried again; HQ hears about it at check-in. */
  failedVersion(): string | null {
    try {
      const r = JSON.parse(fs.readFileSync(path.join(this.home, 'updates', 'last-result.json'), 'utf8')) as { ok: boolean; version: string };
      return r.ok ? null : r.version;
    } catch { return null; }
  }

  setOffer(o: UpdateOffer | null | undefined) {
    this.offer = o && o.update_available && o.version !== this.failedVersion() ? o : null;
  }

  start() {
    // Every 15 minutes: install in the night window (or soon after start when the version is too old).
    this.timer = setInterval(() => {
      const h = new Date().getHours();
      if (this.offer && !this.installing && ((h >= 1 && h < 5) || this.offer.must_update)) void this.install().catch(() => {});
    }, 15 * 60_000);
  }

  status(): UpdateStatus {
    let last: string | null = null;
    try {
      const r = JSON.parse(fs.readFileSync(path.join(this.home, 'updates', 'last-result.json'), 'utf8')) as { ok: boolean; version: string; from?: string; back_to?: string; at: string };
      last = r.ok ? `Updated to ${r.version} on ${new Date(r.at).toLocaleString('en-GB')}` : `Update to ${r.version} failed; went back to ${r.back_to}`;
    } catch { /* none yet */ }
    return { current: this.version, offer: this.offer, installing: this.installing, last_error: this.lastError, last_result: last,
             install_window: 'between 1 and 5 at night' };
  }

  async install(): Promise<void> {
    if (this.installing) throw new ApiError('An update is already being installed', 409);
    const o = this.offer;
    if (!o?.version || !o.url || !o.signature) throw new ApiError('No update to install', 400);
    const key = this.publicKey();
    if (!key) throw new ApiError('Updates need MedFlow HQ', 400);
    this.installing = true;
    this.lastError = null;
    const dir = path.join(this.home, 'updates');
    try {
      const signed = await verifyClaims<{ kind: string; app: string; version: string; sha256: string; size_bytes: number }>(o.signature, key);
      if (!signed || signed.kind !== 'release' || signed.app !== 'local' || signed.version !== o.version) {
        throw new ApiError('This update is not signed by MedFlow HQ; it was not installed', 400);
      }
      fs.mkdirSync(dir, { recursive: true });
      this.log(`Update ${o.version}: downloading`);
      const res = await fetch(`${this.hqUrl}${o.url}`, { headers: { 'X-Licence-Key': (await this.licenceKey()) ?? '' }, signal: AbortSignal.timeout(30 * 60_000) });
      if (!res.ok) throw new ApiError(`Could not download the update (${res.status})`, 502);
      const bytes = Buffer.from(await res.arrayBuffer());
      const sha = createHash('sha256').update(bytes).digest('hex');
      if (sha !== signed.sha256 || bytes.length !== signed.size_bytes) throw new ApiError('The downloaded update is damaged (checksum); it was not installed', 400);
      const pkg = path.join(dir, `medflow-local-${o.version}.tar.gz`);
      fs.writeFileSync(pkg, bytes);

      const staging = path.join(dir, 'staging');
      fs.rmSync(staging, { recursive: true, force: true });
      fs.mkdirSync(staging, { recursive: true });
      execFileSync(TAR, ['-xzf', pkg, '-C', staging], { stdio: 'ignore', windowsHide: true });
      const vf = path.join(staging, 'version.json');
      const inside = fs.existsSync(vf) ? (JSON.parse(fs.readFileSync(vf, 'utf8')) as { version?: string }).version : null;
      if (inside !== o.version || !fs.existsSync(path.join(staging, 'medflow-server.mjs'))) throw new ApiError('The update package is not complete; it was not installed', 400);

      this.log(`Update ${o.version}: backing up the data first`);
      await this.backup();

      const prev = path.join(dir, 'previous');
      fs.rmSync(prev, { recursive: true, force: true });
      fs.mkdirSync(prev, { recursive: true });
      for (const name of fs.readdirSync(this.home)) if (PROGRAM(name)) fs.cpSync(path.join(this.home, name), path.join(prev, name), { recursive: true });

      for (const name of fs.readdirSync(staging)) {
        if (!PROGRAM(name)) continue;
        if (name === 'public') fs.rmSync(path.join(this.home, 'public'), { recursive: true, force: true });
        fs.cpSync(path.join(staging, name), path.join(this.home, name), { recursive: true, force: true });
      }
      fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify({ version: o.version, from: this.version, attempts: 0, at: new Date().toISOString() }));
      fs.rmSync(staging, { recursive: true, force: true });
      fs.rmSync(pkg, { force: true });
      this.log(`Update ${o.version}: installed, restarting MedFlow`);
      if (this.timer) clearInterval(this.timer);
      setTimeout(() => process.exit(0), 1500);
    } catch (err) {
      this.installing = false;
      this.lastError = (err as Error).message;
      this.log(`Update ${o.version} failed: ${this.lastError}`);
      throw err instanceof ApiError ? err : new ApiError(this.lastError, 500);
    }
  }
}
