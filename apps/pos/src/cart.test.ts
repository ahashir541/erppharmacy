import { describe, expect, it } from 'vitest';
import type { Batch, Product } from './backend/types.ts';
import { allocate, emptyCart, priceCart, salePayload, settle, type CartLine } from './cart.ts';

const product = (over: Partial<Product> = {}): Product => ({
  product_id: 'p1', name: 'Panadol 500mg Tablet', name_ur: null, strength: '500mg', dosage_form: 'tablet', generic: 'Paracetamol',
  manufacturer: 'Haleon', rack: null, is_controlled: false, rx_required: false, max_qty_per_sale: null, barcode_unit_id: null,
  stock_base: 300, nearest_expiry: '2027-01-01',
  units: [
    { product_unit_id: 'box', unit: 'box', unit_name: 'Box', unit_name_ur: null, factor: 200, price: 38000 },
    { product_unit_id: 'strip', unit: 'strip', unit_name: 'Strip', unit_name_ur: null, factor: 10, price: 1900 },
    { product_unit_id: 'tab', unit: 'tablet', unit_name: 'Tablet', unit_name_ur: null, factor: 1, price: 190 },
  ],
  ...over,
});
const batch = (id: string, expiry: string, qty: number, stripPrice = 1900): Batch =>
  ({ batch_id: id, batch_number: id.toUpperCase(), expiry_date: expiry, qty_base: qty, prices: { box: stripPrice * 20, strip: stripPrice, tab: stripPrice / 10 } });
const line = (over: Partial<CartLine> = {}): CartLine => ({
  key: 'k', product: product(), unitId: 'strip', qty: 3, batches: [batch('b2', '2027-06-01', 200), batch('b1', '2026-12-01', 15)],
  priceOverride: null, discountPct: 0, ...over,
});

describe('cart', () => {
  it('sells from the batch that expires first, whole strips only', () => {
    // b1 has 15 tablets = 1 whole strip; the other 2 strips come from b2.
    expect(allocate(line()).allocations.map((a) => [a.batchId, a.qty])).toEqual([['b1', 1], ['b2', 2]]);
  });

  it('says what the shelf cannot cover', () => {
    expect(allocate(line({ qty: 30 })).short).toBe(9);
    expect(priceCart({ ...emptyCart(), lines: [line({ qty: 30 })] }, 100).problems[0]).toContain('only 21 Strip');
  });

  it('uses each batch\'s own price', () => {
    const l = line({ batches: [batch('b1', '2026-12-01', 10, 1800), batch('b2', '2027-06-01', 200, 1900)] });
    expect(priceCart({ ...emptyCart(), lines: [l] }, 0).bill!.grandTotal).toBe(1800 + 2 * 1900);
  });

  it('applies line discount %, bill discount and Re 1 rounding', () => {
    const p = priceCart({ ...emptyCart(), lines: [line({ qty: 2, discountPct: 10 })], billDiscount: 150 }, 100);
    // 2 x 19.00 = 38.00, less 10% = 34.20, less Rs 1.50 = 32.70, rounded to 33.00
    expect(p.bill).toMatchObject({ discountTotal: 380 + 150, grandTotal: 3300, rounding: 30 });
  });

  it('cash: change from the amount received; card: the exact total', () => {
    const cart = { ...emptyCart(), lines: [line({ qty: 2 })], cashReceived: 5000 };
    expect(settle(cart, 3800)).toMatchObject({ change: 1200, udhaar: 0 });
    expect(settle({ ...cart, method: 'jazzcash' }, 3800)).toMatchObject({ change: 0, paidTotal: 3800 });
  });

  it('a customer paying nothing now: all on khata', () => {
    const cart = { ...emptyCart(), lines: [line({ qty: 2 })],
      customer: { customer_id: 'c', account_id: 'a', account_number: 'C-1', name: 'Khan', name_ur: null, phone: null, can_buy_on_account: true,
                  udhaar_status: 'allowed' as const, available_credit: 100000 } };
    expect(settle(cart, 3800)).toMatchObject({ udhaar: 3800, paidTotal: 0 });
  });

  it('builds one sale line per batch for the server', () => {
    const cart = { ...emptyCart(), lines: [line()] };
    const p = priceCart(cart, 100);
    let n = 0;
    const s = salePayload(cart, p, settle(cart, p.bill!.grandTotal), { saleId: 's', seq: 7, drawerSessionId: 'd' }, {}, () => `l${n++}`);
    expect(s.lines.map((l) => [l.batch_id, l.qty, l.unit_price])).toEqual([['b1', 1, 1900], ['b2', 2, 1900]]);
    expect(s.grand_total).toBe(5700);
    expect(s.payments).toEqual([{ method: 'cash', tendered: 5700 }]);
  });
});
