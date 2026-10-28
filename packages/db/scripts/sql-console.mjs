// Developer helper: load the schema and test fixtures into PGlite, run one
// SQL file, and print every result. Usage: node scripts/sql-console.mjs file.sql
import { PGlite } from '@electric-sql/pglite';
import { pg_trgm } from '@electric-sql/pglite/contrib/pg_trgm';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const supabaseDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'supabase');
const read = (...parts) => readFileSync(join(supabaseDir, ...parts), 'utf8');

const db = new PGlite({ extensions: { pg_trgm } });
await db.exec(read('test-support', 'local-supabase-stubs.sql'));
for (const f of readdirSync(join(supabaseDir, 'migrations')).filter((f) => f.endsWith('.sql')).sort()) {
  await db.exec(read('migrations', f));
}
await db.exec(read('test-support', 'pgtap-shim.sql'));
await db.exec(read('test-support', 'fixtures.sql'));
for (const r of await db.exec(readFileSync(process.argv[2], 'utf8'))) {
  if (r.rows.length) console.log(JSON.stringify(r.rows, null, 1));
}
