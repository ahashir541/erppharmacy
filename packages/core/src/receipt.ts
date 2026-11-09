// The printed bill. Same data as public.get_receipt (never any cost or profit), laid out for 58 mm
// (32 characters) and 80 mm (48 characters) thermal printers, then turned into ESC/POS bytes.
import { formatMoney } from './money.ts';

export interface ReceiptData {
  pharmacy: string;
  branch: { name: string; address?: string | null; phone?: string | null };
  invoiceNumber: string;
  soldAt: string;              // already in the branch's time zone, e.g. "28-10-2026 14:05"
  cashier?: string | null;
  customer?: string | null;
  lines: Array<{ name: string; strength?: string | null; unit: string; qty: number; unitPrice: number; discount: number; lineTotal: number; batch?: string | null; expiry?: string | null }>;
  discountTotal: number;
  taxTotal: number;
  rounding: number;
  grandTotal: number;
  payments: Array<{ method: string; amount: number }>;
  change: number;
  udhaar: number;
  taxInvoiceNumber?: string | null;   // FBR / SRB number, when integrated
  taxPending?: boolean;               // "pending FBR" while offline
  footer?: string | null;
}

export type PaperWidth = 58 | 80;

const COLUMNS: Record<PaperWidth, number> = { 58: 32, 80: 48 };
const METHOD_LABEL: Record<string, string> = {
  cash: 'Cash', card: 'Card', jazzcash: 'JazzCash', easypaisa: 'Easypaisa', bank_transfer: 'Bank transfer', loyalty: 'Points',
};

const money = (m: number) => formatMoney(m, { symbol: '' });

function center(text: string, width: number): string {
  const t = text.slice(0, width);
  return ' '.repeat(Math.floor((width - t.length) / 2)) + t;
}

/** "Label ....... value", the value right-aligned. */
function pair(label: string, value: string, width: number): string {
  const room = width - value.length - 1;
  const l = label.length > room ? label.slice(0, room) : label;
  return l + ' '.repeat(width - l.length - value.length) + value;
}

function wrap(text: string, width: number): string[] {
  const out: string[] = [];
  let line = '';
  for (const word of text.split(/\s+/).filter(Boolean)) {
    if (!line) line = word.slice(0, width);
    else if (line.length + 1 + word.length <= width) line += ` ${word}`;
    else { out.push(line); line = word.slice(0, width); }
  }
  if (line) out.push(line);
  return out;
}

export function formatReceipt(r: ReceiptData, paper: PaperWidth = 80): string[] {
  const w = COLUMNS[paper];
  const rule = '-'.repeat(w);
  const out: string[] = [];
  out.push(...wrap(r.pharmacy.toUpperCase(), w).map((l) => center(l, w)));
  out.push(center(r.branch.name, w));
  if (r.branch.address) out.push(...wrap(r.branch.address, w).map((l) => center(l, w)));
  if (r.branch.phone) out.push(center(`Tel ${r.branch.phone}`, w));
  out.push(rule);
  out.push(pair('Bill', r.invoiceNumber, w));
  out.push(pair('Date', r.soldAt, w));
  if (r.cashier) out.push(pair('Served by', r.cashier, w));
  if (r.customer) out.push(pair('Customer', r.customer, w));
  out.push(rule);
  for (const l of r.lines) {
    out.push(...wrap([l.name, l.strength].filter(Boolean).join(' '), w));
    out.push(pair(`  ${l.qty} ${l.unit} x ${money(l.unitPrice)}`, money(l.qty * l.unitPrice), w));
    if (l.discount) out.push(pair('  Discount', `-${money(l.discount)}`, w));
    if (l.batch) out.push(`  Batch ${l.batch}${l.expiry ? `  Exp ${l.expiry}` : ''}`.slice(0, w));
  }
  out.push(rule);
  if (r.discountTotal) out.push(pair('Discount', `-${money(r.discountTotal)}`, w));
  if (r.taxTotal) out.push(pair('Sales tax (included)', money(r.taxTotal), w));
  if (r.rounding) out.push(pair('Rounding', `${r.rounding > 0 ? '+' : '-'}${money(Math.abs(r.rounding))}`, w));
  out.push(pair('TOTAL Rs', money(r.grandTotal), w));
  for (const p of r.payments) out.push(pair(METHOD_LABEL[p.method] ?? p.method, money(p.amount), w));
  if (r.change) out.push(pair('Change', money(r.change), w));
  if (r.udhaar) {
    out.push(rule);
    out.push(center('*** CREDIT (UDHAAR) ***', w));
    out.push(pair('On account', money(r.udhaar), w));
  }
  out.push(rule);
  if (r.taxInvoiceNumber) out.push(pair('FBR invoice', r.taxInvoiceNumber, w));
  else if (r.taxPending) out.push(center('FBR: pending (sent when online)', w));
  out.push(...wrap(r.footer ?? 'Thank you. Medicines once sold are returned only with this bill.', w).map((l) => center(l, w)));
  return out;
}

/** ESC/POS commands for a receipt printer: initialise, text, feed, cut, optional cash drawer kick. */
export function toEscPos(lines: string[], opts: { cut?: boolean; openDrawer?: boolean } = {}): Uint8Array {
  const bytes: number[] = [0x1b, 0x40]; // ESC @: reset
  for (const line of lines) {
    // Thermal printers' built-in fonts are ASCII; anything else is replaced (Urdu prints as an image, later).
    for (const ch of line) bytes.push(ch.charCodeAt(0) < 128 ? ch.charCodeAt(0) : 0x3f);
    bytes.push(0x0a);
  }
  bytes.push(0x1b, 0x64, 0x04); // ESC d 4: feed 4 lines
  if (opts.cut ?? true) bytes.push(0x1d, 0x56, 0x42, 0x00); // GS V B 0: partial cut
  if (opts.openDrawer) bytes.push(0x1b, 0x70, 0x00, 0x19, 0xfa); // ESC p 0: pulse drawer pin 2
  return Uint8Array.from(bytes);
}
