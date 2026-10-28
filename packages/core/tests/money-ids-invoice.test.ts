import { describe, expect, it } from 'vitest';
import { uuidv7, uuidv7Timestamp } from '../src/ids.ts';
import { formatInvoiceNumber, parseInvoiceNumber } from '../src/invoice.ts';
import { derivedUnitPrice, divRoundHalfUp, formatMoney, roundBillTotal } from '../src/money.ts';

describe('money', () => {
  it('divides exactly and rounds half away from zero', () => {
    expect(divRoundHalfUp(10, 4)).toBe(3);    // 2.5 -> 3
    expect(divRoundHalfUp(9, 4)).toBe(2);     // 2.25 -> 2
    expect(divRoundHalfUp(-10, 4)).toBe(-3);
    expect(divRoundHalfUp(10, -4)).toBe(-3);
    expect(() => divRoundHalfUp(1, 0)).toThrow();
    expect(() => divRoundHalfUp(1.5, 2)).toThrow();
  });

  it('stays exact for very large amounts', () => {
    expect(divRoundHalfUp(9_007_199_254_740_991, 1)).toBe(9_007_199_254_740_991);
  });

  it('derives a loose tablet price from the strip price (D17)', () => {
    // Rs 125.00 strip of 10 tablets -> Rs 12.50 a tablet
    expect(derivedUnitPrice(12500, 10, 1)).toBe(1250);
    // Rs 100.00 strip of 3 -> Rs 33.33 a tablet (33.333 rounds down)
    expect(derivedUnitPrice(10000, 3, 1)).toBe(3333);
    // Rs 100.00 box of 100 tablets, sold by the strip of 10 -> Rs 10.00
    expect(derivedUnitPrice(10000, 100, 10)).toBe(1000);
  });

  it('rounds bill totals to the nearest rupee by default (D17)', () => {
    expect(roundBillTotal(123449, 100)).toEqual({ total: 123400, adjustment: -49 });
    expect(roundBillTotal(123450, 100)).toEqual({ total: 123500, adjustment: 50 });
    expect(roundBillTotal(123456, 0)).toEqual({ total: 123456, adjustment: 0 });
  });

  it('formats with lakh grouping', () => {
    expect(formatMoney(12345650)).toBe('Rs 1,23,456.50');
    expect(formatMoney(1234567890)).toBe('Rs 1,23,45,678.90');
    expect(formatMoney(5)).toBe('Rs 0.05');
    expect(formatMoney(-250000)).toBe('-Rs 2,500.00');
    expect(formatMoney(12345650, { grouping: 'international' })).toBe('Rs 123,456.50');
    expect(formatMoney(1500, { minorUnits: 0, symbol: '' })).toBe('1,500');
  });
});

describe('invoice numbers (D23)', () => {
  it('formats branch-counter-sequence with 6+ digits', () => {
    expect(formatInvoiceNumber('KHI1-C2', 451)).toBe('KHI1-C2-000451');
    expect(formatInvoiceNumber('KHI1-C2', 1_234_567)).toBe('KHI1-C2-1234567');
  });

  it('rejects bad input', () => {
    expect(() => formatInvoiceNumber('khi1-c2', 1)).toThrow();
    expect(() => formatInvoiceNumber('KHI1-C2', 0)).toThrow();
    expect(() => formatInvoiceNumber('KHI1-C2', 1.5)).toThrow();
  });

  it('parses back', () => {
    expect(parseInvoiceNumber('KHI1-C2-000451')).toEqual({ devicePrefix: 'KHI1-C2', sequence: 451 });
    expect(parseInvoiceNumber('garbage')).toBeNull();
  });
});

describe('UUIDv7', () => {
  it('is a valid v7 UUID carrying its timestamp', () => {
    const t = Date.UTC(2026, 9, 28, 10, 0, 0);
    const id = uuidv7(t);
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(uuidv7Timestamp(id)).toBe(t);
  });

  it('sorts by creation time', () => {
    const a = uuidv7(1000);
    const b = uuidv7(2000);
    expect(a < b).toBe(true);
  });
});
