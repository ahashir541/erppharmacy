// What the POS needs from MedFlow. One interface, two homes: the in-browser demo database today
// (local.ts), the Supabase / PowerSync counter later. Screens only ever talk to this.

export interface Staff {
  id: string;
  name: string;
  kind: 'owner' | 'staff';
  pin_hash: string;
  locked_until: string | null;
  idle_lock_seconds: number | null;
  roles: string[];
  can_approve: boolean;
}

export interface PosContext {
  pharmacy: string;
  language: 'en' | 'ur';
  branch: { id: string; code: string; name: string; address: string; phone: string | null };
  device: { id: string; code: string; name: string; invoice_prefix: string };
  drawers: Array<{ id: string; name: string }>;
  open_shift: { drawer_session_id: string; opened_by: string; opened_at: string; opened_by_name: string } | null;
  next_invoice_seq: number;
  next_return_seq: number;
  staff: Staff[];
  settings: { rounding_step: number; receipt_width: 58 | 80; receipt_footer: string | null };
  today: string;
}

export interface Unit {
  product_unit_id: string;
  unit: string;
  unit_name: string;
  unit_name_ur: string | null;
  factor: number;
  price: number | null;
}

export interface Product {
  product_id: string;
  name: string;
  name_ur: string | null;
  strength: string | null;
  dosage_form: string | null;
  generic: string | null;
  manufacturer: string | null;
  rack: string | null;
  is_controlled: boolean;
  rx_required: boolean;
  max_qty_per_sale: number | null;
  barcode_unit_id: string | null;
  stock_base: number;
  nearest_expiry: string | null;
  units: Unit[];
}

export interface Batch {
  batch_id: string;
  batch_number: string;
  expiry_date: string;
  qty_base: number;
  prices: Record<string, number | null>;
}

export interface CustomerHit {
  customer_id: string;
  account_id: string;
  account_number: string;
  name: string;
  name_ur: string | null;
  phone: string | null;
  can_buy_on_account: boolean;
  udhaar_status: 'allowed' | 'blocked' | 'over_limit' | 'no_limit_set';
  available_credit: number | null;
}

export interface HeldBill {
  id: string;
  label: string;
  cart: unknown;
  held_at: string;
  by: string | null;
}

export interface SaleResult {
  sale_id: string;
  invoice_number: string;
  grand_total: number;
  change: number;
  udhaar: number;
  duplicate: boolean;
}

export interface Receipt {
  invoice_number: string;
  sold_at: string;
  status: string;
  branch: { name: string; address: string | null; phone: string | null };
  pharmacy: string;
  lines: Array<{ name: string; strength: string | null; unit: string; qty: number; unit_price: number; discount: number; line_total: number;
                 batch: string | null; expiry: string | null }>;
  subtotal: number;
  discount_total: number;
  rounding: number;
  grand_total: number;
  paid_total: number;
  udhaar: number;
  change: number;
  payments: Array<{ method: string; amount: number }> | null;
}

/** A refusal from MedFlow, in words for the person at the counter. */
export class PosError extends Error {
  readonly code: string;
  readonly hint: string | null;
  readonly detail: string | null;
  constructor(message: string, code = '', hint: string | null = null, detail: string | null = null) {
    super(message);
    this.code = code;
    this.hint = hint;
    this.detail = detail;
  }
  get needsApproval() {
    return this.hint === 'approval_required';
  }
}

/** The owner's back office. */
export interface OfficeBackend {
  ownerRows<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]>;
  ownerCall<T = unknown>(fn: string, ...args: unknown[]): Promise<T>;
  ownerTable<T = Record<string, unknown>>(fn: string, ...args: unknown[]): Promise<T[]>;
}

export interface PosBackend extends OfficeBackend {
  context(): Promise<PosContext>;
  search(query: string): Promise<Product[]>;
  batches(productId: string): Promise<Batch[]>;
  customers(query: string): Promise<CustomerHit[]>;
  startSession(userId: string, sessionId: string): Promise<void>;
  pinFailure(userId: string): Promise<void>;
  endSession(sessionId: string, reason: 'logout' | 'idle_lock'): Promise<void>;
  openShift(drawerId: string, openingFloat: number, sessionId: string): Promise<string>;
  closeShift(drawerSessionId: string, counted: number, sessionId: string): Promise<void>;
  postSale(sale: Record<string, unknown>, sessionId: string): Promise<SaleResult>;
  receipt(saleId: string): Promise<Receipt>;
  requestApproval(request: Record<string, unknown>, sessionId: string): Promise<string>;
  approvalStatus(requestId: string): Promise<string>;
  approveAtCounter(requestId: string, approverId: string, sessionId: string): Promise<void>;
  holdBill(id: string, label: string, cart: unknown, sessionId: string): Promise<void>;
  heldBills(): Promise<HeldBill[]>;
  resumeBill(bill: HeldBill, sessionId: string): Promise<void>;
}
