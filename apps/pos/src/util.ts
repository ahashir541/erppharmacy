import { formatMoney, parseMoneyToMinor } from '@medflow/core';

export const rs = (paisa: number | null | undefined) => (paisa === null || paisa === undefined ? '—' : formatMoney(paisa, { symbol: 'Rs' }));
/** "Rs 1,250" when there are no paisa, else "Rs 1,250.50". */
export const rsShort = (paisa: number) => rs(paisa).replace(/\.00$/, '');
export const toPaisa = (text: string): number | null => {
  const v = parseMoneyToMinor(text);
  return v === null || v < 0 ? null : v;
};
export const uuid = () => crypto.randomUUID();
export const shortDate = (iso: string | null | undefined) => {
  if (!iso) return '';
  const [y, m, d] = iso.slice(0, 10).split('-');
  return `${d}/${m}/${y!.slice(2)}`;
};
export function errorText(err: unknown): string {
  const m = (err as Error)?.message ?? String(err);
  return m.replace(/^error:\s*/i, '');
}
