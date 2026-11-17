// MedFlow on the cloud (Supabase). Two sign-ins live side by side:
//  - the counter PC (a device principal, D6/D11): its own login, saved on the PC when the owner
//    links it; staff then unlock it with their PIN;
//  - the owner: email, password and the 6-digit 2FA code, from any phone or browser.
// Every call is a MedFlow database function; Row Level Security decides what each one sees.
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { PosError, type Batch, type CustomerHit, type HeldBill, type PosBackend, type PosContext, type Product, type Receipt, type SaleResult } from './types.ts';
import { SIGNATURES } from './signatures.ts';

const URL = import.meta.env.VITE_SUPABASE_URL as string | undefined;
const KEY = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined;
export const cloudEnabled = !!(URL && KEY);
const DEVICE_KEY = 'medflow.counter-login';

export interface CounterLogin { email: string; password: string; device_id: string; invoice_prefix: string }

let owner: SupabaseClient | null = null;
let device: SupabaseClient | null = null;
export function clients() {
  if (!cloudEnabled) throw new Error('Cloud is not configured');
  owner ??= createClient(URL!, KEY!, { auth: { storageKey: 'medflow-owner', persistSession: true, autoRefreshToken: true } });
  device ??= createClient(URL!, KEY!, { auth: { storageKey: 'medflow-counter', persistSession: true, autoRefreshToken: true } });
  return { owner, device };
}

export function savedCounter(): CounterLogin | null {
  try { const v = localStorage.getItem(DEVICE_KEY); return v ? (JSON.parse(v) as CounterLogin) : null; } catch { return null; }
}
export function forgetCounter() {
  try { localStorage.removeItem(DEVICE_KEY); } catch { /* ignore */ }
}

/** Signs this PC in as its counter, if the owner linked it. */
export async function openCloudCounter(): Promise<CloudBackend | null> {
  const login = savedCounter();
  if (!login) return null;
  const { device } = clients();
  const { data } = await device.auth.getSession();
  if (!data.session) {
    const { error } = await device.auth.signInWithPassword({ email: login.email, password: login.password });
    if (error) throw new PosError(`This PC could not sign in to MedFlow: ${error.message}`);
  }
  return new CloudBackend();
}

/** Is the owner signed in with 2FA (aal2)? */
export async function ownerReady(): Promise<boolean> {
  const { owner } = clients();
  const { data } = await owner.auth.mfa.getAuthenticatorAssuranceLevel();
  return data?.currentLevel === 'aal2';
}

/** The owner links this browser / PC as a counter (Edge Function register-device). */
export async function linkCounter(branchId: string, code: string, name: string): Promise<void> {
  const { owner, device } = clients();
  const { data: s } = await owner.auth.getSession();
  if (!s.session) throw new PosError('Sign in as the owner first');
  const res = await fetch(`${URL}/functions/v1/register-device`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${s.session.access_token}`, apikey: KEY! },
    body: JSON.stringify({ branch_id: branchId, code, name }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new PosError(body.error ?? `Could not link this PC (${res.status})`);
  const login: CounterLogin = { email: body.sign_in.email, password: body.sign_in.password, device_id: body.device_id, invoice_prefix: body.invoice_prefix };
  localStorage.setItem(DEVICE_KEY, JSON.stringify(login));
  const { error } = await device.auth.signInWithPassword({ email: login.email, password: login.password });
  if (error) throw new PosError(error.message);
}

export class CloudBackend implements PosBackend {
  /** fn(a, b) → PostgREST's fn({ p_x: a, p_y: b }) using the generated parameter names. */
  private async rpc<T>(client: SupabaseClient, fn: string, args: unknown[]): Promise<T> {
    const names = SIGNATURES[fn];
    if (!names) throw new PosError(`Unknown MedFlow function ${fn}`);
    const body: Record<string, unknown> = {};
    args.forEach((a, i) => { if (a !== undefined && names[i]) body[names[i]!] = a; });
    const { data, error } = await client.rpc(fn, body);
    if (error) throw new PosError(error.message, error.code, error.hint ?? null, error.details ?? null);
    return data as T;
  }
  private dev<T>(fn: string, ...args: unknown[]) { return this.rpc<T>(clients().device, fn, args); }

  // ---- Counter ----
  context() { return this.dev<PosContext>('pos_context'); }
  search(q: string) { return this.dev<Product[]>('pos_search', q, 25); }
  batches(productId: string) { return this.dev<Batch[]>('pos_batches', productId); }
  customers(q: string) { return this.dev<CustomerHit[]>('pos_customers', q, 10); }
  async startSession(userId: string, sessionId: string) { await this.dev('start_staff_session', userId, sessionId); }
  async pinFailure(userId: string) { await this.dev('record_pin_failure', userId); }
  async endSession(sessionId: string, reason: 'logout' | 'idle_lock') { await this.dev('end_staff_session', sessionId, reason); }
  openShift(drawerId: string, openingFloat: number, sessionId: string) { return this.dev<string>('open_drawer', drawerId, openingFloat, sessionId); }
  async closeShift(id: string, counted: number, sessionId: string) { await this.dev('close_drawer', id, counted, null, sessionId); }
  postSale(sale: Record<string, unknown>, sessionId: string) { return this.dev<SaleResult>('post_sale', sale, sessionId); }
  billForReturn(invoice: string) { return this.dev<unknown>('pos_bill_for_return', invoice); }
  postReturn(ret: Record<string, unknown>, sessionId: string) {
    return this.dev<{ return_id: string; return_number: string; refund_total: number }>('post_return', ret, sessionId);
  }
  receipt(saleId: string) { return this.dev<Receipt>('get_receipt', saleId); }
  requestApproval(r: Record<string, unknown>, sessionId: string) { return this.dev<string>('request_approval', r, sessionId); }
  async approvalStatus(id: string) {
    const { data, error } = await clients().device.from('approval_requests').select('status').eq('id', id).single();
    if (error) throw new PosError(error.message);
    return (data as { status: string }).status;
  }
  async approveAtCounter(requestId: string, approverId: string, sessionId: string) { await this.dev('approve_at_counter', requestId, approverId, sessionId); }
  private async command(kind: string, payload: Record<string, unknown>, sessionId: string) {
    const d = clients().device;
    const { data: last } = await d.from('device_commands').select('device_seq').order('device_seq', { ascending: false }).limit(1);
    const { data: who } = await d.from('user_sessions').select('user_id').eq('id', sessionId).maybeSingle();
    const r = await this.dev<Array<{ status: string; result?: { error?: string } }>>('apply_device_commands', [{
      id: crypto.randomUUID(), device_seq: ((last?.[0] as { device_seq?: number } | undefined)?.device_seq ?? 0) + 1, kind,
      acting_user: (who as { user_id?: string } | null)?.user_id ?? null, session_id: sessionId, created_on_device_at: new Date().toISOString(), payload }]);
    if (r[0]?.status === 'rejected') throw new PosError(r[0].result?.error ?? 'Could not save');
  }
  async holdBill(id: string, label: string, cart: unknown, sessionId: string) { await this.command('held_bill', { id, label, cart }, sessionId); }
  heldBills() { return this.dev<HeldBill[]>('pos_held_bills'); }
  async resumeBill(b: HeldBill, sessionId: string) {
    await this.command('held_bill', { id: b.id, label: b.label, cart: b.cart, resumed_at: new Date().toISOString() }, sessionId);
  }

  // ---- Back office (owner) ----
  ownerRows<T>(): Promise<T[]> { return Promise.reject(new PosError('Raw queries are not available on the cloud')); }
  ownerCall<T = unknown>(fn: string, ...args: unknown[]) { return this.rpc<T>(clients().owner, fn, args); }
  ownerTable<T = Record<string, unknown>>(fn: string, ...args: unknown[]) { return this.rpc<T[]>(clients().owner, fn, args); }
  office<T = unknown>(name: string, ...args: unknown[]) { return this.rpc<T>(clients().owner, `office_${name}`, args); }
}

/** The back office's context when the owner works from a phone or a browser (no counter PC). */
export async function ownerContext(branchIndex = 0): Promise<PosContext & { branches: Array<{ id: string; name: string }> }> {
  const c = await new CloudBackend().ownerCall<{ pharmacy: string; language: 'en' | 'ur'; branches: Array<{ id: string; code: string; name: string; address: string; phone: string | null; today: string }> }>('owner_context');
  const b = c.branches[branchIndex] ?? c.branches[0];
  if (!b) throw new PosError('This pharmacy has no branch yet');
  return {
    pharmacy: c.pharmacy, language: c.language, branch: { id: b.id, code: b.code, name: b.name, address: b.address, phone: b.phone },
    device: { id: '', code: '', name: 'Web', invoice_prefix: '' }, drawers: [], open_shift: null, next_invoice_seq: 0, next_return_seq: 0,
    staff: [], settings: { rounding_step: 100, receipt_width: 80, receipt_footer: null }, today: b.today, branches: c.branches,
  };
}
