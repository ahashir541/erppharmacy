// Invoice numbers: <branch code>-<counter code>-<sequence> (D23), e.g.
// KHI1-C2-000451. The sequence is per device, never resets, and is padded to
// at least 6 digits. Two counters selling offline can never clash.
const PREFIX = /^[A-Z0-9]{2,8}-[A-Z0-9]{1,4}$/;
const NUMBER = /^([A-Z0-9]{2,8}-[A-Z0-9]{1,4})-(\d{6,})$/;

export function formatInvoiceNumber(devicePrefix: string, sequence: number): string {
  if (!PREFIX.test(devicePrefix)) {
    throw new RangeError(`Invalid device prefix: ${devicePrefix}`);
  }
  if (!Number.isSafeInteger(sequence) || sequence < 1) {
    throw new RangeError(`Invoice sequence must be a positive integer, got ${sequence}`);
  }
  return `${devicePrefix}-${String(sequence).padStart(6, '0')}`;
}

export function parseInvoiceNumber(invoiceNumber: string): { devicePrefix: string; sequence: number } | null {
  const m = NUMBER.exec(invoiceNumber);
  if (!m) return null;
  return { devicePrefix: m[1]!, sequence: Number(m[2]) };
}
