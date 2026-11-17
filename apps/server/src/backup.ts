// Backups: the whole database as one .tar.gz file. One every night (and at start-up when the last
// one is older than a day), the newest 30 kept. A copy also goes to a second folder when one is set,
// for example a Google Drive or USB folder, so a dead hard disk does not take the records with it.
import type { PGlite } from '@electric-sql/pglite';
import fs from 'node:fs';
import path from 'node:path';

export interface BackupInfo { file: string; size: number; at: string }

export function listBackups(dir: string): BackupInfo[] {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((f) => /^medflow-.*\.tar\.gz$/.test(f)).map((f) => {
    const st = fs.statSync(path.join(dir, f));
    return { file: f, size: st.size, at: st.mtime.toISOString() };
  }).sort((a, b) => b.at.localeCompare(a.at));
}

const stamp = (d = new Date()) => {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
};

export async function backupNow(db: PGlite, dir: string, copyDir: string | null, keep = 30, log: (s: string) => void = () => {}): Promise<BackupInfo> {
  fs.mkdirSync(dir, { recursive: true });
  const blob = await db.dumpDataDir('gzip');
  const bytes = Buffer.from(await blob.arrayBuffer());
  const file = `medflow-${stamp()}.tar.gz`;
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
export async function restore(file: string, dataDir: string, log: (s: string) => void) {
  const { PGlite } = await import('@electric-sql/pglite');
  const { pg_trgm } = await import('@electric-sql/pglite/contrib/pg_trgm');
  if (!fs.existsSync(file)) throw new Error(`No such file: ${file}`);
  if (fs.existsSync(dataDir) && fs.readdirSync(dataDir).length) {
    const aside = `${dataDir}-before-restore-${stamp()}`;
    fs.renameSync(dataDir, aside);
    log(`The current data was moved to ${aside}`);
  }
  const blob = new Blob([fs.readFileSync(file)]);
  const db = await PGlite.create(dataDir, { loadDataDir: blob, extensions: { pg_trgm } });
  const n = (await db.query<{ n: number }>('select count(*)::int n from tenants')).rows[0]?.n ?? 0;
  await db.close();
  log(`Restored ${path.basename(file)} (${n} pharmacy).`);
}
