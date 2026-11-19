// Product import: CSV text -> rows -> column mapping -> the JSON rows that
// public.import_products accepts (max 10,000 per call). Excel files are read
// into the same string[][] shape by the web app before reaching this code.

export const IMPORT_FIELDS = [
  'brand_name', 'brand_name_ur', 'generic', 'strength', 'dosage_form', 'manufacturer', 'category',
  'barcode', 'base_unit', 'units_per_strip', 'strips_per_box', 'retail_price', 'rack',
  'reorder_level', 'min_stock', 'max_stock', 'is_controlled', 'rx_required',
  'stock_qty', 'stock_unit', 'batch_number', 'expiry_date', 'unit_cost',
] as const;
export type ImportField = (typeof IMPORT_FIELDS)[number];
export type ColumnMapping = Partial<Record<ImportField, number>>;

export interface ImportRow {
  brand_name: string;
  brand_name_ur?: string;
  generic?: string;
  strength?: string;
  dosage_form?: string;
  manufacturer?: string;
  category?: string;
  barcode?: string;
  base_unit: string;
  units: { unit: string; factor: number }[];
  retail_price?: number;
  retail_unit?: string;
  rack?: string;
  reorder_level?: number;
  min_stock?: number;
  max_stock?: number;
  is_controlled?: boolean;
  rx_required?: boolean;
  /** Stock already on the shelf (optional): becomes opening stock after the import. */
  stock?: { qty: number; unit: string; batch_number: string; expiry_date: string; total_cost?: number };
}

export interface RowProblem {
  row: number;      // 1-based data row (header excluded)
  error: string;
}

export const MAX_ROWS_PER_CALL = 10_000;

/** RFC 4180 CSV: quoted fields, "" escapes, CRLF/LF, BOM; comma, semicolon or tab. */
export function parseCsv(text: string): string[][] {
  const src = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const firstLine = src.split(/\r?\n/, 1)[0] ?? '';
  const delimiter = [',', ';', '\t'].reduce((best, d) =>
    firstLine.split(d).length > firstLine.split(best).length ? d : best, ',');
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < src.length; i++) {
    const c = src[i]!;
    if (quoted) {
      if (c === '"' && src[i + 1] === '"') { field += '"'; i++; }
      else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"' && field === '') quoted = true;
    else if (c === delimiter) { row.push(field); field = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && src[i + 1] === '\n') i++;
      row.push(field); field = '';
      if (row.some((f) => f.trim() !== '')) rows.push(row);
      row = [];
    } else field += c;
  }
  row.push(field);
  if (row.some((f) => f.trim() !== '')) rows.push(row);
  return rows;
}

// Header words seen in Pakistani distributor and pharmacy files.
const SYNONYMS: Record<ImportField, string[]> = {
  brand_name: ['medicine name', 'brand', 'brand name', 'product', 'product name', 'item', 'item name', 'name', 'medicine', 'description'],
  brand_name_ur: ['urdu', 'urdu name', 'name urdu', 'brand urdu'],
  generic: ['generic', 'generic name', 'salt', 'formula', 'composition', 'molecule'],
  strength: ['strength', 'potency', 'dose', 'mg'],
  dosage_form: ['form', 'dosage form', 'type'],
  manufacturer: ['manufacturer', 'company', 'mfg', 'mfr', 'maker', 'principal'],
  category: ['category', 'group', 'class', 'department'],
  barcode: ['barcode', 'bar code', 'ean', 'upc', 'gtin'],
  base_unit: ['smallest unit', 'unit', 'base unit', 'uom'],
  units_per_strip: ['units per strip', 'tablets per strip', 'tabs per strip', 'strip size', 'pack size', 'strip'],
  strips_per_box: ['strips per box', 'strips per pack', 'box size', 'strips', 'box'],
  retail_price: ['retail', 'retail price', 'price', 'mrp', 'sale price', 'selling price', 'rp'],
  rack: ['rack', 'shelf', 'location', 'rack no'],
  reorder_level: ['reorder', 'reorder level', 'reorder point', 'rol'],
  min_stock: ['min', 'min stock', 'minimum'],
  max_stock: ['max', 'max stock', 'maximum'],
  is_controlled: ['controlled', 'narcotic', 'schedule', 'is controlled'],
  rx_required: ['rx', 'prescription', 'rx required', 'prescription required'],
  stock_qty: ['quantity', 'qty', 'stock', 'stock qty', 'balance', 'closing stock', 'on hand', 'in stock'],
  stock_unit: ['quantity unit', 'qty unit', 'stock unit', 'quantity in'],
  batch_number: ['batch', 'batch no', 'batch number', 'lot', 'lot no'],
  expiry_date: ['expiry', 'expiry date', 'exp', 'exp date', 'expires'],
  unit_cost: ['cost', 'cost price', 'purchase price', 'trade price', 'tp', 'unit cost'],
};

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

/** Best guess for the mapping screen; the owner confirms or changes it. */
export function suggestMapping(headers: string[]): ColumnMapping {
  const mapping: ColumnMapping = {};
  const used = new Set<number>();
  for (const field of IMPORT_FIELDS) {
    const words = SYNONYMS[field];
    const idx = headers.findIndex((h, i) => !used.has(i) && words.includes(norm(h)));
    if (idx >= 0) {
      mapping[field] = idx;
      used.add(idx);
    }
  }
  return mapping;
}

/** "Rs 1,234.50" / "1234.5" / "1,234" -> minor units (paisa). null if blank. */
export function parseMoneyToMinor(text: string, minorUnits = 2): number | null {
  const t = text.replace(/rs\.?|pkr|₨|,|\s/gi, '');
  if (t === '') return null;
  const m = /^(-?)(\d+)(?:\.(\d+))?$/.exec(t);
  if (!m) throw new RangeError(`not a price: "${text}"`);
  const fraction = m[3] ?? '';
  if (fraction.length > minorUnits) throw new RangeError(`more than ${minorUnits} decimals: "${text}"`);
  const value = Number(m[2]) * 10 ** minorUnits + Number(fraction.padEnd(minorUnits, '0') || '0');
  if (!Number.isSafeInteger(value)) throw new RangeError(`price too large: "${text}"`);
  return m[1] === '-' ? -value : value;
}

function parseWhole(text: string, label: string): number | null {
  const t = text.replace(/,/g, '').trim();
  if (t === '') return null;
  if (!/^\d+$/.test(t)) throw new RangeError(`${label} must be a whole number: "${text}"`);
  return Number(t);
}

/** Expiry as written in shops: 2027-03-31, 31/03/2027, 03/2027, Mar-2027, or an Excel date number. -> YYYY-MM-DD */
export function parseExpiry(text: string): string | null {
  const t = text.trim();
  if (!t) return null;
  const pad = (n: number) => String(n).padStart(2, '0');
  const lastDay = (y: number, m: number) => new Date(Date.UTC(y, m, 0)).getUTCDate();
  const ok = (y: number, m: number, d: number) => {
    if (y < 100) y += 2000;
    if (m < 1 || m > 12 || d < 1 || d > lastDay(y, m) || y < 2000 || y > 2100) throw new RangeError(`not a date: "${text}"`);
    return `${y}-${pad(m)}-${pad(d)}`;
  };
  let m: RegExpExecArray | null;
  if ((m = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/.exec(t))) return ok(+m[1]!, +m[2]!, +m[3]!);
  if ((m = /^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2,4})$/.exec(t))) return ok(+m[3]!, +m[2]!, +m[1]!);
  if ((m = /^(\d{1,2})[-/.](\d{4})$/.exec(t))) { const y = +m[2]!, mo = +m[1]!; return ok(y, mo, lastDay(y, mo)); }
  const months = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
  if ((m = /^([a-z]{3})[a-z]*[-/ .]+(\d{2,4})$/i.exec(t))) {
    const mo = months.indexOf(m[1]!.toLowerCase()) + 1;
    let y = +m[2]!; if (y < 100) y += 2000;
    if (mo > 0) return ok(y, mo, lastDay(y, mo));
  }
  if (/^\d{5}(\.\d+)?$/.test(t)) { // Excel serial date
    const d = new Date(Date.UTC(1899, 11, 30) + Math.floor(+t) * 86_400_000);
    return ok(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate());
  }
  throw new RangeError(`expiry not understood: "${text}" (use 2027-03-31 or 03/2027)`);
}

function parseFlag(text: string): boolean | undefined {
  const t = text.trim().toLowerCase();
  if (t === '') return undefined;
  if (['yes', 'y', 'true', '1', 'x', 'haan'].includes(t)) return true;
  if (['no', 'n', 'false', '0', 'nahi'].includes(t)) return false;
  throw new RangeError(`expected yes or no: "${text}"`);
}

export interface BuildOptions {
  defaultBaseUnit?: string;          // 'tablet'
  priceIsPer?: 'base' | 'strip' | 'box';  // what the price column is for (mapping screen)
}

/**
 * Turn data rows (header removed) into import rows. Pack columns become the
 * unit ladder: tablet -> strip (units_per_strip) -> box (x strips_per_box).
 */
export function buildImportRows(
  data: string[][],
  mapping: ColumnMapping,
  opts: BuildOptions = {},
): { rows: ImportRow[]; problems: RowProblem[] } {
  const rows: ImportRow[] = [];
  const problems: RowProblem[] = [];
  const cell = (r: string[], f: ImportField) => {
    const i = mapping[f];
    return i === undefined ? '' : (r[i] ?? '').trim();
  };
  data.forEach((r, n) => {
    try {
      const brand = cell(r, 'brand_name');
      if (!brand) throw new RangeError('brand name is empty');
      const base = (cell(r, 'base_unit') || opts.defaultBaseUnit || 'tablet').toLowerCase();
      const perStrip = parseWhole(cell(r, 'units_per_strip'), 'units per strip');
      const perBox = parseWhole(cell(r, 'strips_per_box'), 'strips per box');
      const units: ImportRow['units'] = [];
      if (perStrip !== null && perStrip > 1) units.push({ unit: 'strip', factor: perStrip });
      if (perBox !== null && perBox > 1) units.push({ unit: 'box', factor: (perStrip && perStrip > 1 ? perStrip : 1) * perBox });
      const row: ImportRow = { brand_name: brand, base_unit: base, units };
      const text = (f: ImportField, key: keyof ImportRow) => {
        const v = cell(r, f);
        if (v) (row as unknown as Record<string, unknown>)[key] = v;
      };
      text('brand_name_ur', 'brand_name_ur');
      text('generic', 'generic');
      text('strength', 'strength');
      text('dosage_form', 'dosage_form');
      text('manufacturer', 'manufacturer');
      text('category', 'category');
      text('barcode', 'barcode');
      text('rack', 'rack');
      const price = parseMoneyToMinor(cell(r, 'retail_price'));
      if (price !== null) {
        if (price < 0) throw new RangeError('price cannot be negative');
        row.retail_price = price;
        // The price is for the pack chosen on the mapping screen; a row without that pack (a syrup
        // bottle has no box) prices its largest pack: box, then strip, then the single unit.
        const per = opts.priceIsPer ?? 'base';
        const has = (p: string) => units.some((u) => u.unit === p);
        row.retail_unit = per === 'box' && has('box') ? 'box'
          : per !== 'base' && has('strip') ? 'strip'
          : base;
      }
      for (const f of ['reorder_level', 'min_stock', 'max_stock'] as const) {
        const v = parseWhole(cell(r, f), f.replace('_', ' '));
        if (v !== null) row[f] = v;
      }
      const controlled = parseFlag(cell(r, 'is_controlled'));
      if (controlled !== undefined) row.is_controlled = controlled;
      const rx = parseFlag(cell(r, 'rx_required'));
      if (rx !== undefined) row.rx_required = rx;
      const qty = parseWhole(cell(r, 'stock_qty'), 'quantity');
      if (qty !== null && qty > 0) {
        const expiry = parseExpiry(cell(r, 'expiry_date'));
        if (!expiry) throw new RangeError('quantity given but no expiry date');
        const unitText = (cell(r, 'stock_unit') || base).toLowerCase();
        const unit = ['tablet', 'tab', 'tabs', 'capsule', 'cap', 'piece', 'pcs', 'unit', 'single'].includes(unitText) ? base : unitText;
        if (unit !== base && !units.some((u) => u.unit === unit)) throw new RangeError(`quantity unit "${unitText}" is not a pack of this medicine`);
        const cost = parseMoneyToMinor(cell(r, 'unit_cost'));
        row.stock = { qty, unit, batch_number: cell(r, 'batch_number') || 'OPENING', expiry_date: expiry,
          ...(cost !== null && cost >= 0 ? { total_cost: cost * qty } : {}) };
      }
      rows.push(row);
    } catch (e) {
      problems.push({ row: n + 1, error: (e as Error).message });
    }
  });
  return { rows, problems };
}

export function chunk<T>(items: T[], size = MAX_ROWS_PER_CALL): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}
