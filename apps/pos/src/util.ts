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
const NOT_ALLOWED: Record<string, string> = {
  'sales.create': 'sell or open a shift at the counter',
  'cash.close_shift': 'close this shift',
  'cash.view': "close someone else's shift",
  'sales.discount': 'give this discount',
  'sales.edit_price': 'change the price',
  'sales.return': 'take a return',
  'sales.void': 'void a bill',
  'udhaar.give': 'give udhaar',
  'udhaar.check_status': 'sell on udhaar',
  'udhaar.receive_payment': 'receive udhaar payments',
  'prescriptions.confirm': 'confirm prescriptions',
  'controlled.dispense': 'sell controlled drugs',
};

export function errorText(err: unknown): string {
  const m = ((err as Error)?.message ?? String(err)).replace(/^error:\s*/i, '');
  // "Permission x is required" from the database, said in plain words with what to do.
  const p = /^Permission ([a-z_.]+) is required/.exec(m);
  if (p) return `Your role cannot ${NOT_ALLOWED[p[1]!] ?? `do this (${p[1]})`}. Ask the owner to change your role or limits in Team.`;
  // Older database messages still say MedFlow (the product's former name); people see Nuskha.
  return m.replace(/\bMedFlow\b/g, 'Nuskha');
}

/** The Demo Pharmacy (practice data), not a real pharmacy: shows the demo ribbon and demo PINs. */
export const isDemo = (ctx: { branch: { id: string } }) => ctx.branch.id === '0195f000-0000-7000-8000-000000000002';
