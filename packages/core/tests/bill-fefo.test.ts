import { describe, expect, it } from 'vitest';
import { priceBill, settlePayments } from '../src/bill.ts';
import { allocateFefo } from '../src/fefo.ts';

describe('bill', () => {
  it('prices a simple cash bill with tax-inclusive prices and Re 1 rounding', () => {
    const bill = priceBill([{ qty: 4, unitPrice: 250 }, { qty: 1, unitPrice: 12_550, taxRateBp: 1800 }], { pricesIncludeTax: true, roundingStep: 100 });
    expect(bill.grossTotal).toBe(13_550);
    expect(bill.lines[1]!.tax).toBe(1914); // 12,550 x 18/118
    expect(bill.grandTotal).toBe(13_600); // 135.50 rounds up to 136
    expect(bill.rounding).toBe(50);
    expect(bill.subtotal + bill.taxTotal - bill.discountTotal + bill.rounding).toBe(bill.grandTotal);
  });

  it('adds tax on top when prices exclude it', () => {
    const bill = priceBill([{ qty: 1, unitPrice: 10_000, taxRateBp: 1800 }], { pricesIncludeTax: false, roundingStep: 0 });
    expect(bill.grandTotal).toBe(11_800);
  });

  it('shares a bill discount in proportion, to the paisa', () => {
    const bill = priceBill([{ qty: 1, unitPrice: 10_000 }, { qty: 1, unitPrice: 20_000 }, { qty: 1, unitPrice: 1 }], {
      billDiscount: 1001, pricesIncludeTax: true, roundingStep: 0,
    });
    expect(bill.lines.map((l) => l.discount)).toEqual([333, 668, 0]);
    expect(bill.discountTotal).toBe(1001);
    expect(bill.discountBp).toBe(334); // 3.34% of gross, for the discount limit
  });

  it('refuses impossible discounts and bad quantities', () => {
    expect(() => priceBill([{ qty: 1, unitPrice: 100, lineDiscount: 101 }], { pricesIncludeTax: true, roundingStep: 0 })).toThrow();
    expect(() => priceBill([{ qty: 1, unitPrice: 100 }], { billDiscount: 101, pricesIncludeTax: true, roundingStep: 0 })).toThrow();
    expect(() => priceBill([{ qty: 0, unitPrice: 100 }], { pricesIncludeTax: true, roundingStep: 0 })).toThrow();
  });
});

describe('payments', () => {
  it('Rs 3,000 bill: Rs 1,000 cash, the rest udhaar (brief example)', () => {
    expect(settlePayments(300_000, [{ method: 'cash', tendered: 100_000 }])).toMatchObject({ cashApplied: 100_000, change: 0, udhaar: 200_000, paidTotal: 100_000 });
  });
  it('split payment with change from cash only', () => {
    const s = settlePayments(250_000, [{ method: 'jazzcash', amount: 100_000 }, { method: 'cash', tendered: 200_000 }]);
    expect(s).toMatchObject({ cashApplied: 150_000, change: 50_000, udhaar: 0, paidTotal: 250_000 });
    expect(s.payments).toEqual([{ method: 'jazzcash', amount: 100_000, tendered: null }, { method: 'cash', amount: 150_000, tendered: 200_000 }]);
  });
  it('refuses card payments above the bill', () => {
    expect(() => settlePayments(100, [{ method: 'card', amount: 101 }])).toThrow();
  });
});

describe('FEFO', () => {
  const today = '2026-10-28';
  const b = (batchId: string, expiryDate: string, qtyBase: number, blocked = false) => ({ batchId, expiryDate, qtyBase, blocked });
  it('sells the batch expiring first, then the next', () => {
    expect(allocateFefo([b('late', '2027-06-01', 50), b('soon', '2026-12-01', 3)], 5, today)).toEqual({
      allocations: [{ batchId: 'soon', qtyBase: 3 }, { batchId: 'late', qtyBase: 2 }], shortBy: 0,
    });
  });
  it('never offers expired or blocked batches', () => {
    expect(allocateFefo([b('old', '2026-10-27', 10), b('recall', '2027-01-01', 10, true), b('ok', '2027-02-01', 1)], 3, today)).toEqual({
      allocations: [{ batchId: 'ok', qtyBase: 1 }], shortBy: 2,
    });
  });
});
