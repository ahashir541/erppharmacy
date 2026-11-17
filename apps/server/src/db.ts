// The pharmacy's database: PostgreSQL (PGlite) kept in a folder on this PC. On first start it runs
// every MedFlow migration; on an update it runs only the new ones. Its own bookkeeping (applied
// migrations, counter tokens) lives in the medflow_local schema, which staff calls cannot see.
import { PGlite, type Transaction } from '@electric-sql/pglite';
import { pg_trgm } from '@electric-sql/pglite/contrib/pg_trgm';
import fs from 'node:fs';
import path from 'node:path';

export type Tx = Transaction;
export type Claims = Record<string, unknown>;

export class ApiError extends Error {
  constructor(message: string, readonly status = 400, readonly code = '', readonly hint: string | null = null, readonly detail: string | null = null) {
    super(message);
  }
}

export async function openDatabase(dataDir: string, sqlDir: string, log: (s: string) => void): Promise<PGlite> {
  fs.mkdirSync(dataDir, { recursive: true });
  const db = await PGlite.create(dataDir, { extensions: { pg_trgm } });
  await db.exec(`
    create schema if not exists medflow_local;
    create table if not exists medflow_local.migrations (name text primary key, applied_at timestamptz not null default now());
    create table if not exists medflow_local.counter_tokens (
      token_hash text primary key, device_id uuid not null, created_at timestamptz not null default now(), last_used_at timestamptz);
    revoke all on schema medflow_local from public;`);
  const applied = new Set((await db.query<{ name: string }>('select name from medflow_local.migrations')).rows.map((r) => r.name));
  const fresh = applied.size === 0;
  const dir = path.join(sqlDir, 'migrations');
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();
  const todo = files.filter((f) => !applied.has(f));
  if (fresh) {
    log('Creating the database (first start)…');
    await db.exec(fs.readFileSync(path.join(sqlDir, 'stubs.sql'), 'utf8'));
  }
  for (const f of todo) {
    log(`  database update ${f}`);
    await db.transaction(async (tx) => {
      await tx.exec(fs.readFileSync(path.join(dir, f), 'utf8'));
      await tx.query('insert into medflow_local.migrations (name) values ($1)', [f]);
    });
  }
  if (fresh) await db.exec(fs.readFileSync(path.join(sqlDir, 'seed.sql'), 'utf8'));
  return db;
}

const isObject = (a: unknown) => a !== null && typeof a === 'object' && !(a instanceof Date);
const toParam = (a: unknown) => (isObject(a) ? JSON.stringify(a) : a);
const argList = (args: unknown[]) => args.map((a, i) => `$${i + 1}${isObject(a) ? '::jsonb' : ''}`).join(', ');

/** Runs fn as a signed-in principal (counter PC or owner): Row Level Security and grants apply. */
export async function asPrincipal<T>(db: PGlite, claims: Claims, fn: (tx: Tx) => Promise<T>): Promise<T> {
  try {
    return await db.transaction(async (tx) => {
      await tx.query(`select set_config('request.jwt.claims', $1, true)`, [JSON.stringify(claims)]);
      await tx.exec('set local role authenticated');
      return fn(tx);
    });
  } catch (err) {
    if (err instanceof ApiError) throw err;
    const e = err as { message?: string; code?: string; hint?: string; detail?: string };
    throw new ApiError(e.message ?? String(err), 400, e.code ?? '', e.hint ?? null, e.detail ?? null);
  }
}

/** select public.fn(args): one value (jsonb, uuid, text...) or, with rows, every row of a set-returning function. */
export async function callFunction(tx: Tx, fn: string, args: unknown[], rows: boolean): Promise<unknown> {
  if (!/^[a-z][a-z0-9_]{0,62}$/.test(fn)) throw new ApiError('Unknown function', 400);
  if (rows) return (await tx.query(`select * from public.${fn}(${argList(args)})`, args.map(toParam))).rows;
  const r = await tx.query<{ r: unknown }>(`select public.${fn}(${argList(args)}) r`, args.map(toParam));
  return r.rows[0]?.r ?? null;
}
