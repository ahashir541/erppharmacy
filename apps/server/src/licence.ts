// The pharmacy's licence from Nuskha HQ. With the licence key, this server checks in with HQ (at
// start, every 6 hours, on "Check now") and gets a licence signed by HQ: status, plan, features and
// limits, announcements, invoices. It checks the signature with HQ's public key (built into Nuskha
// Local), then makes the local database follow it: the same database rules that stop a read-only
// pharmacy from selling on the cloud stop it here. Offline it keeps working until valid_until.
// No key yet: 7 days to enter one, then read-only. The Demo Pharmacy needs no key.
import type { PGlite } from '@electric-sql/pglite';
import { importPublicKey, verifyClaims, type PharmacyLicence } from '@medflow/core';
import { randomUUID } from 'node:crypto';
import os from 'node:os';
import { DEMO } from '../../pos/src/demo/seed.ts';
import { ApiError } from './db.ts';
import { pharmacy } from './setup.ts';

declare const __MEDFLOW_HQ__: { url: string; public_key: string } | undefined;
const BUILT_IN = typeof __MEDFLOW_HQ__ === 'undefined' ? { url: '', public_key: '' } : __MEDFLOW_HQ__;
const NO_KEY_DAYS = 7;

export interface LicenceStatus {
  state: 'off' | 'demo' | 'none' | 'ok' | 'offline' | 'expired' | 'stopped';
  message: string;
  status: string | null;
  plan_name: string | null;
  may_sell: boolean;
  valid_until: string | null;
  trial_ends_at: string | null;
  grace_ends_at: string | null;
  read_only_from: string | null;
  key_hint: string | null;
  last_checkin_at: string | null;
  last_error: string | null;
  no_key_until: string | null;
  announcements: PharmacyLicence['announcements'];
  invoices: PharmacyLicence['invoices'];
  payment_instructions: string | null;
}

export class Licence {
  private publicKey: CryptoKey | null = null;
  private claims: PharmacyLicence | null = null;
  private lastError: string | null = null;
  private lastCheckin: string | null = null;
  readonly hqUrl: string;

  constructor(private readonly db: PGlite, hqUrl: string | null, private readonly version: string, private readonly log: (s: string) => void) {
    this.hqUrl = (hqUrl || BUILT_IN.url).replace(/\/+$/, '');
  }

  get enabled() { return !!BUILT_IN.public_key && !!this.hqUrl; }
  /** Called with each verified licence (the updater reads its update offer). */
  onLicence: (c: PharmacyLicence) => void = () => {};
  /** Kept by Nuskha HQ so the owner can open a backup on a new PC. */
  backupKey: string | null = null;
  get key() { return this.publicKey; }
  licenceKey() { return this.meta('licence_key'); }

  private async meta(key: string): Promise<string | null> {
    return (await this.db.query<{ value: string }>('select value from medflow_local.meta where key = $1', [key])).rows[0]?.value ?? null;
  }
  private async setMeta(key: string, value: string | null) {
    if (value === null) await this.db.query('delete from medflow_local.meta where key = $1', [key]);
    else await this.db.query('insert into medflow_local.meta (key, value) values ($1, $2) on conflict (key) do update set value = excluded.value', [key, value]);
  }

  async start() {
    await this.db.exec('create table if not exists medflow_local.meta (key text primary key, value text not null)');
    if (!(await this.meta('install_id'))) await this.setMeta('install_id', randomUUID());
    if (!this.enabled) { this.log('Licence: off (this build has no Nuskha HQ)'); return; }
    this.publicKey = await importPublicKey(BUILT_IN.public_key);
    const token = await this.meta('licence_token');
    if (token) this.claims = await verifyClaims<PharmacyLicence>(token, this.publicKey);
    if (this.claims) this.onLicence(this.claims);
    this.lastCheckin = await this.meta('last_checkin_at');
    await this.apply();
    setTimeout(() => void this.checkIn().catch(() => {}), 10_000);
    setInterval(() => void this.checkIn().catch(() => {}), 6 * 3600_000);
    setInterval(() => void this.apply().catch(() => {}), 15 * 60_000);
  }

  /** Extra facts for HQ's health page (e.g. an update that failed here). */
  extraStats: () => Record<string, unknown> = () => ({});

  private async stats() {
    const r = await this.db.query<Record<string, number>>(`select
      (select count(*) from products)::int products, (select count(*) from devices where kind = 'counter' and status = 'active')::int counters,
      (select count(*) from users where status = 'active')::int staff, (select count(*) from sales where sold_at > now() - interval '30 days')::int bills_30_days`);
    return { ...(r.rows[0] ?? {}), ...this.extraStats() };
  }

  /** Asks HQ for a fresh licence with this key (the saved one unless a new one is given). */
  async checkIn(newKey?: string): Promise<LicenceStatus> {
    if (!this.enabled || !this.publicKey) throw new ApiError('This Nuskha has no licence server', 400);
    const ph = await pharmacy(this.db);
    if (!ph) throw new ApiError('Set up Nuskha first', 409);
    const key = (newKey ?? (await this.meta('licence_key')) ?? '').trim().toUpperCase();
    if (!key) throw new ApiError('Enter the licence key from Nuskha first');
    let res: Response;
    try {
      res = await fetch(`${this.hqUrl}/hq/checkin`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(20_000),
        body: JSON.stringify({ key, install_id: await this.meta('install_id'), backup_key: this.backupKey, info: { version: this.version, machine: os.hostname(), stats: await this.stats() } }),
      });
    } catch {
      this.lastError = 'No internet or Nuskha HQ not reachable. Nuskha keeps working offline.';
      if (newKey) throw new ApiError('Could not reach Nuskha to check the key. Check the internet and try again.', 503);
      return this.status();
    }
    const body = await res.json().catch(() => ({})) as { token?: string; error?: string };
    if (!res.ok || !body.token) {
      this.lastError = body.error ?? `Nuskha HQ answered ${res.status}`;
      if (newKey) throw new ApiError(this.lastError, 400);
      // A key HQ no longer accepts (replaced or the pharmacy removed): stop at the licence's end.
      if (res.status === 403) this.log(`Licence: HQ refused the key: ${this.lastError}`);
      return this.status();
    }
    const claims = await verifyClaims<PharmacyLicence>(body.token, this.publicKey);
    if (!claims || claims.kind !== 'pharmacy' || claims.install_id !== (await this.meta('install_id'))) {
      this.lastError = 'The answer from Nuskha HQ was not signed correctly';
      if (newKey) throw new ApiError(this.lastError, 400);
      return this.status();
    }
    this.claims = claims;
    this.onLicence(claims);
    this.lastError = null;
    this.lastCheckin = new Date().toISOString();
    await this.setMeta('licence_key', key);
    await this.setMeta('licence_token', body.token);
    await this.setMeta('last_checkin_at', this.lastCheckin);
    await this.setMeta('no_key_since', null);
    await this.apply();
    return this.status();
  }

  /** What the local database must enforce now. */
  private async target(): Promise<{ status: string; read_only_from: string | null; message: string; state: LicenceStatus['state'] }> {
    const ph = await pharmacy(this.db);
    if (!ph) return { status: 'active', read_only_from: null, message: '', state: 'none' };
    if (ph.tenant_id === DEMO.tenant) return { status: 'active', read_only_from: null, message: 'Demo pharmacy: practice data', state: 'demo' };
    const c = this.claims;
    if (!c) {
      let since = await this.meta('no_key_since');
      if (!since) { since = new Date().toISOString(); await this.setMeta('no_key_since', since); }
      const until = new Date(Date.parse(since) + NO_KEY_DAYS * 86_400_000);
      return until > new Date()
        ? { status: 'trial', read_only_from: until.toISOString(), message: `Enter your Nuskha licence key by ${until.toDateString()}`, state: 'none' }
        : { status: 'read_only', read_only_from: null, message: 'No licence key: Nuskha is read-only. Enter the key in Settings.', state: 'stopped' };
    }
    const expired = Date.parse(c.valid_until) <= Date.now();
    if (!c.may_sell) {
      return { status: ['suspended', 'cancelled'].includes(c.status) ? c.status : 'read_only', read_only_from: null, state: 'stopped',
               message: c.status === 'suspended' ? 'Nuskha is suspended. Please contact Nuskha.' : 'Nuskha is read-only. Pay the invoice in Settings to continue.' };
    }
    if (expired) {
      return { status: 'read_only', read_only_from: null, state: 'expired',
               message: 'Nuskha has not reached Nuskha HQ for too long. Connect to the internet and press "Check now".' };
    }
    const offline = !this.lastCheckin || Date.now() - Date.parse(this.lastCheckin) > 24 * 3600_000;
    const msg = c.status === 'trial' ? `Free trial until ${new Date(c.trial_ends_at ?? c.valid_until).toDateString()}`
      : c.status === 'grace' ? 'Payment is late. Please pay the Nuskha invoice to keep selling.' : '';
    return { status: c.status, read_only_from: c.read_only_from, message: msg, state: offline ? 'offline' : 'ok' };
  }

  /** Makes the local database follow the licence (status, read-only time, features and limits). */
  async apply() {
    if (!this.enabled) return;
    const ph = await pharmacy(this.db);
    if (!ph || ph.tenant_id === DEMO.tenant) return;
    const t = await this.target();
    await this.db.transaction(async (tx) => {
      await tx.query(`update tenants set status = $2, read_only_from = $3::timestamptz, trial_ends_at = $4::timestamptz, grace_ends_at = $5::timestamptz
                      where id = $1`, [ph.tenant_id, t.status, t.status === 'read_only' ? null : t.read_only_from,
                                       this.claims?.trial_ends_at ?? null, this.claims?.grace_ends_at ?? null]);
      if (this.claims) {
        await tx.query(`delete from tenant_feature_overrides where tenant_id = $1 and reason = 'Nuskha HQ'`, [ph.tenant_id]);
        for (const [code, f] of Object.entries(this.claims.features)) {
          await tx.query(`insert into tenant_feature_overrides (tenant_id, feature_code, enabled, limit_value, reason)
                          select $1, $2, $3, $4, 'Nuskha HQ' where exists (select 1 from features where code = $2)
                          on conflict (tenant_id, feature_code) do update set enabled = excluded.enabled, limit_value = excluded.limit_value, reason = excluded.reason`,
                         [ph.tenant_id, code, f.enabled, f.limit]);
        }
      }
    });
  }

  async status(): Promise<LicenceStatus> {
    const base: LicenceStatus = { state: 'off', message: '', status: null, plan_name: null, may_sell: true, valid_until: null, trial_ends_at: null,
      grace_ends_at: null, read_only_from: null, key_hint: null, last_checkin_at: this.lastCheckin, last_error: this.lastError, no_key_until: null,
      announcements: [], invoices: [], payment_instructions: null };
    if (!this.enabled) return base;
    const t = await this.target();
    const key = await this.meta('licence_key');
    const c = this.claims;
    return { ...base, state: t.state, message: t.message, status: t.status, may_sell: ['trial', 'active', 'grace'].includes(t.status),
      plan_name: c?.plan_name ?? null, valid_until: c?.valid_until ?? null, trial_ends_at: c?.trial_ends_at ?? null, grace_ends_at: c?.grace_ends_at ?? null,
      read_only_from: c?.read_only_from ?? null, key_hint: key ? `…${key.slice(-4)}` : null,
      no_key_until: !c && t.state === 'none' ? t.read_only_from : null,
      announcements: c?.announcements ?? [], invoices: c?.invoices ?? [], payment_instructions: c?.payment_instructions ?? null };
  }

  /** The owner tells Nuskha HQ they paid an invoice. */
  async submitPayment(invoice: string, method: string, amount: number, reference: string) {
    const key = await this.meta('licence_key');
    if (!key) throw new ApiError('Enter the licence key first');
    let res: Response;
    try {
      res = await fetch(`${this.hqUrl}/hq/payment`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(20_000),
        body: JSON.stringify({ key, invoice, method, amount, reference }) });
    } catch { throw new ApiError('Could not reach Nuskha. Check the internet and try again.', 503); }
    const body = await res.json().catch(() => ({})) as { error?: string };
    if (!res.ok) throw new ApiError(body.error ?? `Nuskha HQ answered ${res.status}`, 400);
    await this.checkIn().catch(() => {});
  }
}
