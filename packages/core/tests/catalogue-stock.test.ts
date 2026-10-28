import { describe, expect, it } from 'vitest';
import { buildImportRows, chunk, parseCsv, parseMoneyToMinor, suggestMapping } from '../src/catalogue.ts';
import { describeQuantity, expiryBucket, toBaseQuantity } from '../src/stock.ts';

describe('CSV', () => {
  it('reads quotes, escaped quotes, CRLF and a BOM', () => {
    const text = '﻿Name,Company,Price\r\n"Panadol, 500mg",GSK,"Rs 1,250.00"\r\n"Say ""Hi""",X,5\r\n\r\n';
    expect(parseCsv(text)).toEqual([
      ['Name', 'Company', 'Price'],
      ['Panadol, 500mg', 'GSK', 'Rs 1,250.00'],
      ['Say "Hi"', 'X', '5'],
    ]);
  });

  it('detects semicolon and tab separated files', () => {
    expect(parseCsv('a;b\n1;2')).toEqual([['a', 'b'], ['1', '2']]);
    expect(parseCsv('a\tb\n1\t2')).toEqual([['a', 'b'], ['1', '2']]);
  });
});

describe('column mapping', () => {
  it('guesses common distributor headers', () => {
    const m = suggestMapping(['Item Name', 'Salt', 'Company', 'MRP', 'Bar Code', 'Tablets per strip', 'Rack No']);
    expect(m).toMatchObject({ brand_name: 0, generic: 1, manufacturer: 2, retail_price: 3, barcode: 4,
                              units_per_strip: 5, rack: 6 });
  });

  it('never maps one column twice', () => {
    const m = suggestMapping(['Name', 'Name']);
    expect(m.brand_name).toBe(0);
    expect(Object.values(m).filter((v) => v === 0)).toHaveLength(1);
  });
});

describe('money from text', () => {
  it('converts rupee text to paisa', () => {
    expect(parseMoneyToMinor('Rs 1,234.50')).toBe(123450);
    expect(parseMoneyToMinor('1234.5')).toBe(123450);
    expect(parseMoneyToMinor('PKR 12')).toBe(1200);
    expect(parseMoneyToMinor('  ')).toBeNull();
  });

  it('refuses ambiguous values', () => {
    expect(() => parseMoneyToMinor('12.345')).toThrow(/decimals/);
    expect(() => parseMoneyToMinor('twelve')).toThrow();
  });
});

describe('building import rows', () => {
  const headers = ['Name', 'Generic', 'Strength', 'Company', 'Tabs per strip', 'Strips per box', 'Price', 'Controlled'];
  const mapping = suggestMapping(headers);

  it('builds the unit ladder and price unit', () => {
    const { rows, problems } = buildImportRows(
      [['Panadol', 'Paracetamol', '500 mg', 'GSK', '10', '20', 'Rs 25.00', 'no']],
      mapping,
      { priceIsPer: 'strip' },
    );
    expect(problems).toEqual([]);
    expect(rows[0]).toEqual({
      brand_name: 'Panadol', generic: 'Paracetamol', strength: '500 mg', manufacturer: 'GSK',
      base_unit: 'tablet', units: [{ unit: 'strip', factor: 10 }, { unit: 'box', factor: 200 }],
      retail_price: 2500, retail_unit: 'strip', is_controlled: false,
    });
  });

  it('reports bad rows by number and keeps the good ones', () => {
    const { rows, problems } = buildImportRows(
      [['', 'x'], ['Good', '', '', '', '', '', '10'], ['Bad price', '', '', '', '', '', 'ten'],
       ['Bad flag', '', '', '', '', '', '', 'maybe']],
      mapping,
    );
    expect(rows.map((r) => r.brand_name)).toEqual(['Good']);
    expect(problems.map((p) => p.row)).toEqual([1, 3, 4]);
  });

  it('refuses a strip price when no strip size is given', () => {
    const { problems } = buildImportRows([['A', '', '', '', '', '', '10']], mapping, { priceIsPer: 'strip' });
    expect(problems[0]?.error).toMatch(/no strip size/);
  });

  it('splits big files into 10,000-row calls', () => {
    expect(chunk(Array.from({ length: 25_001 }, (_, i) => i)).map((c) => c.length)).toEqual([10_000, 10_000, 5_001]);
  });
});

describe('stock helpers', () => {
  it('puts batches in the same expiry buckets as the dashboard', () => {
    const today = '2026-10-28';
    expect(expiryBucket('2026-10-27', today)).toBe('expired');
    expect(expiryBucket('2026-10-28', today)).toBe('within_30');
    expect(expiryBucket('2026-11-27', today)).toBe('within_30');
    expect(expiryBucket('2026-11-28', today)).toBe('within_60');
    expect(expiryBucket('2027-01-26', today)).toBe('within_90');
    expect(expiryBucket('2027-01-27', today)).toBe('later');
  });

  it('shows quantities the way staff count them', () => {
    const ladder = [{ code: 'strip', factor: 10 }, { code: 'box', factor: 100 }];
    expect(describeQuantity(254, ladder, 'tablet')).toBe('2 box + 5 strip + 4 tablet');
    expect(describeQuantity(200, ladder, 'tablet')).toBe('2 box');
    expect(describeQuantity(-7, ladder, 'tablet')).toBe('-7 tablet');
    expect(describeQuantity(0, ladder, 'tablet')).toBe('0 tablet');
    expect(toBaseQuantity(3, 10)).toBe(30);
  });
});
