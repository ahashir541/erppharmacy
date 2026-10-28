import { PGlite } from '@electric-sql/pglite';
import { pg_trgm } from '@electric-sql/pglite/contrib/pg_trgm';
import fs from 'node:fs';
import path from 'node:path';

const dir = process.argv[2];
const db = new PGlite({ extensions: { pg_trgm } });
// Minimal Supabase stand-ins.
await db.exec(`
  create role anon; create role authenticated; create role service_role;
  create schema auth;
  create table auth.users (id uuid primary key);
  create function auth.jwt() returns jsonb language sql stable as
    $$ select coalesce(nullif(current_setting('request.jwt.claims', true), ''), '{}')::jsonb $$;
  create function auth.uid() returns uuid language sql stable as
    $$ select nullif(auth.jwt() ->> 'sub', '')::uuid $$;
`);
for (const f of fs.readdirSync(dir).filter(f => f.endsWith('.sql')).sort()) {
  try { await db.exec(fs.readFileSync(path.join(dir, f), 'utf8')); console.log('ok  ', f); }
  catch (e) { console.log('FAIL', f, '-', e.message); process.exit(1); }
}
const r = await db.query(`select count(*)::int n from pg_tables where schemaname='public'`);
console.log('public tables:', r.rows[0].n);
if (process.argv[3]) {
  try { await db.exec(fs.readFileSync(process.argv[3], 'utf8')); console.log('scenario ok'); }
  catch (e) { console.log('SCENARIO FAIL -', e.message); process.exit(1); }
}
