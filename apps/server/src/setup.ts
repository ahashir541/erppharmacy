// First start: create the pharmacy (or the Demo Pharmacy), and link counter PCs. A counter gets a
// long random token once; the server keeps only its hash. Linking a PC needs the owner's PIN.
import type { PGlite } from '@electric-sql/pglite';
import { checkPin, hashPin, verifyPin } from '@medflow/core';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { DEMO, demoSeedSql } from '../../pos/src/demo/seed.ts';
import { ApiError, asPrincipal, callFunction } from './db.ts';

export interface Pharmacy { tenant_id: string; name: string; owner_auth: string; branch_id: string; branch_code: string }

export const hashToken = (t: string) => createHash('sha256').update(t).digest('hex');

export async function pharmacy(db: PGlite): Promise<Pharmacy | null> {
  const r = await db.query<Pharmacy>(`
    select t.id tenant_id, t.name, u.auth_user_id owner_auth, b.id branch_id, b.code branch_code
    from tenants t join users u on u.tenant_id = t.id and u.is_primary_owner
    join lateral (select id, code from branches where tenant_id = t.id and archived_at is null order by created_at limit 1) b on true
    order by t.created_at limit 1`);
  return r.rows[0] ?? null;
}

async function issueToken(db: PGlite, deviceId: string): Promise<string> {
  const token = randomBytes(32).toString('base64url');
  await db.query('insert into medflow_local.counter_tokens (token_hash, device_id) values ($1, $2)', [hashToken(token), deviceId]);
  return token;
}

export interface NewPharmacy {
  pharmacy: string; owner_name: string; owner_phone?: string; city?: string; branch_name: string; branch_code: string;
  address?: string; phone?: string; pin: string; counter_name?: string; footer?: string;
}

export async function setupPharmacy(db: PGlite, f: NewPharmacy): Promise<{ token: string }> {
  if (await pharmacy(db)) throw new ApiError('Nuskha is already set up on this PC', 409);
  const need = (v: string | undefined, what: string) => { if (!v || !v.trim()) throw new ApiError(`${what} is required`); return v.trim(); };
  const name = need(f.pharmacy, 'Pharmacy name');
  const owner = need(f.owner_name, 'Owner name');
  const branch = need(f.branch_name, 'Branch name');
  const code = need(f.branch_code, 'Bill prefix').toUpperCase();
  if (!/^[A-Z0-9]{2,8}$/.test(code)) throw new ApiError('Bill prefix must be 2-8 capital letters or digits, e.g. KHI1');
  const pin = checkPin(f.pin ?? '');
  if (!pin.ok) throw new ApiError(pin.problem === 'format' ? 'PIN must be 4 to 6 digits' : 'PIN is too easy (no 1234 or 1111)');
  const pinHash = await hashPin(f.pin);
  const ownerAuth = randomUUID();
  const deviceAuth = randomUUID();
  let deviceId = '';
  await db.transaction(async (tx) => {
    await tx.query(`insert into auth.users (id, email) values ($1, 'owner@medflow.local'), ($2, 'counter-c1@medflow.local')`, [ownerAuth, deviceAuth]);
    // Local and free: the pharmacy is simply active, no trial and no subscription.
    const tid = (await tx.query<{ id: string }>(`
      insert into tenants (name, owner_name, owner_phone, owner_email, city, status, plan_id, trial_ends_at)
      select $1, $2, $3, 'owner@medflow.local', $4, 'active', id, null from plans where code = 'pro' returning id`,
      [name, owner, f.owner_phone?.trim() ?? '', f.city?.trim() ?? ''])).rows[0]!.id;
    const uid = (await tx.query<{ id: string }>(`
      insert into users (tenant_id, auth_user_id, kind, is_primary_owner, full_name, phone, status)
      values ($1, $2, 'owner', true, $3, $4, 'active') returning id`, [tid, ownerAuth, owner, f.owner_phone?.trim() || null])).rows[0]!.id;
    const bid = (await tx.query<{ id: string }>(`
      insert into branches (tenant_id, code, name, address, city, phone, created_by) values ($1, $2, $3, $4, $5, $6, $7) returning id`,
      [tid, code, branch, f.address?.trim() ?? '', f.city?.trim() ?? '', f.phone?.trim() || null, uid])).rows[0]!.id;
    await tx.query('select app.seed_tenant_defaults($1, $2)', [tid, uid]);
    await tx.query('select app.ensure_expense_categories($1)', [tid]);
    await tx.query('insert into user_pins (user_id, tenant_id, pin_hash) values ($1, $2, $3)', [uid, tid, pinHash]);
    if (f.footer?.trim()) {
      await tx.query(`insert into settings (tenant_id, key, value, created_by) values ($1, 'pos.receipt_footer', $2::jsonb, $3)`, [tid, JSON.stringify(f.footer.trim()), uid]);
    }
    deviceId = (await tx.query<{ id: string }>(`
      insert into devices (tenant_id, branch_id, auth_user_id, code, invoice_prefix, name, kind, platform, created_by)
      values ($1, $2, $3, 'C1', $4, $5, 'counter', 'browser', $6) returning id`,
      [tid, bid, deviceAuth, `${code}-C1`, f.counter_name?.trim() || 'Counter 1', uid])).rows[0]!.id;
  });
  return { token: await issueToken(db, deviceId) };
}

export async function setupDemo(db: PGlite): Promise<{ token: string }> {
  if (await pharmacy(db)) throw new ApiError('Nuskha is already set up on this PC', 409);
  await db.exec(await demoSeedSql());
  // The demo's trial would end in 14 days; locally it stays active.
  await db.query(`update tenants set status = 'active', trial_ends_at = null where id = $1`, [DEMO.tenant]);
  return { token: await issueToken(db, DEMO.device) };
}

// Wrong owner PINs while linking: 5 tries, then a 5-minute wait (per network address).
const failures = new Map<string, { n: number; until: number }>();

export async function linkCounter(db: PGlite, from: string, pin: string, name: string): Promise<{ token: string; invoice_prefix: string }> {
  const ph = await pharmacy(db);
  if (!ph) throw new ApiError('Nuskha is not set up yet', 409);
  const f = failures.get(from);
  if (f && f.until > Date.now()) throw new ApiError(`Too many wrong PINs. Try again in ${Math.ceil((f.until - Date.now()) / 60000)} minutes.`, 429);
  const hash = (await db.query<{ pin_hash: string }>(`
    select p.pin_hash from users u join user_pins p on p.user_id = u.id where u.tenant_id = $1 and u.is_primary_owner`, [ph.tenant_id])).rows[0]?.pin_hash;
  if (!hash || !(await verifyPin(pin, hash))) {
    const n = (f?.n ?? 0) + 1;
    failures.set(from, { n: n >= 5 ? 0 : n, until: n >= 5 ? Date.now() + 5 * 60_000 : 0 });
    throw new ApiError("That is not the owner's PIN", 403);
  }
  failures.delete(from);
  const label = name.trim() || 'Counter';
  const used = new Set((await db.query<{ code: string }>('select code from devices where tenant_id = $1', [ph.tenant_id])).rows.map((r) => r.code));
  let n = 1;
  while (used.has(`C${n}`)) n++;
  const owner = { sub: ph.owner_auth, role: 'authenticated', aal: 'aal2', tenant_id: ph.tenant_id };
  const reg = await asPrincipal(db, owner, (tx) => callFunction(tx, 'register_device', [ph.branch_id, `C${n}`, label, 'counter'], false)) as
    { device_id: string; invoice_prefix: string };
  const deviceAuth = randomUUID();
  await db.query(`insert into auth.users (id, email) values ($1, $2)`, [deviceAuth, `counter-${reg.device_id}@medflow.local`]);
  await db.query('select public.platform_attach_device_auth($1, $2)', [reg.device_id, deviceAuth]);
  await db.query(`update devices set platform = 'browser' where id = $1`, [reg.device_id]);
  return { token: await issueToken(db, reg.device_id), invoice_prefix: reg.invoice_prefix };
}

export interface Counter { device_id: string; auth_user_id: string; tenant_id: string; status: string }

export async function counterFor(db: PGlite, token: string | undefined): Promise<Counter> {
  if (!token) throw new ApiError('This PC is not linked to Nuskha', 401);
  const r = await db.query<Counter>(`
    update medflow_local.counter_tokens t set last_used_at = now() from devices d
    where t.token_hash = $1 and d.id = t.device_id
    returning d.id device_id, d.auth_user_id, d.tenant_id, d.status`, [hashToken(token)]);
  const c = r.rows[0];
  if (!c) throw new ApiError('This PC is not linked to Nuskha', 401);
  if (c.status !== 'active') throw new ApiError('This PC was disabled by the owner', 401);
  return c;
}

/** The owner's claims, only while the owner is signed in (PIN) on this counter. */
export async function ownerClaims(db: PGlite, c: Counter, sessionId: string | undefined) {
  if (!sessionId) throw new ApiError('Sign in as the owner on this counter', 403);
  const r = await db.query<{ auth_user_id: string; tenant_id: string }>(`
    select u.auth_user_id, u.tenant_id from user_sessions s join users u on u.id = s.user_id
    where s.id = $1 and s.device_id = $2 and s.ended_at is null and u.kind = 'owner' and u.status = 'active'`, [sessionId, c.device_id]);
  const o = r.rows[0];
  if (!o) throw new ApiError('Sign in as the owner on this counter', 403);
  return { sub: o.auth_user_id, role: 'authenticated', aal: 'aal2', tenant_id: o.tenant_id };
}
