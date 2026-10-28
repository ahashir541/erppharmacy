// Stock helpers for screens: expiry buckets (same as the expiry_dashboard
// view) and pack quantities shown the way staff count them.

export type ExpiryBucket = 'expired' | 'within_30' | 'within_60' | 'within_90' | 'later';

/** Dates are 'YYYY-MM-DD' in the branch's time zone. */
export function expiryBucket(expiryDate: string, today: string): ExpiryBucket {
  const days = daysBetween(today, expiryDate);
  if (days < 0) return 'expired';
  if (days <= 30) return 'within_30';
  if (days <= 60) return 'within_60';
  if (days <= 90) return 'within_90';
  return 'later';
}

export function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);
}

export interface PackUnit {
  code: string;      // 'box'
  factor: number;    // base units in one of these
}

/** 254 tablets with box=100, strip=10 -> "2 box + 5 strip + 4 tablet". */
export function describeQuantity(qtyBase: number, ladder: PackUnit[], baseCode: string): string {
  if (!Number.isSafeInteger(qtyBase)) throw new RangeError('quantity must be whole');
  if (qtyBase === 0) return `0 ${baseCode}`;
  const sign = qtyBase < 0 ? '-' : '';
  let rest = Math.abs(qtyBase);
  const parts: string[] = [];
  for (const u of [...ladder].filter((u) => u.factor > 1).sort((a, b) => b.factor - a.factor)) {
    const n = Math.floor(rest / u.factor);
    if (n > 0) {
      parts.push(`${n} ${u.code}`);
      rest -= n * u.factor;
    }
  }
  if (rest > 0) parts.push(`${rest} ${baseCode}`);
  return sign + parts.join(' + ');
}

export function toBaseQuantity(qty: number, factor: number): number {
  if (!Number.isSafeInteger(qty) || qty < 0) throw new RangeError('quantity must be a whole number');
  if (!Number.isSafeInteger(factor) || factor < 1) throw new RangeError('pack factor must be at least 1');
  return qty * factor;
}
