// Reads the first sheet of an Excel file (.xlsx), or a CSV file, into rows of text. No library:
// an .xlsx is a zip of XML files, and browsers can unzip ("deflate-raw") and parse XML themselves.
import { parseCsv } from '@medflow/core';

export async function readSpreadsheet(file: File): Promise<string[][]> {
  const name = file.name.toLowerCase();
  if (name.endsWith('.csv') || name.endsWith('.txt')) return parseCsv(await file.text());
  if (name.endsWith('.xlsx')) return readXlsx(new Uint8Array(await file.arrayBuffer()));
  if (name.endsWith('.xls')) throw new Error('Old .xls files are not supported: open it in Excel and "Save As" .xlsx or .csv');
  throw new Error('Choose an Excel (.xlsx) or CSV file');
}

async function inflate(data: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([data as BlobPart]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** The files inside a zip (only the ones we ask for are unpacked). */
async function unzip(bytes: Uint8Array, wanted: (name: string) => boolean): Promise<Map<string, string>> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let eocd = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 65_557); i--) {
    if (view.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('This does not look like an Excel file');
  const count = view.getUint16(eocd + 10, true);
  let p = view.getUint32(eocd + 16, true);
  const out = new Map<string, string>();
  const dec = new TextDecoder();
  for (let n = 0; n < count; n++) {
    if (view.getUint32(p, true) !== 0x02014b50) break;
    const method = view.getUint16(p + 10, true);
    const size = view.getUint32(p + 20, true);
    const nameLen = view.getUint16(p + 28, true);
    const extraLen = view.getUint16(p + 30, true);
    const commentLen = view.getUint16(p + 32, true);
    const local = view.getUint32(p + 42, true);
    const name = dec.decode(bytes.subarray(p + 46, p + 46 + nameLen));
    p += 46 + nameLen + extraLen + commentLen;
    if (!wanted(name)) continue;
    const start = local + 30 + view.getUint16(local + 26, true) + view.getUint16(local + 28, true);
    const raw = bytes.subarray(start, start + size);
    out.set(name, dec.decode(method === 8 ? await inflate(raw) : raw));
  }
  return out;
}

const colIndex = (ref: string) => {
  let n = 0;
  for (const ch of ref.replace(/\d+$/, '')) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
};

async function readXlsx(bytes: Uint8Array): Promise<string[][]> {
  const files = await unzip(bytes, (n) => n === 'xl/sharedStrings.xml' || n === 'xl/workbook.xml' || n === 'xl/_rels/workbook.xml.rels' || /^xl\/worksheets\/sheet\d+\.xml$/.test(n));
  const parse = (xml: string) => new DOMParser().parseFromString(xml, 'application/xml');
  const shared = files.has('xl/sharedStrings.xml')
    ? [...parse(files.get('xl/sharedStrings.xml')!).getElementsByTagName('si')].map((si) => [...si.getElementsByTagName('t')].map((t) => t.textContent ?? '').join(''))
    : [];
  // The first sheet in the workbook's order.
  let sheetPath = 'xl/worksheets/sheet1.xml';
  if (files.has('xl/workbook.xml') && files.has('xl/_rels/workbook.xml.rels')) {
    const first = parse(files.get('xl/workbook.xml')!).getElementsByTagName('sheet')[0];
    const rid = first?.getAttribute('r:id') ?? first?.getAttributeNS('http://schemas.openxmlformats.org/officeDocument/2006/relationships', 'id');
    const rel = [...parse(files.get('xl/_rels/workbook.xml.rels')!).getElementsByTagName('Relationship')].find((r) => r.getAttribute('Id') === rid);
    const target = rel?.getAttribute('Target');
    if (target) sheetPath = target.startsWith('/') ? target.slice(1) : `xl/${target.replace(/^\.\//, '')}`;
  }
  const sheetXml = files.get(sheetPath) ?? [...files.entries()].find(([k]) => k.startsWith('xl/worksheets/'))?.[1];
  if (!sheetXml) throw new Error('The Excel file has no sheet');
  const rows: string[][] = [];
  for (const row of parse(sheetXml).getElementsByTagName('row')) {
    const cells: string[] = [];
    let next = 0;
    for (const c of row.getElementsByTagName('c')) {
      const ref = c.getAttribute('r');
      const i = ref ? colIndex(ref) : next;
      const type = c.getAttribute('t');
      const v = c.getElementsByTagName('v')[0]?.textContent ?? '';
      let text = v;
      if (type === 's') text = shared[Number(v)] ?? '';
      else if (type === 'inlineStr') text = [...c.getElementsByTagName('t')].map((t) => t.textContent ?? '').join('');
      else if (type === 'b') text = v === '1' ? 'yes' : 'no';
      while (cells.length < i) cells.push('');
      cells[i] = text;
      next = i + 1;
    }
    rows.push(cells);
  }
  return rows.filter((r) => r.some((c) => c.trim() !== ''));
}
