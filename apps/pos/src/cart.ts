// The bill being made at the counter. Pure functions: the screen keeps the state, these do the
// sums with packages/core (the same maths the server checks), so the total on screen is the total
// recorded.
import { priceBill, settlePayments, type Bill, type PaymentMethod, type Settlement } from '@medflow/core';
import type { Batch, CustomerHit, Product, Unit } from './backend/types.ts';

export interface CartLine {
  key: string;
  product: Product;
  unitId: string;
  qty: number;
  batches: Batch[];
  priceOverride: number | null;   // paisa per unit (needs "edit price")
  discountPct: number;            // 0–100, may have decimals
}

export interface Allocation {
  batchId: string;
  batchNumber: string;
  expiry: string;
  qty: number;                    // in the line's unit
  unitPrice: number;
}

export interface CartState {
  lines: CartLine[];
  billDiscount: number;           // paisa
  customer: CustomerHit | null;
  method: PaymentMethod;
  cashReceived: number | null;    // paisa; null = exact
  note: string;
}

export const emptyCart = (): CartState => ({ lines: [], billDiscount: 0, customer: null, method: 'cash', cashReceived: null, note: '' });

export const unitOf = (line: CartLine): Unit => line.product.units.find((u) => u.product_unit_id === line.unitId) ?? line.product.units[0]!;

/**
 * Which batches the line is sold from: first expiry first, in whole units of the chosen pack
 * (a strip is never split across two batches). `short` is what the shelf cannot cover.
 */
export function allocate(line: CartLine): { allocations: Allocation[]; short: number } {
  const unit = unitOf(line);
  let left = line.qty;
  const allocations: Allocation[] = [];
  for (const b of [...line.batches].sort((a, z) => a.expiry_date.localeCompare(z.expiry_date) || a.batch_id.localeCompare(z.batch_id))) {
    if (left <= 0) break;
    const whole = Math.floor(b.qty_base / unit.factor);
    const take = Math.min(left, whole);
    if (take <= 0) continue;
    const price = line.priceOverride ?? b.prices[unit.product_unit_id] ?? unit.price;
    if (price === null || price === undefined) continue;
    allocations.push({ batchId: b.batch_id, batchNumber: b.batch_number, expiry: b.expiry_date, qty: take, unitPrice: price });
    left -= take;
  }
  return { allocations, short: left };
}

/** Line discount for one allocation: the line's percentage of its amount, rounded half up. */
const pctOf = (amount: number, pct: number) => Math.min(amount, Math.round((amount * pct) / 100));

export interface PricedCart {
  bill: Bill | null;
  rows: Array<{ line: CartLine; allocations: Allocation[]; short: number; gross: number; discount: number; total: number; unitPrice: number | null }>;
  problems: string[];
}

export function priceCart(cart: CartState, roundingStep: number): PricedCart {
  const rows = cart.lines.map((line) => {
    const { allocations, short } = allocate(line);
    const gross = allocations.reduce((s, a) => s + a.qty * a.unitPrice, 0);
    const discount = allocations.reduce((s, a) => s + pctOf(a.qty * a.unitPrice, line.discountPct), 0);
    return { line, allocations, short, gross, discount, total: gross - discount, unitPrice: allocations[0]?.unitPrice ?? unitOf(line).price };
  });
  const problems: string[] = [];
  for (const r of rows) {
    if (r.short > 0) problems.push(`${r.line.product.name}: only ${r.line.qty - r.short} ${unitOf(r.line).unit_name} on the shelf`);
    const max = r.line.product.max_qty_per_sale;
    if (max && r.line.qty * unitOf(r.line).factor > max) problems.push(`${r.line.product.name}: at most ${max} per sale`);
  }
  const inputs = rows.flatMap((r) => r.allocations.map((a) => ({ qty: a.qty, unitPrice: a.unitPrice, lineDiscount: pctOf(a.qty * a.unitPrice, r.line.discountPct) })));
  let bill: Bill | null = null;
  if (inputs.length) {
    try {
      bill = priceBill(inputs, { billDiscount: cart.billDiscount, pricesIncludeTax: true, roundingStep });
    } catch (err) {
      problems.push((err as Error).message);
    }
  }
  return { bill, rows, problems };
}

/** How the bill is paid: the chosen method for the total, or cash with change; the rest on khata. */
export function settle(cart: CartState, grandTotal: number): Settlement {
  if (cart.method === 'cash') {
    return settlePayments(grandTotal, [{ method: 'cash', tendered: cart.cashReceived ?? (cart.customer ? 0 : grandTotal) }]);
  }
  return settlePayments(grandTotal, [{ method: cart.method, amount: grandTotal }]);
}

/** The bill as public.post_sale takes it (one line per batch). */
export function salePayload(cart: CartState, priced: PricedCart, settlement: Settlement, ids: { saleId: string; seq: number; drawerSessionId: string | null },
                            approvals: Record<string, string>, newId: () => string) {
  return {
    id: ids.saleId,
    local_seq: ids.seq,
    sold_at: new Date().toISOString(),
    drawer_session_id: ids.drawerSessionId,
    customer_id: cart.customer?.customer_id ?? null,
    customer_account_id: settlement.udhaar > 0 ? cart.customer?.account_id ?? null : null,
    bill_discount: cart.billDiscount,
    grand_total: priced.bill!.grandTotal,
    notes: cart.note || null,
    lines: priced.rows.flatMap((r) => r.allocations.map((a) => ({
      id: newId(), product_unit_id: r.line.unitId, batch_id: a.batchId, qty: a.qty, unit_price: a.unitPrice,
      line_discount: pctOf(a.qty * a.unitPrice, r.line.discountPct),
    }))),
    payments: settlement.payments.map((p) => (p.method === 'cash' ? { method: 'cash', tendered: p.tendered } : { method: p.method, amount: p.amount })),
    approvals,
  };
}

/** Which approval key the server expects for a permission (app.record_sale). */
export const APPROVAL_KEY: Record<string, string> = {
  'sales.discount': 'discount', 'sales.edit_price': 'price', 'sales.negative_stock': 'negative_stock',
  'udhaar.give': 'udhaar', 'sales.sell_below_min': 'below_min',
};
export const APPROVAL_KIND: Record<string, string> = {
  'sales.discount': 'discount', 'sales.edit_price': 'price_change', 'sales.negative_stock': 'negative_stock',
  'udhaar.give': 'udhaar_over_limit', 'sales.sell_below_min': 'price_change',
};
