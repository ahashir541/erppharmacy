// Builds the MedFlow Local folder to copy to a pharmacy PC: release/MedFlow
//   medflow-server.mjs   the server (one file)
//   public/              the MedFlow app, built for MedFlow Local
//   sql/                 the database migrations
//   node_modules/        the database engine (PGlite)
//   node/node.exe        Node itself, so the pharmacy PC needs nothing installed (skip: --no-node)
//   Install-MedFlow.ps1 and the other Windows scripts, README.txt
// Options: --server-only (skip building the app), --no-node, --zip
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../..');
const out = path.join(here, 'release', 'MedFlow');
const flag = (f) => process.argv.includes(f);
const step = (s) => console.log(`• ${s}`);

fs.mkdirSync(out, { recursive: true });

// MedFlow HQ's address and public key, built into the pharmacy's server (hq.json, written by
// build-hq.mjs). Without it MedFlow Local runs unlicensed (licensing off).
const hqFile = path.join(here, 'hq.json');
const hq = fs.existsSync(hqFile) ? JSON.parse(fs.readFileSync(hqFile, 'utf8')) : null;
if (hq?.url && hq?.public_key) step(`Licensing on: MedFlow HQ at ${hq.url}`);
else console.warn('! No hq.json: this MedFlow Local has licensing OFF (anyone can use it). Run build-hq.mjs first for a licensed build.');

step('Server');
await build({
  define: { __MEDFLOW_HQ__: hq?.url && hq?.public_key ? JSON.stringify({ url: hq.url, public_key: hq.public_key }) : 'undefined' },
  entryPoints: [path.join(here, 'src/main.ts')],
  outfile: path.join(out, 'medflow-server.mjs'),
  bundle: true, platform: 'node', format: 'esm', target: 'node20',
  external: ['@electric-sql/pglite', '@electric-sql/pglite/*'],
  banner: { js: '// MedFlow Local server. Built file; the source is apps/server/src.' },
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
  step('MedFlow app (for MedFlow Local)');
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
fs.writeFileSync(path.join(out, 'VERSION.txt'), `MedFlow Local\nbuilt ${new Date().toISOString()}\nnode ${process.version}\n`);

// Never ship a test run's data, backups or logs.
for (const d of ['data', 'backups', 'logs', 'config.json']) fs.rmSync(path.join(out, d), { recursive: true, force: true });

if (flag('--zip') && process.platform === 'win32') {
  step('Zip');
  const zip = path.join(here, 'release', 'MedFlow-Local.zip');
  fs.rmSync(zip, { force: true });
  execSync(`powershell -NoProfile -Command "Compress-Archive -Path '${out}' -DestinationPath '${zip}'"`, { stdio: 'inherit' });
  console.log(`Done: ${zip}`);
} else {
  console.log(`Done: ${out}`);
}
