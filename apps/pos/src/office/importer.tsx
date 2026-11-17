// Import the pharmacy's whole medicine list from Excel or CSV: choose the file, check which column
// is which (MedFlow guesses), see the first rows and any problems, then import in batches.
// Importing the same file again changes nothing; existing medicines are updated, never duplicated.
import { buildImportRows, chunk, IMPORT_FIELDS, suggestMapping, type ColumnMapping, type ImportField } from '@medflow/core';
import { useState } from 'react';
import { errorText } from '../util.ts';
import { readSpreadsheet } from './sheet.ts';
import { Modal, type PageProps } from './ui.tsx';

const LABEL: Record<ImportField, string> = {
  brand_name: 'Medicine name *', brand_name_ur: 'Name in Urdu', generic: 'Generic / formula', strength: 'Strength', dosage_form: 'Form',
  manufacturer: 'Company', category: 'Category', barcode: 'Barcode', base_unit: 'Smallest unit', units_per_strip: 'Tablets per strip',
  strips_per_box: 'Strips per box', retail_price: 'Selling price', rack: 'Rack', reorder_level: 'Reorder level', min_stock: 'Min stock',
  max_stock: 'Max stock', is_controlled: 'Controlled (yes/no)', rx_required: 'Needs prescription (yes/no)',
};

const TEMPLATE = 'Medicine name,Generic,Strength,Company,Barcode,Smallest unit,Tablets per strip,Strips per box,Selling price,Price per,Rack,Reorder level,Controlled,Prescription\r\n'
  + 'Panadol 500mg Tablet,Paracetamol,500mg,Haleon,8961000000001,tablet,10,20,380,box,R1-S1,50,no,no\r\n'
  + 'Calpol Syrup 120mg/5ml,Paracetamol,120mg/5ml,Haleon,8961000000002,bottle,,,145,bottle,R2-S3,5,no,no\r\n';

export function ImportProducts(props: PageProps & { onClose: () => void; onDone: () => void }) {
  const [data, setData] = useState<string[][] | null>(null);
  const [fileName, setFileName] = useState('');
  const [mapping, setMapping] = useState<ColumnMapping>({});
  const [priceIsPer, setPriceIsPer] = useState<'base' | 'strip' | 'box'>('box');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState('');
  const [result, setResult] = useState<{ created: number; updated: number; unchanged: number; errors: Array<{ row: number; error: string }> } | null>(null);

  const headers = data?.[0] ?? [];
  const body = data?.slice(1) ?? [];
  const built = data ? buildImportRows(body, mapping, { priceIsPer }) : null;

  const pick = async (f: File | undefined) => {
    if (!f) return;
    setError(null); setResult(null);
    try {
      const rows = await readSpreadsheet(f);
      if (rows.length < 2) throw new Error('The file has no rows under the header');
      setData(rows);
      setFileName(f.name);
      setMapping(suggestMapping(rows[0]!));
    } catch (err) { setError(errorText(err)); }
  };

  const run = async () => {
    if (!built) return;
    setBusy(true); setError(null);
    const total = { created: 0, updated: 0, unchanged: 0, errors: [...built.problems] };
    try {
      const parts = chunk(built.rows, 1000);
      for (const [i, part] of parts.entries()) {
        setProgress(`Importing ${Math.min((i + 1) * 1000, built.rows.length)} of ${built.rows.length}…`);
        const r = await props.db.ownerCall<{ created: number; updated: number; unchanged?: number; errors: Array<Record<string, unknown>> }>('import_products', part, null);
        total.created += Number(r.created ?? 0);
        total.updated += Number(r.updated ?? 0);
        total.unchanged += Number(r.unchanged ?? 0);
        for (const e of r.errors ?? []) total.errors.push({ row: Number(e.row ?? 0) + i * 1000, error: String(e.error ?? e.message ?? JSON.stringify(e)) });
      }
      setResult(total);
    } catch (err) { setError(errorText(err)); }
    finally { setBusy(false); setProgress(''); }
  };

  const downloadTemplate = () => {
    const url = URL.createObjectURL(new Blob(['﻿' + TEMPLATE], { type: 'text/csv;charset=utf-8' }));
    const a = document.createElement('a');
    a.href = url; a.download = 'medflow-medicines-template.csv'; a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <Modal title="Import medicines from Excel" onClose={props.onClose} wide>
      {!data && (
        <div className="stack">
          <p className="muted">Choose your medicine list as an Excel (.xlsx) or CSV file. The first row must be the column names. Up to tens of thousands of medicines.</p>
          <label className="dropzone">
            <input type="file" accept=".xlsx,.csv,.txt" onChange={(e) => void pick(e.target.files?.[0])} />
            <span className="dz-icon" aria-hidden>⇪</span>
            <strong>Choose a file</strong>
            <span className="muted small">.xlsx or .csv</span>
          </label>
          <button type="button" className="btn ghost" onClick={downloadTemplate}>Download a sample file</button>
        </div>
      )}
      {data && !result && built && (
        <div className="stack">
          <div className="muted">{fileName} · {body.length} rows</div>
          <div className="panel-title">Which column is which?</div>
          <div className="mapping">
            {IMPORT_FIELDS.map((f) => (
              <label key={f} className="field">
                <span>{LABEL[f]}</span>
                <select value={mapping[f] ?? ''} onChange={(e) => setMapping((m) => { const n = { ...m }; if (e.target.value === '') delete n[f]; else n[f] = Number(e.target.value); return n; })}>
                  <option value="">— not in file —</option>
                  {headers.map((h, i) => <option key={i} value={i}>{h || `Column ${i + 1}`}</option>)}
                </select>
              </label>
            ))}
            <label className="field"><span>The price is for one…</span>
              <select value={priceIsPer} onChange={(e) => setPriceIsPer(e.target.value as 'base' | 'strip' | 'box')}>
                <option value="box">box</option><option value="strip">strip</option><option value="base">tablet / bottle (smallest unit)</option>
              </select>
            </label>
          </div>
          <div className="panel-title">First rows</div>
          <div className="table-wrap">
            <table className="table">
              <thead><tr><th>Medicine</th><th>Generic</th><th>Packs</th><th className="num">Price</th></tr></thead>
              <tbody>{built.rows.slice(0, 5).map((r, i) => (
                <tr key={i}><td>{r.brand_name}</td><td>{r.generic ?? ''}</td><td>{r.base_unit}{r.units.map((u) => ` · ${u.unit} ${u.factor}`).join('')}</td>
                  <td className="num">{r.retail_price !== undefined ? `Rs ${(r.retail_price / 100).toFixed(2)} / ${r.retail_unit}` : ''}</td></tr>
              ))}</tbody>
            </table>
          </div>
          <div className={built.problems.length ? 'message error' : 'message info'}>
            {built.rows.length} medicines ready{built.problems.length ? ` · ${built.problems.length} rows have problems (they will be skipped): ` + built.problems.slice(0, 3).map((p) => `row ${p.row + 1}: ${p.error}`).join('; ') : ''}
          </div>
          {mapping.brand_name === undefined && <div className="form-error">Choose which column has the medicine name.</div>}
          {error && <div className="form-error">{error}</div>}
          <div className="row-actions">
            <button type="button" className="btn ghost" onClick={() => setData(null)}>Choose another file</button>
            <button type="button" className="btn primary" disabled={busy || !built.rows.length || mapping.brand_name === undefined} onClick={() => void run()}>
              {busy ? progress || 'Importing…' : `Import ${built.rows.length} medicines`}
            </button>
          </div>
        </div>
      )}
      {result && (
        <div className="stack">
          <div className="stats">
            <div className="stat good"><div className="stat-label">New medicines</div><div className="stat-value">{result.created}</div></div>
            <div className="stat"><div className="stat-label">Updated</div><div className="stat-value">{result.updated}</div></div>
            <div className={`stat${result.errors.length ? ' bad' : ''}`}><div className="stat-label">Rows with problems</div><div className="stat-value">{result.errors.length}</div></div>
          </div>
          {result.errors.length > 0 && (
            <div className="table-wrap"><table className="table"><thead><tr><th className="num">Row</th><th>Problem</th></tr></thead>
              <tbody>{result.errors.slice(0, 200).map((e, i) => <tr key={i}><td className="num">{e.row + 1}</td><td>{e.error}</td></tr>)}</tbody></table></div>
          )}
          <p className="muted small">Next: add stock with "Add stock" on each medicine, or receive your first delivery in Purchases.</p>
          <div className="row-actions"><button type="button" className="btn primary" onClick={props.onDone}>Done</button></div>
        </div>
      )}
      {!data && error && <div className="form-error">{error}</div>}
    </Modal>
  );
}
