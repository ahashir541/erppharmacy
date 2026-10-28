// Money is always an integer number of minor units (paisa for PKR). Never a
// float. Division goes through BigInt so it is exact, then rounds once.

export function assertMinor(value: number, label = 'amount'): void {
  if (!Number.isSafeInteger(value)) {
    throw new RangeError(`${label} must be a whole number of minor units, got ${value}`);
  }
}

/** numerator / denominator rounded half away from zero (exact). */
export function divRoundHalfUp(numerator: number, denominator: number): number {
  assertMinor(numerator, 'numerator');
  assertMinor(denominator, 'denominator');
  if (denominator === 0) throw new RangeError('division by zero');
  let n = BigInt(numerator);
  let d = BigInt(denominator);
  if (d < 0n) {
    n = -n;
    d = -d;
  }
  const negative = n < 0n;
  const abs = negative ? -n : n;
  const q = (abs * 2n + d) / (2n * d);
  return Number(negative ? -q : q);
}

/**
 * Price of a smaller unit derived from a pack price (D17): pack price ×
 * (unit factor ÷ pack factor), rounded half-up to the minor unit. An explicit
 * owner-set unit price, when there is one, is used instead of this.
 */
export function derivedUnitPrice(packPrice: number, packFactor: number, unitFactor: number): number {
  assertMinor(packPrice, 'pack price');
  if (!Number.isSafeInteger(packFactor) || packFactor <= 0) throw new RangeError('pack factor must be > 0');
  if (!Number.isSafeInteger(unitFactor) || unitFactor <= 0) throw new RangeError('unit factor must be > 0');
  return divRoundHalfUp(packPrice * unitFactor, packFactor);
}

/**
 * Round a bill total to the nearest step (D17: setting pos.bill_rounding_minor,
 * default 100 = Re 1). Halves round up. A step of 0 or 1 means no rounding.
 */
export function roundBillTotal(total: number, stepMinor: number): { total: number; adjustment: number } {
  assertMinor(total, 'total');
  assertMinor(stepMinor, 'rounding step');
  if (stepMinor <= 1) return { total, adjustment: 0 };
  const rounded = divRoundHalfUp(total, stepMinor) * stepMinor;
  return { total: rounded, adjustment: rounded - total };
}

export interface FormatMoneyOptions {
  minorUnits?: number;          // 2 for PKR
  grouping?: 'lakh' | 'international';
  symbol?: string;              // 'Rs'
}

/** 12345650 -> "Rs 1,23,456.50" (lakh) or "Rs 123,456.50" (international). */
export function formatMoney(minor: number, opts: FormatMoneyOptions = {}): string {
  assertMinor(minor);
  const { minorUnits = 2, grouping = 'lakh', symbol = 'Rs' } = opts;
  const negative = minor < 0;
  const digits = String(Math.abs(minor)).padStart(minorUnits + 1, '0');
  const whole = minorUnits > 0 ? digits.slice(0, -minorUnits) : digits;
  const fraction = minorUnits > 0 ? digits.slice(-minorUnits) : '';
  const grouped = grouping === 'lakh' ? groupLakh(whole) : whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const body = fraction ? `${grouped}.${fraction}` : grouped;
  return `${negative ? '-' : ''}${symbol ? `${symbol} ` : ''}${body}`;
}

function groupLakh(whole: string): string {
  if (whole.length <= 3) return whole;
  const last3 = whole.slice(-3);
  const rest = whole.slice(0, -3).replace(/\B(?=(\d{2})+(?!\d))/g, ',');
  return `${rest},${last3}`;
}
