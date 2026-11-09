// The bill. Same algorithm as app.price_bill / app.settle_payments in SQL
// (a parity test checks both on thousands of random bills), so the receipt
// the counter prints offline is exactly what the server records.
//
// Per line: gross = qty x unit price; discount = line discount + its share of
// the bill discount; net = gross - discount; tax is inside net when prices
// include tax (D19), else added on top; rounding applies to the bill (D17).
import { assertMinor, divRoundHalfUp, roundBillTotal } from './money.ts';

export interface BillLineInput {
  qty: number;            // in the unit sold (strip, tablet, ...)
  unitPrice: number;      // minor units per that unit
  lineDiscount?: number;  // minor units
  taxRateBp?: number;     // 1800 = 18%
}

export interface BillLine {
  gross: number;
  discount: number;
  net: number;
  tax: number;
  lineTotal: number;
}

export interface Bill {
  lines: BillLine[];
  grossTotal: number;
  subtotal: number;        // grand - rounding + discounts - tax (excludes tax)
  discountTotal: number;
  discountBp: number;      // discount as basis points of gross (for the discount limit)
  taxTotal: number;
  rounding: number;
  grandTotal: number;
}

export function priceBill(
  inputs: BillLineInput[],
  opts: { billDiscount?: number; pricesIncludeTax: boolean; roundingStep: number },
): Bill {
  const billDiscount = opts.billDiscount ?? 0;
  assertMinor(billDiscount, 'bill discount');
  if (billDiscount < 0) throw new RangeError('bill discount cannot be negative');

  const gross = inputs.map((l) => {
    if (!Number.isSafeInteger(l.qty) || l.qty <= 0) throw new RangeError('quantity must be a whole number above 0');
    assertMinor(l.unitPrice, 'unit price');
    if (l.unitPrice < 0) throw new RangeError('unit price cannot be negative');
    return l.qty * l.unitPrice;
  });
  const afterLine = inputs.map((l, i) => {
    const d = l.lineDiscount ?? 0;
    assertMinor(d, 'line discount');
    if (d < 0 || d > gross[i]!) throw new RangeError('line discount must be between 0 and the line amount');
    return gross[i]! - d;
  });
  const base = afterLine.reduce((a, b) => a + b, 0);
  if (billDiscount > base) throw new RangeError('bill discount is more than the bill');

  // Bill discount shared in proportion; leftover paisa go to the biggest
  // lines first (ties: earlier line), never beyond what a line can take.
  const share = afterLine.map((a) => (base === 0 ? 0 : Math.floor((billDiscount * a) / base)));
  let left = billDiscount - share.reduce((a, b) => a + b, 0);
  const order = afterLine.map((a, i) => i).sort((x, y) => afterLine[y]! - afterLine[x]! || x - y);
  while (left > 0) {
    for (const i of order) {
      if (left === 0) break;
      if (share[i]! < afterLine[i]!) {
        share[i]! += 1;
        left -= 1;
      }
    }
  }

  const lines = inputs.map((l, i): BillLine => {
    const discount = (l.lineDiscount ?? 0) + share[i]!;
    const net = gross[i]! - discount;
    const r = l.taxRateBp ?? 0;
    if (!Number.isSafeInteger(r) || r < 0 || r > 10000) throw new RangeError('tax rate out of range');
    const tax = opts.pricesIncludeTax ? divRoundHalfUp(net * r, 10000 + r) : divRoundHalfUp(net * r, 10000);
    return { gross: gross[i]!, discount, net, tax, lineTotal: opts.pricesIncludeTax ? net : net + tax };
  });

  const sumLines = lines.reduce((a, l) => a + l.lineTotal, 0);
  const { total: grandTotal, adjustment: rounding } = roundBillTotal(sumLines, opts.roundingStep);
  const grossTotal = gross.reduce((a, b) => a + b, 0);
  const discountTotal = lines.reduce((a, l) => a + l.discount, 0);
  const taxTotal = lines.reduce((a, l) => a + l.tax, 0);
  return {
    lines,
    grossTotal,
    subtotal: grandTotal - rounding + discountTotal - taxTotal,
    discountTotal,
    discountBp: grossTotal === 0 ? 0 : divRoundHalfUp(discountTotal * 10000, grossTotal),
    taxTotal,
    rounding,
    grandTotal,
  };
}

export type PaymentMethod = 'cash' | 'card' | 'jazzcash' | 'easypaisa' | 'bank_transfer' | 'loyalty';

export interface PaymentInput {
  method: PaymentMethod;
  amount?: number;      // non-cash: amount paid
  tendered?: number;    // cash: what the customer handed over
}

export interface Settlement {
  payments: { method: PaymentMethod; amount: number; tendered: number | null }[];
  paidTotal: number;    // excludes udhaar
  cashApplied: number;
  change: number;
  udhaar: number;       // left unpaid, goes to the customer's khata
}

/** Split payment: non-cash first, then cash; whatever is left is udhaar. */
export function settlePayments(grandTotal: number, inputs: PaymentInput[]): Settlement {
  assertMinor(grandTotal, 'grand total');
  const nonCash = inputs.filter((p) => p.method !== 'cash');
  const cash = inputs.filter((p) => p.method === 'cash');
  if (cash.length > 1) throw new RangeError('one cash payment per bill');
  let nonCashTotal = 0;
  for (const p of nonCash) {
    assertMinor(p.amount ?? NaN, `${p.method} amount`);
    if (p.amount! <= 0) throw new RangeError(`${p.method} amount must be above 0`);
    nonCashTotal += p.amount!;
  }
  if (nonCashTotal > grandTotal) throw new RangeError('card / wallet payments are more than the bill');
  const due = grandTotal - nonCashTotal;
  const tendered = cash[0]?.tendered ?? 0;
  assertMinor(tendered, 'cash tendered');
  if (tendered < 0) throw new RangeError('cash cannot be negative');
  const cashApplied = Math.min(tendered, due);
  const payments: Settlement['payments'] = nonCash.map((p) => ({ method: p.method, amount: p.amount!, tendered: null }));
  if (cashApplied > 0) payments.push({ method: 'cash', amount: cashApplied, tendered });
  return {
    payments,
    paidTotal: nonCashTotal + cashApplied,
    cashApplied,
    change: tendered - cashApplied,
    udhaar: due - cashApplied,
  };
}
