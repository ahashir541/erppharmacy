// MedFlow Local: the app talks to the pharmacy's own server on the main PC (same address it was
// opened from). This PC proves it is a linked counter with its token; back-office calls also carry
// the owner's counter session, which the server checks before acting as the owner.
import {
  PosError, type Batch, type CustomerHit, type HeldBill, type PosBackend, type PosContext, type Product, type Receipt, type SaleResult,
} from './types.ts';

export const serverMode = import.meta.env.VITE_MEDFLOW_SERVER === '1';
const TOKEN_KEY = 'medflow.local.counter';

export interface LicenceStatus {
  state: 'off' | 'demo' | 'none' | 'ok' | 'offline' | 'expired' | 'stopped'; message: string; status: string | null; plan_name: string | null;
  may_sell: boolean; valid_until: string | null; trial_ends_at: string | null; grace_ends_at: string | null; read_only_from: string | null;
  key_hint: string | null; last_checkin_at: string | null; last_error: string | null; no_key_until: string | null;
  announcements: Array<{ id: string; title: string; title_ur: string | null; body: string; body_ur: string | null; severity: string }>;
  invoices: Array<{ id: string; invoice_number: string; amount: number; currency: string; due_at: string; status: string }>;
  payment_instructions: string | null;
}
export interface ServerStatus { ready: boolean; pharmacy: string | null; version: string; this_pc: boolean; addresses: string[];
  licence: LicenceStatus | null; licensing: boolean; update: UpdateStatus | null }
export interface UpdateStatus { current: string; installing: boolean; last_error: string | null; last_result: string | null; install_window: string;
  offer: { version?: string; notes?: string; size_bytes?: number; is_rollback?: boolean; must_update?: boolean } | null }
export interface BackupList { folder: string; copy_to: string | null; list: Array<{ file: string; size: number; at: string }> }

export const savedToken = () => { try { return localStorage.getItem(TOKEN_KEY); } catch { return null; } };
export const saveToken = (t: string) => { try { localStorage.setItem(TOKEN_KEY, t); } catch { /* private window */ } };
export const forgetToken = () => { try { localStorage.removeItem(TOKEN_KEY); } catch { /* ignore */ } };

/** While MedFlow is starting (it answers 503 until the database is open), wait and try again. */
async function fetchWhileStarting(go: () => Promise<Response>): Promise<Response> {
  for (let i = 0; ; i++) {
    const res = await go();
    if (res.status !== 503 || i >= 60) return res;
    await new Promise((r) => setTimeout(r, 2000));
  }
}

async function post<T>(path: string, body: unknown, headers: Record<string, string> = {}, method = 'POST'): Promise<T> {
  let res: Response;
  try {
    res = await fetchWhileStarting(() => fetch(`/api/${path}`, { method, headers: { 'Content-Type': 'application/json', ...headers }, body: method === 'GET' ? null : JSON.stringify(body) }));
  } catch {
    throw new PosError('Cannot reach the MedFlow PC. Is the main PC switched on and on the same network?', 'offline');
  }
  const data = await res.json().catch(() => ({})) as { error?: string; code?: string; hint?: string | null; detail?: string | null } & T;
  if (!res.ok) {
    if (res.status === 401) forgetToken();
    throw new PosError(data.error ?? `MedFlow server error ${res.status}`, data.code ?? String(res.status), data.hint ?? null, data.detail ?? null);
  }
  return data;
}

export const serverStatus = () => post<ServerStatus>('status', null, {}, 'GET');
export async function setupServer(body: Record<string, unknown>): Promise<string | null> {
  const r = await post<{ token: string; licence_error?: string | null }>('setup', body);
  saveToken(r.token);
  return r.licence_error ?? null;
}
export async function linkThisPc(pin: string, name: string) { saveToken((await post<{ token: string }>('link', { pin, name })).token); }

export class ServerBackend implements PosBackend {
  /** The owner's (or any staff's) counter session; the server only honours an owner's. */
  private session: string | null = null;
  constructor(private readonly token: string) {}

  private headers(): Record<string, string> {
    return { Authorization: `Bearer ${this.token}`, ...(this.session ? { 'X-MedFlow-Session': this.session } : {}) };
  }
  private async call<T>(as: 'device' | 'owner', fn: string, args: unknown[], rows = false): Promise<T> {
    return (await post<{ r: T }>('call', { as, fn, args, rows }, this.headers())).r;
  }
  private dev<T>(fn: string, ...args: unknown[]) { return this.call<T>('device', fn, args); }

  // ---- Counter ----
  context() { return this.dev<PosContext>('pos_context'); }
  search(q: string) { return this.dev<Product[]>('pos_search', q, 25); }
  batches(productId: string) { return this.dev<Batch[]>('pos_batches', productId); }
  customers(q: string) { return this.dev<CustomerHit[]>('pos_customers', q, 10); }
  async startSession(userId: string, sessionId: string) {
    await this.dev('start_staff_session', userId, sessionId);
    this.session = sessionId;
  }
  async pinFailure(userId: string) { await this.dev('record_pin_failure', userId); }
  async endSession(sessionId: string, reason: 'logout' | 'idle_lock') {
    if (this.session === sessionId) this.session = null;
    await this.dev('end_staff_session', sessionId, reason);
  }
  openShift(drawerId: string, openingFloat: number, sessionId: string) { return this.dev<string>('open_drawer', drawerId, openingFloat, sessionId); }
  async closeShift(id: string, counted: number, sessionId: string) { await this.dev('close_drawer', id, counted, null, sessionId); }
  postSale(sale: Record<string, unknown>, sessionId: string) { return this.dev<SaleResult>('post_sale', sale, sessionId); }
  billForReturn(invoice: string) { return this.dev<unknown>('pos_bill_for_return', invoice); }
  postReturn(ret: Record<string, unknown>, sessionId: string) {
    return this.dev<{ return_id: string; return_number: string; refund_total: number }>('post_return', ret, sessionId);
  }
  receipt(saleId: string) { return this.dev<Receipt>('get_receipt', saleId); }
  requestApproval(r: Record<string, unknown>, sessionId: string) { return this.dev<string>('request_approval', r, sessionId); }
  async approvalStatus(id: string) { return (await post<{ r: string }>('approval-status', { id }, this.headers())).r; }
  async approveAtCounter(requestId: string, approverId: string, sessionId: string) { await this.dev('approve_at_counter', requestId, approverId, sessionId); }
  private async command(kind: string, payload: Record<string, unknown>, session: string) {
    await post('command', { kind, payload, session }, this.headers());
  }
  async holdBill(id: string, label: string, cart: unknown, sessionId: string) { await this.command('held_bill', { id, label, cart }, sessionId); }
  heldBills() { return this.dev<HeldBill[]>('pos_held_bills'); }
  async resumeBill(b: HeldBill, sessionId: string) {
    await this.command('held_bill', { id: b.id, label: b.label, cart: b.cart, resumed_at: new Date().toISOString() }, sessionId);
  }

  // ---- Back office (owner signed in on this counter) ----
  ownerRows<T>(): Promise<T[]> { return Promise.reject(new PosError('Raw queries are not available on MedFlow Local')); }
  ownerCall<T = unknown>(fn: string, ...args: unknown[]) { return this.call<T>('owner', fn, args); }
  ownerTable<T = Record<string, unknown>>(fn: string, ...args: unknown[]) { return this.call<T[]>('owner', fn, args, true); }
  office<T = unknown>(name: string, ...args: unknown[]) { return this.call<T>('owner', `office_${name}`, args); }

  installUpdate() { return post<{ ok: boolean }>('update/install', {}, this.headers()); }
  checkLicence() { return post<LicenceStatus>('licence/check', {}, this.headers()); }
  setLicenceKey(key: string) { return post<LicenceStatus>('licence/key', { key }, this.headers()); }
  payInvoice(invoice: string, method: string, amount: number, reference: string) {
    return post<LicenceStatus>('licence/payment', { invoice, method, amount, reference }, this.headers());
  }
  backups(now = false) { return post<BackupList>('backups', {}, this.headers(), now ? 'POST' : 'GET'); }
}
