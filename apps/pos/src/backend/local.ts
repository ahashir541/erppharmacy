// The POS running against MedFlow's real database inside the browser (PGlite): the same migrations
// and server functions as the cloud, a Demo Pharmacy, and this browser acting as Counter 1. Kept
// in the browser's storage, so it survives a reload. Used for trying MedFlow before a cloud
// project exists, for training, and for demos.
import { PGlite, type Transaction } from '@electric-sql/pglite';
import { pg_trgm } from '@electric-sql/pglite/contrib/pg_trgm';
import { DEMO, demoSeedSql } from '../demo/seed.ts';
import {
  PosError, type Batch, type CustomerHit, type HeldBill, type PosBackend, type PosContext, type Product, type Receipt, type SaleResult,
} from './types.ts';
import stubs from '../../../../packages/db/supabase/test-support/local-supabase-stubs.sql?raw';
import platformSeed from '../../../../packages/db/supabase/seed.sql?raw';

const MIGRATIONS = import.meta.glob('../../../../packages/db/supabase/migrations/*.sql', { query: '?raw', import: 'default', eager: true }) as Record<string, string>;

/** Changes whenever a migration changes, so an old demo database is rebuilt. */
function schemaVersion(): string {
  let h = 0;
  for (const [name, sql] of Object.entries(MIGRATIONS).sort()) {
    for (const ch of name + sql) h = (Math.imul(h, 31) + ch.charCodeAt(0)) | 0;
  }
  return (h >>> 0).toString(36);
}

export async function openLocalBackend(onProgress: (text: string) => void = () => {}): Promise<LocalBackend> {
  const name = `idb://medflow-pos-demo-v2-${schemaVersion()}`;
  const db = new PGlite(name, { extensions: { pg_trgm } });
  await db.waitReady;
  const ready = await db.query<{ ok: boolean }>(`select to_regclass('public.tenants') is not null
    and exists (select 1 from information_schema.tables where table_name = 'tenants') as ok`);
  let seeded = false;
  if (ready.rows[0]?.ok) {
    seeded = (await db.query<{ n: number }>(`select count(*)::int n from tenants where id = $1`, [DEMO.tenant])).rows[0]!.n > 0;
  }
  if (!seeded) {
    onProgress('Setting up the database…');
    await db.exec(stubs);
    const files = Object.keys(MIGRATIONS).sort();
    for (const [i, file] of files.entries()) {
      onProgress(`Setting up the database (${i + 1} of ${files.length})…`);
      await db.exec(MIGRATIONS[file]!);
    }
    await db.exec(platformSeed);
    onProgress('Stocking Demo Pharmacy…');
    await db.exec(await demoSeedSql());
  }
  return new LocalBackend(db);
}

type Tx = Transaction;
const toParam = (a: unknown) => (a !== null && typeof a === 'object' && !(a instanceof Date) ? JSON.stringify(a) : a);
const argList = (args: unknown[]) => args.map((a, i) => `$${i + 1}${a !== null && typeof a === 'object' && !(a instanceof Date) ? '::jsonb' : ''}`).join(', ');

export class LocalBackend implements PosBackend {
  private readonly db: PGlite;
  constructor(db: PGlite) {
    this.db = db;
  }

  /** Runs as this counter PC signed in to MedFlow (the device principal), as on a real counter. */
  private async asCounter<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
    try {
      return await this.db.transaction(async (tx) => {
        await tx.query(`select set_config('request.jwt.claims', $1, true)`,
          [JSON.stringify({ sub: DEMO.deviceAuth, role: 'authenticated', aal: 'aal1' })]);
        await tx.exec('set local role authenticated');
        return fn(tx);
      });
    } catch (err) {
      const e = err as { message?: string; code?: string; hint?: string; detail?: string };
      throw new PosError(e.message ?? String(err), e.code ?? '', e.hint ?? null, e.detail ?? null);
    }
  }

  /** Runs as the owner signed in with 2FA (the back office). */
  private async asOwner<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
    try {
      return await this.db.transaction(async (tx) => {
        await tx.query(`select set_config('request.jwt.claims', $1, true)`,
          [JSON.stringify({ sub: DEMO.ownerAuth, role: 'authenticated', aal: 'aal2', tenant_id: DEMO.tenant })]);
        await tx.exec('set local role authenticated');
        return fn(tx);
      });
    } catch (err) {
      const e = err as { message?: string; code?: string; hint?: string; detail?: string };
      throw new PosError(e.message ?? String(err), e.code ?? '', e.hint ?? null, e.detail ?? null);
    }
  }

  /** Back office: rows of a query, as the owner (Row Level Security applies). */
  ownerRows<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> {
    return this.asOwner(async (tx) => (await tx.query<T>(sql, params.map(toParam))).rows);
  }

  /** Back office: one MedFlow function returning a value, as the owner. */
  ownerCall<T = unknown>(fn: string, ...args: unknown[]): Promise<T> {
    if (!/^[a-z_]+$/.test(fn)) throw new Error('bad function name');
    return this.asOwner(async (tx) => (await tx.query<{ r: T }>(`select public.${fn}(${argList(args)}) r`, args.map(toParam))).rows[0]!.r);
  }

  office<T = unknown>(name: string, ...args: unknown[]): Promise<T> {
    return this.ownerCall<T>(`office_${name}`, ...args);
  }

  /** Back office: a MedFlow function returning rows, as the owner. */
  ownerTable<T = Record<string, unknown>>(fn: string, ...args: unknown[]): Promise<T[]> {
    if (!/^[a-z_]+$/.test(fn)) throw new Error('bad function name');
    return this.asOwner(async (tx) => (await tx.query<T>(`select * from public.${fn}(${argList(args)})`, args.map(toParam))).rows);
  }

  private async one<T>(sql: string, params: unknown[] = []): Promise<T> {
    return this.asCounter(async (tx) => (await tx.query<{ r: T }>(sql, params)).rows[0]!.r);
  }

  context() { return this.one<PosContext>('select public.pos_context() r'); }
  search(query: string) { return this.one<Product[]>('select public.pos_search($1, 25) r', [query]); }
  batches(productId: string) { return this.one<Batch[]>('select public.pos_batches($1) r', [productId]); }
  customers(query: string) { return this.one<CustomerHit[]>('select public.pos_customers($1, 10) r', [query]); }

  async startSession(userId: string, sessionId: string) {
    await this.one('select public.start_staff_session($1, $2)::text r', [userId, sessionId]);
  }
  async pinFailure(userId: string) {
    await this.one('select public.record_pin_failure($1)::text r', [userId]);
  }
  async endSession(sessionId: string, reason: 'logout' | 'idle_lock') {
    await this.one('select public.end_staff_session($1, $2)::text r', [sessionId, reason]);
  }
  openShift(drawerId: string, openingFloat: number, sessionId: string) {
    return this.one<string>('select public.open_drawer($1, $2, $3) r', [drawerId, openingFloat, sessionId]);
  }
  async closeShift(drawerSessionId: string, counted: number, sessionId: string) {
    await this.one('select public.close_drawer($1, $2, null, $3)::text r', [drawerSessionId, counted, sessionId]);
  }
  postSale(sale: Record<string, unknown>, sessionId: string) {
    return this.one<SaleResult>('select public.post_sale($1::jsonb, $2) r', [JSON.stringify(sale), sessionId]);
  }
  receipt(saleId: string) { return this.one<Receipt>('select public.get_receipt($1) r', [saleId]); }
  requestApproval(request: Record<string, unknown>, sessionId: string) {
    return this.one<string>('select public.request_approval($1::jsonb, $2) r', [JSON.stringify(request), sessionId]);
  }
  approvalStatus(requestId: string) {
    return this.one<string>('select status r from approval_requests where id = $1', [requestId]);
  }
  async approveAtCounter(requestId: string, approverId: string, sessionId: string) {
    await this.one('select public.approve_at_counter($1, $2, $3)::text r', [requestId, approverId, sessionId]);
  }

  /** Held bills go through the counter's outbox, as they would offline. */
  private async command(kind: string, payload: Record<string, unknown>, sessionId: string, staffId: string | null) {
    await this.asCounter(async (tx) => {
      const seq = (await tx.query<{ n: number }>(`select coalesce(max(device_seq), 0)::int + 1 n from device_commands where device_id = $1`,
        [DEMO.device])).rows[0]!.n;
      const r = (await tx.query<{ r: Array<{ status: string; result?: { error?: string } }> }>('select public.apply_device_commands($1::jsonb) r',
        [JSON.stringify([{ id: crypto.randomUUID(), device_seq: seq, kind, acting_user: staffId, session_id: sessionId,
                           created_on_device_at: new Date().toISOString(), payload }])])).rows[0]!.r;
      if (r[0]?.status === 'rejected') throw new PosError(r[0].result?.error ?? 'Could not save');
    });
  }
  private staffOf(sessionId: string) {
    return this.one<string | null>('select user_id r from user_sessions where id = $1', [sessionId]);
  }
  async holdBill(id: string, label: string, cart: unknown, sessionId: string) {
    await this.command('held_bill', { id, label, cart }, sessionId, await this.staffOf(sessionId));
  }
  heldBills() { return this.one<HeldBill[]>('select public.pos_held_bills() r'); }
  async resumeBill(bill: HeldBill, sessionId: string) {
    await this.command('held_bill', { id: bill.id, label: bill.label, cart: bill.cart, resumed_at: new Date().toISOString() },
      sessionId, await this.staffOf(sessionId));
  }
}
