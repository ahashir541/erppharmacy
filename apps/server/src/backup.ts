// Backups: the whole database as one .tar.gz file. One every night (and at start-up when the last
// one is older than a day), the newest 30 kept. A copy also goes to a second folder when one is set,
// for example a Google Drive or USB folder, so a dead hard disk does not take the records with it.
// Nuskha Local encrypts its backups (AES-256-GCM) with a key kept beside the program, never in the
// backups folder, so a lost USB stick or a shared Drive folder does not expose the pharmacy. The
// key is shown to the owner (Settings) and kept by Nuskha HQ, so a backup can be opened on a new PC.
import type { PGlite } from '@electric-sql/pglite';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export interface BackupInfo { file: string; size: number; at: string }

const MAGIC = Buffer.from('MFENC1');

/** The pharmacy's backup key: created once in <home>/backup-key.txt. */
export function backupKey(home: string): Buffer {
  const file = path.join(home, 'backup-key.txt');
  if (fs.existsSync(file)) return parseKey(fs.readFileSync(file, 'utf8'));
  const key = randomBytes(32);
  fs.writeFileSync(file, `${keyText(key)}\r\n`, { mode: 0o600 });
  return key;
}
/** MFBK-XXXXXXXX-… : 64 hex digits in groups of 8 (only 0-9 and A-F, easy to read out and type). */
export const keyText = (k: Buffer) => `MFBK-${k.toString('hex').toUpperCase().match(/.{8}/g)!.join('-')}`;
export function parseKey(text: string): Buffer {
  const hex = text.trim().replace(/^MFBK-/i, '').replace(/[-\s]/g, '');
  const k = /^[0-9a-f]{64}$/i.test(hex) ? Buffer.from(hex, 'hex') : Buffer.alloc(0);
  if (k.length !== 32) throw new Error('That is not a Nuskha backup key (MFBK-…)');
  return k;
}
export function encrypt(plain: Buffer, key: Buffer): Buffer {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', key, iv);
  const body = Buffer.concat([c.update(plain), c.final()]);
  return Buffer.concat([MAGIC, iv, c.getAuthTag(), body]);
}
export function decrypt(data: Buffer, key: Buffer): Buffer {
  if (!data.subarray(0, 6).equals(MAGIC)) throw new Error('Not an encrypted Nuskha backup');
  const d = createDecipheriv('aes-256-gcm', key, data.subarray(6, 18));
  d.setAuthTag(data.subarray(18, 34));
  try { return Buffer.concat([d.update(data.subarray(34)), d.final()]); }
  catch { throw new Error('Wrong backup key, or the backup file is damaged'); }
}

export function listBackups(dir: string): BackupInfo[] {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((f) => /^medflow-.*\.tar\.gz(\.enc)?$/.test(f)).map((f) => {
    const st = fs.statSync(path.join(dir, f));
    return { file: f, size: st.size, at: st.mtime.toISOString() };
  }).sort((a, b) => b.at.localeCompare(a.at));
}

const stamp = (d = new Date()) => {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
};

export async function backupNow(db: PGlite, dir: string, copyDir: string | null, keep = 30, log: (s: string) => void = () => {}, key: Buffer | null = null): Promise<BackupInfo> {
  fs.mkdirSync(dir, { recursive: true });
  const blob = await db.dumpDataDir('gzip');
  const plain = Buffer.from(await blob.arrayBuffer());
  const bytes = key ? encrypt(plain, key) : plain;
  const file = `medflow-${stamp()}.tar.gz${key ? '.enc' : ''}`;
  const tmp = path.join(dir, `${file}.part`);
  fs.writeFileSync(tmp, bytes);
  fs.renameSync(tmp, path.join(dir, file));
  log(`Backup saved: ${file} (${(bytes.length / 1048576).toFixed(1)} MB)`);
  if (copyDir) {
    try {
      fs.mkdirSync(copyDir, { recursive: true });
      fs.copyFileSync(path.join(dir, file), path.join(copyDir, file));
      for (const old of listBackups(copyDir).slice(keep)) fs.rmSync(path.join(copyDir, old.file), { force: true });
    } catch (err) { log(`Could not copy the backup to ${copyDir}: ${(err as Error).message}`); }
  }
  for (const old of listBackups(dir).slice(keep)) fs.rmSync(path.join(dir, old.file), { force: true });
  return { file, size: bytes.length, at: new Date().toISOString() };
}

/** Backs up at start when the last backup is over a day old, then every night at the given hour. */
export function scheduleBackups(run: () => Promise<unknown>, dir: string, hour: number, log: (s: string) => void) {
  const last = listBackups(dir)[0];
  if (!last || Date.now() - Date.parse(last.at) > 24 * 3600_000) {
    setTimeout(() => { run().catch((e) => log(`Backup failed: ${(e as Error).message}`)); }, 30_000);
  }
  const next = () => {
    const now = new Date();
    const at = new Date(now);
    at.setHours(hour, 0, 0, 0);
    if (at <= now) at.setDate(at.getDate() + 1);
    setTimeout(async () => {
      await run().catch((e) => log(`Backup failed: ${(e as Error).message}`));
      next();
    }, at.getTime() - now.getTime());
  };
  next();
}

/** Replaces the data folder with a backup (the current folder is kept aside, never deleted). */
export async function restore(file: string, dataDir: string, log: (s: string) => void, key: Buffer | null = null) {
  const { PGlite } = await import('@electric-sql/pglite');
  const { pg_trgm } = await import('@electric-sql/pglite/contrib/pg_trgm');
  if (!fs.existsSync(file)) throw new Error(`No such file: ${file}`);
  let bytes: Buffer = fs.readFileSync(file);
  if (file.endsWith('.enc')) {
    if (!key) throw new Error('This backup is encrypted: give the backup key with --key MFBK-…');
    bytes = decrypt(bytes, key);  // checked before the current data is moved aside
  }
  if (fs.existsSync(dataDir) && fs.readdirSync(dataDir).length) {
    const aside = `${dataDir}-before-restore-${stamp()}`;
    fs.renameSync(dataDir, aside);
    log(`The current data was moved to ${aside}`);
  }
  const blob = new Blob([new Uint8Array(bytes)]);
  const db = await PGlite.create(dataDir, { loadDataDir: blob, extensions: { pg_trgm } });
  const n = (await db.query<{ n: number }>('select count(*)::int n from tenants')).rows[0]?.n ?? 0;
  await db.close();
  log(`Restored ${path.basename(file)} (${n} pharmacy).`);
}
