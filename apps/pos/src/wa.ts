// WhatsApp without a WhatsApp Business account: Nuskha writes the message and opens WhatsApp
// (the app, WhatsApp Web, or wa.me which offers both) with it ready; the person presses Send.
// The same on Nuskha Local and Nuskha Cloud.
import type { ReceiptData } from '@medflow/core';
import { rsShort } from './util.ts';

export type WaLang = 'ur' | 'roman' | 'en';
export type WaMode = 'link' | 'web' | 'app';

/** 0300-1234567, +92 300 1234567, 3001234567 → 923001234567. Null if it is not a mobile number. */
export function waPhone(raw: string | null | undefined): string | null {
  let n = (raw ?? '').replace(/\D/g, '');
  if (!n) return null;
  if (n.startsWith('00')) n = n.slice(2);
  if (n.startsWith('03') && n.length === 11) n = `92${n.slice(1)}`;
  else if (n.startsWith('3') && n.length === 10) n = `92${n}`;
  return /^\d{10,15}$/.test(n) ? n : null;
}

const MODE_KEY = 'nuskha.whatsapp.open';
export function waMode(): WaMode {
  try { const v = localStorage.getItem(MODE_KEY); return v === 'web' || v === 'app' ? v : 'link'; } catch { return 'link'; }
}
export function setWaMode(m: WaMode) { try { localStorage.setItem(MODE_KEY, m); } catch { /* private window */ } }

export function waUrl(phone: string, text: string, mode: WaMode = waMode()): string {
  const t = encodeURIComponent(text);
  if (mode === 'web') return `https://web.whatsapp.com/send?phone=${phone}&text=${t}`;
  if (mode === 'app') return `whatsapp://send?phone=${phone}&text=${t}`;
  return `https://wa.me/${phone}?text=${t}`;
}

/** Opens WhatsApp with the message. Call it straight from the click, before any await. */
export function openWa(phone: string, text: string) {
  const url = waUrl(phone, text);
  if (url.startsWith('whatsapp:')) window.location.href = url;
  else window.open(url, '_blank', 'noopener');
}

export const fill = (tpl: string, vars: Record<string, string | number>) =>
  tpl.replace(/\{(\w+)\}/g, (m, k: string) => (k in vars ? String(vars[k]) : m)).replace(/\n{3,}/g, '\n\n').trim();

export const waDate = (iso: string | null | undefined) =>
  (iso ? new Date(`${String(iso).slice(0, 10)}T00:00:00`).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }) : '');
export const amt = (paisa: number | string | null | undefined) => rsShort(Number(paisa ?? 0));

/** The line under every message: the pharmacy and its WhatsApp number. */
export const signature = (pharmacy: string, number: string | null | undefined) => (number ? `${pharmacy} · ${number}` : pharmacy);

export const DEFAULTS: Record<'udhaar' | 'receipt' | 'refill', Record<WaLang, string>> = {
  udhaar: {
    ur: 'السلام علیکم {name}،\n{pharmacy} میں آپ کے کھاتے میں {amount} باقی ہیں، جو {days} دن سے ہیں ({since} سے)۔\nمہربانی فرما کر جلد ادائیگی کر دیں۔ شکریہ!\n{sign}',
    roman: 'Assalam-o-Alaikum {name},\n{pharmacy} mein aap ke khaate mein {amount} baqi hain, jo {days} din se hain ({since} se).\nMehrbani kar ke jald ada kar dein. Shukriya!\n{sign}',
    en: 'Assalam-o-Alaikum {name},\nA reminder from {pharmacy}: {amount} is due on your account, for {days} days (since {since}).\nPlease clear it at your earliest. Thank you!\n{sign}',
  },
  receipt: {
    ur: 'السلام علیکم {name}،\n{pharmacy} کو آپ کی طرف سے {paid} موصول ہو گئے ({date})۔ شکریہ!\nباقی ادھار: {balance}\n{sign}',
    roman: 'Assalam-o-Alaikum {name},\n{pharmacy} ko aap ki taraf se {paid} mil gaye ({date}). Shukriya!\nBaqi udhaar: {balance}\n{sign}',
    en: 'Assalam-o-Alaikum {name},\n{pharmacy} has received {paid} from you on {date}. Thank you!\nRemaining balance: {balance}\n{sign}',
  },
  refill: {
    ur: 'السلام علیکم {name}،\nآپ کی دوا {medicine} ختم ہونے والی ہوگی۔ دوبارہ لینے کے لیے {pharmacy} تشریف لائیں یا اسی نمبر پر میسج کر دیں۔\n{sign}',
    roman: 'Assalam-o-Alaikum {name},\nAap ki dawa {medicine} khatam hone wali hogi. Dobara lene ke liye {pharmacy} tashreef laayein ya isi number par message kar dein.\n{sign}',
    en: 'Assalam-o-Alaikum {name},\nYour medicine {medicine} may be running out. Visit {pharmacy} for a refill, or message us on this number.\n{sign}',
  },
};

const L = {
  order: { ur: 'آرڈر', roman: 'Order', en: 'Order request' },
  send: { ur: 'مہربانی فرما کر یہ ادویات بھیج دیں:', roman: 'Mehrbani kar ke ye dawaiyan bhej dein:', en: 'Please send the following:' },
  have: { ur: 'موجود', roman: 'stock', en: 'in stock' },
  sales: { ur: 'فروخت', roman: 'Sale', en: 'Sales' },
  bills: { ur: 'بل', roman: 'bills', en: 'bills' },
  profit: { ur: 'منافع', roman: 'Munafa', en: 'Profit' },
  given: { ur: 'آج ادھار دیا', roman: 'Aaj udhaar diya', en: 'Udhaar given today' },
  got: { ur: 'آج ادھار وصول', roman: 'Aaj udhaar wasool', en: 'Udhaar collected today' },
  cash: { ur: 'دراز میں کیش', roman: 'Drawer mein cash', en: 'Cash in drawers' },
  owed: { ur: 'کل ادھار باقی', roman: 'Kul udhaar baqi', en: 'Total udhaar to collect' },
  low: { ur: 'کم اسٹاک', roman: 'Kam stock', en: 'Low stock' },
  items: { ur: 'ادویات', roman: 'items', en: 'items' },
  exp: { ur: '90 دن میں ایکسپائری (قیمت خرید)', roman: '90 din mein expiry (cost)', en: 'Expiring in 90 days (cost)' },
  due: { ur: 'ادھار یاد دہانیاں باقی', roman: 'Udhaar reminders baqi', en: 'Udhaar reminders due' },
  refills: { ur: 'ریفل باقی', roman: 'Refills baqi', en: 'Refills due' },
  summary: { ur: 'روزانہ حساب', roman: 'Roz ka hisaab', en: 'Daily summary' },
} as const;

export function reorderText(lang: WaLang, pharmacy: string, date: string, items: Array<{ name: string; stock: number; unit: string | null }>, sign: string) {
  return [`${pharmacy} — ${L.order[lang]} · ${waDate(date)}`, L.send[lang],
    ...items.map((x, i) => `${i + 1}. ${x.name}  (${L.have[lang]}: ${x.stock}${x.unit ? ` ${x.unit}` : ''})`), '', sign].join('\n');
}

export interface SummaryNumbers {
  sales: number; bills: number; profit?: number | null | undefined; given?: number | null | undefined; collected?: number | null | undefined; cash?: number | null | undefined;
  owed?: number | null | undefined; low: number; expiring?: number | null | undefined; remindersDue: number; refillsDue: number;
}
export function summaryText(lang: WaLang, pharmacy: string, date: string, n: SummaryNumbers) {
  const line = (k: keyof typeof L, v: string) => `• ${L[k][lang]}: ${v}`;
  return [`*${pharmacy} — ${L.summary[lang]}* · ${waDate(date)}`,
    line('sales', `${amt(n.sales)} (${n.bills} ${L.bills[lang]})`),
    n.profit !== undefined && n.profit !== null ? line('profit', amt(n.profit)) : '',
    line('given', amt(n.given)), line('got', amt(n.collected)), line('cash', amt(n.cash)), line('owed', amt(n.owed)),
    line('low', `${n.low} ${L.items[lang]}`), line('exp', amt(n.expiring)),
    line('due', String(n.remindersDue)), line('refills', String(n.refillsDue)), '', '— Nuskha'].filter((x) => x !== '').join('\n');
}

/** The bill a customer gets on WhatsApp from the counter (no cost or profit). */
export function billText(r: ReceiptData) {
  return [`*${r.pharmacy}* — ${r.branch.name}`, `Bill ${r.invoiceNumber} · ${r.soldAt}`, r.customer ? `${r.customer}` : '', '',
    ...r.lines.map((l) => `${l.name}${l.strength ? ` ${l.strength}` : ''} × ${l.qty} ${l.unit} — ${amt(l.lineTotal)}`), '',
    `*Total: ${amt(r.grandTotal)}*`, r.udhaar > 0 ? `Udhaar (khaata): ${amt(r.udhaar)}` : '',
    '', 'Shukriya · شکریہ', r.branch.phone ? `☎ ${r.branch.phone}` : ''].filter((x, i, a) => !(x === '' && a[i - 1] === '')).join('\n').trim();
}
