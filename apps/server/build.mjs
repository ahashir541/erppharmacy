// Builds the Nuskha Local folder to copy to a pharmacy PC: release/Nuskha
//   medflow-server.mjs   the server (one file)
//   public/              the Nuskha app, built for Nuskha Local
//   sql/                 the database migrations
//   node_modules/        the database engine (PGlite)
//   node/node.exe        Node itself, so the pharmacy PC needs nothing installed (skip: --no-node)
//   Install-Nuskha.ps1 and the other Windows scripts, README.txt
// Options: --server-only (skip building the app), --no-node, --zip,
//          --update (also make release/medflow-local-<version>.tar.gz to upload in Nuskha HQ → Updates)
// The version is apps/server/package.json "version": raise it before each release.
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../..');
const out = path.join(here, 'release', 'Nuskha');
const flag = (f) => process.argv.includes(f);
const step = (s) => console.log(`• ${s}`);
const VERSION = JSON.parse(fs.readFileSync(path.join(here, 'package.json'), 'utf8')).version;
const TAR = process.platform === 'win32' ? path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe') : 'tar';

fs.mkdirSync(out, { recursive: true });

// Nuskha HQ's address and public key, built into the pharmacy's server (hq.json, written by
// build-hq.mjs). Without it Nuskha Local runs unlicensed (licensing off).
const hqFile = path.join(here, 'hq.json');
const hq = fs.existsSync(hqFile) ? JSON.parse(fs.readFileSync(hqFile, 'utf8')) : null;
if (hq?.url && hq?.public_key) step(`Licensing on: Nuskha HQ at ${hq.url}`);
else console.warn('! No hq.json: this Nuskha Local has licensing OFF (anyone can use it). Run build-hq.mjs first for a licensed build.');

step(`Server ${VERSION}`);
await build({
  define: { __MEDFLOW_VERSION__: JSON.stringify(VERSION), __MEDFLOW_HQ__: hq?.url && hq?.public_key ? JSON.stringify({ url: hq.url, public_key: hq.public_key }) : 'undefined' },
  entryPoints: [path.join(here, 'src/main.ts')],
  outfile: path.join(out, 'medflow-server.mjs'),
  bundle: true, platform: 'node', format: 'esm', target: 'node20',
  external: ['@electric-sql/pglite', '@electric-sql/pglite/*'],
  banner: { js: '// Nuskha Local server. Built file; the source is apps/server/src.' },
  logLevel: 'warning',
});

step('Database files');
const sqlOut = path.join(out, 'sql');
fs.rmSync(sqlOut, { recursive: true, force: true });
fs.mkdirSync(path.join(sqlOut, 'migrations'), { recursive: true });
const dbDir = path.join(root, 'packages/db/supabase');
for (const f of fs.readdirSync(path.join(dbDir, 'migrations')).filter((f) => f.endsWith('.sql'))) {
  fs.copyFileSync(path.join(dbDir, 'migrations', f), path.join(sqlOut, 'migrations', f));
}
fs.copyFileSync(path.join(dbDir, 'test-support/local-supabase-stubs.sql'), path.join(sqlOut, 'stubs.sql'));
fs.copyFileSync(path.join(dbDir, 'seed.sql'), path.join(sqlOut, 'seed.sql'));

step('Database engine (PGlite)');
const pglite = fs.realpathSync(path.join(here, 'node_modules/@electric-sql/pglite'));
const pgOut = path.join(out, 'node_modules/@electric-sql/pglite');
fs.rmSync(pgOut, { recursive: true, force: true });
fs.cpSync(pglite, pgOut, { recursive: true, dereference: true });

if (!flag('--server-only')) {
  step('Nuskha app (for Nuskha Local)');
  const pos = path.join(root, 'apps/pos');
  const env = { ...process.env, VITE_MEDFLOW_SERVER: '1', VITE_SUPABASE_URL: '', VITE_SUPABASE_ANON_KEY: '' };
  execSync('node scripts/gen-signatures.mjs', { cwd: pos, stdio: 'inherit', env });
  execSync(`npx vite build --outDir "${path.join(out, 'public')}" --emptyOutDir`, { cwd: pos, stdio: 'inherit', env });
}

if (!flag('--no-node')) {
  step(`Node ${process.version}`);
  fs.mkdirSync(path.join(out, 'node'), { recursive: true });
  fs.copyFileSync(process.execPath, path.join(out, 'node', path.basename(process.execPath)));
}

step('Windows scripts');
for (const f of fs.readdirSync(path.join(here, 'windows'))) fs.copyFileSync(path.join(here, 'windows', f), path.join(out, f));
fs.writeFileSync(path.join(out, 'VERSION.txt'), `Nuskha Local ${VERSION}\nbuilt ${new Date().toISOString()}\nnode ${process.version}\n`);
fs.writeFileSync(path.join(out, 'version.json'), `${JSON.stringify({ app: 'local', version: VERSION, built_at: new Date().toISOString() })}\n`);

// Never ship a test run's data, backups or logs.
// Never ship anything a running Nuskha made: a pharmacy's data, backups, its backup key, updates.
const RUNTIME = ['data', 'backups', 'logs', 'config.json', 'backup-key.txt', 'updates'];
for (const d of RUNTIME) fs.rmSync(path.join(out, d), { recursive: true, force: true });
for (const d of fs.readdirSync(out)) if (/^data-/.test(d)) fs.rmSync(path.join(out, d), { recursive: true, force: true });

if (flag('--update')) {
  // Everything except Node itself (pharmacies keep theirs) and the scripts that are running.
  step('Update package');
  const pkg = path.join(here, 'release', `medflow-local-${VERSION}.tar.gz`);
  fs.rmSync(pkg, { force: true });
  const items = fs.readdirSync(out).filter((n) => !['node', 'MedFlow-Server.cmd', 'start-hidden.vbs', 'MedFlow.vbs'].includes(n));
  execSync(`"${TAR}" -czf "${pkg}" -C "${out}" ${items.map((n) => `"${n}"`).join(' ')}`, { stdio: 'inherit' });
  console.log(`Update package: ${pkg} (${(fs.statSync(pkg).size / 1048576).toFixed(1)} MB) — upload it in Nuskha HQ → Updates`);
}

const leftovers = fs.readdirSync(out).filter((d) => RUNTIME.includes(d) || /^data-/.test(d));
if (leftovers.length) throw new Error(`Refusing to package runtime files: ${leftovers.join(', ')}`);

if (flag('--zip') && process.platform === 'win32') {
  step('Zip');
  const zip = path.join(here, 'release', 'Nuskha.zip');
  fs.rmSync(zip, { force: true });
  execSync(`powershell -NoProfile -Command "Compress-Archive -Path '${out}' -DestinationPath '${zip}'"`, { stdio: 'inherit' });
  console.log(`Done: ${zip}`);
} else {
  console.log(`Done: ${out}`);
}
