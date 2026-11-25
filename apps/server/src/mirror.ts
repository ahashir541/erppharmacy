// Owner live view (hybrid). The shop keeps working offline; whenever this PC has internet it sends
// a read-only copy of the owner's screens to Nuskha Cloud once a minute. Only screens that changed
// are sent. The owner's laptop (Nuskha Owner, or app-nuskha.vercel.app/#/view) reads them with
// the view code. Turning sharing off deletes the copy in the cloud.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { PGlite } from '@electric-sql/pglite';
import { asPrincipal, callFunction } from './db.ts';

declare const __NUSKHA_CLOUD__: { url: string; anon_key: string } | undefined;
const CLOUD = typeof __NUSKHA_CLOUD__ !== 'undefined' ? __NUSKHA_CLOUD__ : undefined;

interface State { push_key: string; view_code: string; enabled: boolean }
export interface MirrorStatus { available: boolean; enabled: boolean; view_code: string | null; last_ok: string | null; last_error: string | null; online: boolean }

const SLOW = new Set(['office_products', 'office_movements', 'office_customers']);   // big lists: every 10 minutes

/** A code people can read out on the phone: NSK-XXXX-XXXX-XXXX-XXXX (no 0/O/1/I). */
function newViewCode() {
  const abc = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const b = crypto.randomBytes(16);
  const g = [0, 1, 2, 3].map((i) => Array.from(b.subarray(i * 4, i * 4 + 4), (x) => abc[x % abc.length]).join(''));
  return `NSK-${g.join('-')}`;
}
const sha = (s: string) => crypto.createHash('sha256').update(s, 'utf8').digest('hex');

export class Mirror {
  private state: State | null = null;
  private lastSent = new Map<string, string>();
  private lastSlow = 0;
  private lastOk: string | null = null;
  private lastError: string | null = null;
  private timer: NodeJS.Timeout | null = null;
  private busy = false;

  constructor(private readonly db: PGlite, private readonly file: string, private readonly version: string, private readonly log: (s: string) => void) {
    try { this.state = JSON.parse(fs.readFileSync(file, 'utf8')) as State; } catch { this.state = null; }
  }

  get available() { return !!CLOUD; }

  status(): MirrorStatus {
    return { available: this.available, enabled: !!this.state?.enabled, view_code: this.state?.enabled ? this.state.view_code : null,
             last_ok: this.lastOk, last_error: this.lastError, online: !this.lastError };
  }

  start() {
    if (this.timer) return;
    this.timer = setInterval(() => { void this.tick(); }, 60_000);
    setTimeout(() => { void this.tick(); }, 15_000);
  }

  private save() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(this.file, JSON.stringify(this.state, null, 2));
  }

  /** Turn sharing on (keeps the code if it was on before) or give a new view code. */
  async enable(newCode = false) {
    if (!CLOUD) throw new Error('This Nuskha was built without Nuskha Cloud');
    if (!this.state) this.state = { push_key: crypto.randomBytes(32).toString('hex'), view_code: newViewCode(), enabled: true };
    if (newCode) this.state.view_code = newViewCode();
    this.state.enabled = true;
    this.save();
    this.lastSent.clear(); this.lastSlow = 0;
    this.log(newCode ? 'Owner view: new view code made; old laptops must type the new one' : 'Owner view: sharing turned on');
    await this.tick(true);
    return this.status();
  }

  async disable() {
    if (this.state && CLOUD) {
      await this.rpc('mirror_forget', { p_push_key: this.state.push_key }).catch((e: Error) => this.log(`Owner view: could not delete the cloud copy now (${e.message})`));
    }
    if (this.state) { this.state.enabled = false; this.save(); }
    this.lastSent.clear();
    this.log('Owner view: sharing turned off');
    return this.status();
  }

  /** Erasing the pharmacy: forget the keys too. */
  forget() { try { fs.rmSync(this.file, { force: true }); } catch { /* gone */ } this.state = null; }

  private async rpc(fn: string, body: unknown) {
    // NUSKHA_CLOUD_URL is only for tests (e.g. an unreachable address to act out "no internet").
    const res = await fetch(`${process.env.NUSKHA_CLOUD_URL ?? CLOUD!.url}/rest/v1/rpc/${fn}`, {
      method: 'POST', signal: AbortSignal.timeout(45_000),
      headers: { 'Content-Type': 'application/json', apikey: CLOUD!.anon_key, Authorization: `Bearer ${CLOUD!.anon_key}` },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`cloud answered ${res.status}: ${(await res.text()).slice(0, 200)}`);
    return res.json();
  }

  /** The owner's screens, read on this PC exactly as the back office reads them. */
  private async snapshot(includeSlow: boolean) {
    const owner = (await this.db.query<{ auth_user_id: string; tenant_id: string; pharmacy: string; branch_id: string; branch: string; today: string }>(`
      select u.auth_user_id, u.tenant_id, t.name pharmacy, b.id branch_id, b.name branch, app.business_date(b.id)::text today
      from users u join tenants t on t.id = u.tenant_id join branches b on b.tenant_id = t.id
      where u.kind = 'owner' and u.status = 'active' order by b.created_at limit 1`)).rows[0];
    if (!owner) return null;
    const claims = { sub: owner.auth_user_id, role: 'authenticated', aal: 'aal2', tenant_id: owner.tenant_id };
    const t = owner.today; const br = owner.branch_id;
    const from = new Date(Date.parse(`${t}T00:00:00Z`) - 30 * 86_400_000).toISOString().slice(0, 10);
    const calls: Array<[string, string, unknown[], boolean]> = [
      ['owner_dashboard', 'owner_dashboard', [], false],
      ['office_sales_trend', 'office_sales_trend', [t], false],
      ['office_invoices', 'office_invoices', [from, t, 'all', ''], false],
      ['office_shifts', 'office_shifts', [from, t], false],
      ['office_expiry', 'office_expiry', [br], false],
      ['office_suppliers', 'office_suppliers', [], false],
      ['office_deliveries', 'office_deliveries', [br], false],
      ['office_udhaar_reminders', 'office_udhaar_reminders', [t], false],
      ['office_reorder_list', 'office_reorder_list', [br], false],
      ['office_refills_due', 'office_refills_due', [t, 0], false],
      ['office_whatsapp_settings', 'office_whatsapp_settings', [], false],
      ['party_ageing:customer_account', 'party_ageing', ['customer_account', t], true],
      ['party_ageing:supplier', 'party_ageing', ['supplier', t], true],
      ['office_products', 'office_products', [br, ''], false],
      ['office_movements', 'office_movements', [br, ''], false],
      ['office_customers', 'office_customers', [''], false],
    ];
    const parts: Record<string, unknown> = {};
    for (const [key, fn, args, rows] of calls) {
      if (SLOW.has(key) && !includeSlow) continue;
      try { parts[key] = await asPrincipal(this.db, claims, (tx) => callFunction(tx, fn, args, rows)); }
      catch (e) { this.log(`Owner view: ${fn} skipped (${(e as Error).message})`); }
    }
    const meta = { pharmacy: owner.pharmacy, branch: owner.branch, branch_id: br, today: t, version: this.version };
    return { meta, parts };
  }

  async tick(force = false) {
    if (!CLOUD || !this.state?.enabled || this.busy) return;
    this.busy = true;
    try {
      const slow = force || Date.now() - this.lastSlow > 10 * 60_000;
      const snap = await this.snapshot(slow);
      if (!snap) return;
      const changed: Record<string, unknown> = {};
      const hashes = new Map<string, string>();
      for (const [k, v] of Object.entries(snap.parts)) {
        const h = sha(JSON.stringify(v));
        hashes.set(k, h);
        if (this.lastSent.get(k) !== h) changed[k] = v;
      }
      // A heartbeat even when nothing changed, so the owner sees "updated a minute ago".
      await this.rpc('mirror_push', { p_push_key: this.state.push_key, p_view_hash: sha(this.state.view_code), p_meta: snap.meta, p_parts: changed });
      for (const [k, h] of hashes) this.lastSent.set(k, h);
      if (slow) this.lastSlow = Date.now();
      if (this.lastError) this.log('Owner view: back online, sending again');
      this.lastOk = new Date().toISOString();
      this.lastError = null;
    } catch (e) {
      // No internet: the shop carries on; the next minute tries again with everything that changed.
      if (!this.lastError) this.log(`Owner view: cannot reach Nuskha Cloud now (${(e as Error).message}); will keep trying`);
      this.lastError = (e as Error).message;
    } finally {
      this.busy = false;
    }
  }
}
