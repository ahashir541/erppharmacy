// Builds MedFlow HQ (your own server and console; never give it to a pharmacy): release/MedFlowHQ
//   medflow-hq.mjs, hq-public/ (the console), sql/, node_modules/ (PGlite), node/, HQ-Server.cmd
// Options: --url <https://your-hq-address>  the address pharmacies reach HQ at (written to hq.json)
//          --keys <folder>                 where HQ keeps its signing key (default release/MedFlowHQ/hq-keys)
//          --no-node
// After the first start of HQ, its public key is in <keys>/public-key.txt; this script copies it
// into hq.json so the next MedFlow Local build trusts this HQ.
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../..');
const out = path.join(here, 'release', 'MedFlowHQ');
const arg = (n) => { const i = process.argv.indexOf(`--${n}`); return i > 0 ? process.argv[i + 1] : null; };
const step = (s) => console.log(`• ${s}`);
fs.mkdirSync(out, { recursive: true });

step('HQ server');
await build({
  entryPoints: [path.join(here, 'src/hq.ts')], outfile: path.join(out, 'medflow-hq.mjs'),
  bundle: true, platform: 'node', format: 'esm', target: 'node20',
  external: ['@electric-sql/pglite', '@electric-sql/pglite/*'],
  banner: { js: '// MedFlow HQ server. Built file; the source is apps/server/src/hq.ts.' }, logLevel: 'warning',
});

step('Database files');
const sqlOut = path.join(out, 'sql');
fs.rmSync(sqlOut, { recursive: true, force: true });
fs.mkdirSync(path.join(sqlOut, 'migrations'), { recursive: true });
const dbDir = path.join(root, 'packages/db/supabase');
for (const f of fs.readdirSync(path.join(dbDir, 'migrations')).filter((f) => f.endsWith('.sql'))) fs.copyFileSync(path.join(dbDir, 'migrations', f), path.join(sqlOut, 'migrations', f));
fs.copyFileSync(path.join(dbDir, 'test-support/local-supabase-stubs.sql'), path.join(sqlOut, 'stubs.sql'));
fs.copyFileSync(path.join(dbDir, 'seed.sql'), path.join(sqlOut, 'seed.sql'));

step('Database engine (PGlite)');
const pgOut = path.join(out, 'node_modules/@electric-sql/pglite');
fs.rmSync(pgOut, { recursive: true, force: true });
fs.cpSync(fs.realpathSync(path.join(here, 'node_modules/@electric-sql/pglite')), pgOut, { recursive: true, dereference: true });

step('HQ console');
execSync(`npx vite build --outDir "${path.join(out, 'hq-public')}" --emptyOutDir`, { cwd: path.join(root, 'apps/hq'), stdio: 'inherit' });

if (!process.argv.includes('--no-node')) {
  step(`Node ${process.version}`);
  fs.mkdirSync(path.join(out, 'node'), { recursive: true });
  fs.copyFileSync(process.execPath, path.join(out, 'node', path.basename(process.execPath)));
}
fs.writeFileSync(path.join(out, 'HQ-Server.cmd'), '@echo off\r\nrem MedFlow HQ: double-click to run (restarts itself if it stops).\r\ncd /d "%~dp0"\r\nset NODE=node\r\nif exist "%~dp0node\node.exe" set NODE="%~dp0node\node.exe"\r\n:loop\r\n%NODE% medflow-hq.mjs\r\nif %errorlevel%==3 exit /b 3\r\ntimeout /t 5 /nobreak >nul\r\ngoto loop\r\n');

// Tie MedFlow Local builds to this HQ.
const keys = arg('keys') ? path.resolve(arg('keys')) : path.join(out, 'hq-keys');
const pubFile = path.join(keys, 'public-key.txt');
const hqFile = path.join(here, 'hq.json');
const prev = fs.existsSync(hqFile) ? JSON.parse(fs.readFileSync(hqFile, 'utf8')) : {};
const url = arg('url') ?? prev.url ?? 'http://localhost:5299';
const public_key = fs.existsSync(pubFile) ? fs.readFileSync(pubFile, 'utf8').trim() : prev.public_key ?? '';
fs.writeFileSync(hqFile, `${JSON.stringify({ url, public_key }, null, 2)}\n`);
console.log(public_key ? `Done: ${out}\nhq.json: ${url} (key ${public_key.slice(0, 8)}…)` :
  `Done: ${out}\nStart HQ once (HQ-Server.cmd), then run this again so hq.json gets HQ's public key.`);
