import { useState } from 'react';
import { toPaisa } from '../util.ts';
import { ProductDrawer } from './extras.tsx';
import { ImportProducts } from './importer.tsx';
import { csvButton, dateOf, Modal, money, PageHead, Stat, Table, timeOf, useLoad, useSubmit, type Col, type PageProps } from './ui.tsx';

interface ProductRow { id: string; brand_name: string; strength: string | null; generic: string | null; company: string | null; rack_location: string | null;
                       stock: number; sellable: number; nearest_expiry: string | null; reorder_level: number | null; is_controlled: boolean; rx_required: boolean;
                       packs: string; box_price: number | null; base_unit: string }

export function Products(props: PageProps) {
  const [q, setQ] = useState('');
  const [adding, setAdding] = useState(false);
  const [stockFor, setStockFor] = useState<ProductRow | null>(null);
  const [detail, setDetail] = useState<ProductRow | null>(null);
  const [importing, setImporting] = useState(false);
  const { data, error, reload } = useLoad(() => props.db.office<ProductRow[]>('products', props.branchId, q.trim()), [q]);
  const low = (data ?? []).filter((r) => r.reorder_level !== null && r.sellable <= r.reorder_level);
  const cols: Col<ProductRow>[] = [
    { label: 'Medicine', value: (r) => <><strong>{r.brand_name}</strong>{r.is_controlled && <span className="tag ctl">Controlled</span>}{r.rx_required && !r.is_controlled && <span className="tag rx">Rx</span>}<div className="muted small">{[r.generic, r.company].filter(Boolean).join(' · ')}</div></>, csv: (r) => r.brand_name },
    { label: 'Packs', value: (r) => r.packs },
    { label: 'Rack', value: (r) => r.rack_location ?? '' },
    { label: 'Price (biggest pack)', value: (r) => money(r.box_price), num: true, csv: (r) => (r.box_price ?? 0) / 100 },
    { label: 'In stock (smallest unit)', value: (r) => <span className={r.reorder_level !== null && r.sellable <= r.reorder_level ? 'bad-text' : ''}>{r.sellable}</span>, num: true, csv: (r) => r.sellable },
    { label: 'Nearest expiry', value: (r) => dateOf(r.nearest_expiry), csv: (r) => r.nearest_expiry },
    { label: '', value: (r) => <button type="button" className="btn small-btn" onClick={(e) => { e.stopPropagation(); setStockFor(r); }}>Add stock</button>, csv: () => null },
  ];
  return (
    <>
      <PageHead title="Products & stock" sub="Medicines, pack sizes, prices and what is on the shelf at this branch">
        {csvButton('products', data, cols)}
        <button type="button" className="btn" onClick={() => setImporting(true)}>Import from Excel</button>
        <button type="button" className="btn primary" onClick={() => setAdding(true)}>+ Add product</button>
      </PageHead>
      <div className="stats">
        <Stat label="Medicines" value={data?.length ?? '…'} />
        <Stat label="Low stock" value={low.length} tone={low.length ? 'bad' : undefined} sub="at or below reorder level" />
        <Stat label="Out of stock" value={(data ?? []).filter((r) => r.sellable <= 0).length} />
      </div>
      <div className="filters"><input placeholder="Search medicine or generic" value={q} onChange={(e) => setQ(e.target.value)} /></div>
      <Table rows={data} error={error} cols={cols} onRow={setDetail} />
      {importing && <ImportProducts {...props} onClose={() => setImporting(false)} onDone={() => { setImporting(false); reload(); }} />}
      {detail && <ProductDrawer {...props} productId={detail.id} name={detail.brand_name} onClose={() => setDetail(null)} />}
      {adding && <AddMedicine {...props} onClose={() => setAdding(false)} onSaved={() => { setAdding(false); reload(); }} />}
      {stockFor && <AddStock {...props} product={stockFor} onClose={() => setStockFor(null)} onSaved={() => { setStockFor(null); reload(); }} />}
    </>
  );
}

function AddMedicine(props: PageProps & { onClose: () => void; onSaved: () => void }) {
  const [f, setF] = useState({ brand_name: '', generic: '', strength: '', manufacturer: '', base_unit: 'tablet', per_strip: '10', strips: '10', price: '', rack: '', reorder: '', rx: false, controlled: false });
  const set = (k: keyof typeof f, v: string | boolean) => setF((x) => ({ ...x, [k]: v }));
  const loose = ['tablet', 'capsule'].includes(f.base_unit);
  const { busy, error, submit } = useSubmit(async () => {
    const units = loose ? [
      ...(Number(f.per_strip) > 1 ? [{ unit: 'strip', factor: Number(f.per_strip) }] : []),
      ...(Number(f.strips) > 1 ? [{ unit: 'box', factor: Number(f.per_strip) * Number(f.strips) }] : []),
    ] : [];
    const retailUnit = loose ? (Number(f.strips) > 1 ? 'box' : Number(f.per_strip) > 1 ? 'strip' : f.base_unit) : f.base_unit;
    const r = await props.db.ownerCall<{ errors: Array<Record<string, unknown>>; error_count: number }>('import_products', [{
      brand_name: f.brand_name.trim(), generic: f.generic.trim() || undefined, strength: f.strength.trim() || undefined,
      manufacturer: f.manufacturer.trim() || undefined, base_unit: f.base_unit, units, retail_price: toPaisa(f.price) ?? undefined,
      retail_unit: retailUnit, rack: f.rack || undefined, reorder_level: f.reorder ? Number(f.reorder) : undefined,
      rx_required: f.rx || f.controlled, is_controlled: f.controlled }], null);
    if (r.error_count) { const e = r.errors[0] ?? {}; throw new Error(String(e.error ?? e.message ?? JSON.stringify(e))); }
  }, props.onSaved);
  return (
    <Modal title="Add product" onClose={props.onClose} wide>
      <form className="form-grid" onSubmit={submit}>
        <label className="field span-2"><span>Product name *</span><input required autoFocus value={f.brand_name} onChange={(e) => set('brand_name', e.target.value)} placeholder="e.g. Panadol 500mg Tablet" /></label>
        <label className="field"><span>Generic / formula</span><input value={f.generic} onChange={(e) => set('generic', e.target.value)} placeholder="Paracetamol" /></label>
        <label className="field"><span>Strength</span><input value={f.strength} onChange={(e) => set('strength', e.target.value)} placeholder="500mg" /></label>
        <label className="field"><span>Company</span><input value={f.manufacturer} onChange={(e) => set('manufacturer', e.target.value)} placeholder="GSK" /></label>
        <label className="field"><span>Smallest unit</span>
          <select value={f.base_unit} onChange={(e) => set('base_unit', e.target.value)}>
            {['tablet', 'capsule', 'bottle', 'tube', 'sachet', 'vial', 'ampoule', 'piece'].map((u) => <option key={u} value={u}>{u}</option>)}
          </select>
        </label>
        {loose && <>
          <label className="field"><span>Tablets in a strip</span><input inputMode="numeric" value={f.per_strip} onChange={(e) => set('per_strip', e.target.value)} /></label>
          <label className="field"><span>Strips in a box</span><input inputMode="numeric" value={f.strips} onChange={(e) => set('strips', e.target.value)} /></label>
        </>}
        <label className="field"><span>Selling price of the {loose ? (Number(f.strips) > 1 ? 'box' : 'strip') : f.base_unit} (Rs)</span><input inputMode="decimal" value={f.price} onChange={(e) => set('price', e.target.value)} /></label>
        <label className="field"><span>Rack</span><input value={f.rack} onChange={(e) => set('rack', e.target.value)} placeholder="R1-S2" /></label>
        <label className="field"><span>Reorder at (smallest units)</span><input inputMode="numeric" value={f.reorder} onChange={(e) => set('reorder', e.target.value)} /></label>
        <label className="check"><input type="checkbox" checked={f.rx} onChange={(e) => set('rx', e.target.checked)} /> Needs a prescription</label>
        <label className="check"><input type="checkbox" checked={f.controlled} onChange={(e) => set('controlled', e.target.checked)} /> Controlled drug</label>
        {error && <div className="form-error span-2">{error}</div>}
        <div className="row-actions span-2"><button type="button" className="btn ghost" onClick={props.onClose}>Cancel</button><button className="btn primary" disabled={busy}>Save product</button></div>
      </form>
    </Modal>
  );
}

function AddStock(props: PageProps & { product: ProductRow; onClose: () => void; onSaved: () => void }) {
  const { data: units } = useLoad(() => props.db.office<{ code: string; name: string; factor: number }[]>('product_units', props.product.id), []);
  const [f, setF] = useState({ batch: '', expiry: '', qty: '', unit: '', cost: '' });
  const set = (k: keyof typeof f, v: string) => setF((x) => ({ ...x, [k]: v }));
  const unit = f.unit || units?.[0]?.code || props.product.base_unit;
  const { busy, error, submit } = useSubmit(() => props.db.ownerCall('receive_opening_stock', props.branchId, [{
    product_id: props.product.id, batch_number: f.batch || null, expiry_date: f.expiry || null, qty: Number(f.qty), unit,
    total_cost: f.cost ? toPaisa(f.cost) : undefined }], null), props.onSaved);
  return (
    <Modal title={`Opening stock · ${props.product.brand_name}`} onClose={props.onClose}>
      <p className="muted">Stock already on the shelf when you start with Nuskha. New deliveries go through Purchases.</p>
      <form className="form-grid" onSubmit={submit}>
        <label className="field"><span>Batch no.</span><input autoFocus value={f.batch} placeholder="Optional" onChange={(e) => set('batch', e.target.value)} /></label>
        <label className="field"><span>Expiry</span><input type="date" value={f.expiry} onChange={(e) => set('expiry', e.target.value)} /></label>
        <label className="field"><span>Quantity *</span><input required inputMode="numeric" value={f.qty} onChange={(e) => set('qty', e.target.value)} /></label>
        <label className="field"><span>Unit</span>
          <select value={unit} onChange={(e) => set('unit', e.target.value)}>{(units ?? []).map((u) => <option key={u.code} value={u.code}>{u.name}{u.factor > 1 ? ` (${u.factor})` : ''}</option>)}</select>
        </label>
        <label className="field span-2"><span>Total purchase cost (Rs, optional)</span><input inputMode="decimal" value={f.cost} onChange={(e) => set('cost', e.target.value)} /></label>
        {error && <div className="form-error span-2">{error}</div>}
        <div className="row-actions span-2"><button type="button" className="btn ghost" onClick={props.onClose}>Cancel</button><button className="btn primary" disabled={busy}>Add stock</button></div>
      </form>
    </Modal>
  );
}

interface ExpiryRow { brand_name: string; strength: string | null; rack_location: string | null; batch_id: string; batch_number: string; expiry_date: string; qty_base: number;
                      days_left: number; bucket: string; is_blocked: boolean }
const BUCKETS: Array<[string, string, (d: number) => boolean]> = [
  ['expired', 'Expired', (d) => d < 0], ['7', 'Within 7 days', (d) => d >= 0 && d <= 7], ['30', 'Within 30 days', (d) => d >= 0 && d <= 30],
  ['60', 'Within 60 days', (d) => d >= 0 && d <= 60], ['90', 'Within 90 days', (d) => d >= 0 && d <= 90], ['all', 'All batches', () => true],
];

export function Expiry(props: PageProps) {
  const [bucket, setBucket] = useState('90');
  const [adjust, setAdjust] = useState<ExpiryRow | null>(null);
  const { data, error, reload } = useLoad(() => props.db.office<ExpiryRow[]>('expiry', props.branchId), []);
  const test = BUCKETS.find((b) => b[0] === bucket)![2];
  const rows = (data ?? []).filter((r) => test(r.days_left));
  return (
    <>
      <PageHead title="Expiry" sub="Batches on the shelf by how soon they expire. Expired and recalled batches are never sold." />
      <div className="tabs">
        {BUCKETS.map(([k, label, fn]) => (
          <button key={k} type="button" className={`tab${bucket === k ? ' on' : ''}`} onClick={() => setBucket(k)}>
            {label} <span className="count">{(data ?? []).filter((r) => fn(r.days_left)).length}</span>
          </button>
        ))}
      </div>
      <Table rows={data ? rows : null} error={error} empty="Nothing in this group." cols={[
        { label: 'Medicine', value: (r) => r.brand_name },
        { label: 'Batch', value: (r) => <>{r.batch_number}{r.is_blocked && <span className="tag ctl">Recalled</span>}</> },
        { label: 'Expiry', value: (r) => dateOf(r.expiry_date) },
        { label: 'Days left', value: (r) => <span className={r.days_left < 0 ? 'bad-text' : r.days_left <= 30 ? 'warn-text' : ''}>{r.days_left < 0 ? `expired ${-r.days_left}d ago` : r.days_left}</span>, num: true },
        { label: 'Qty', value: (r) => r.qty_base, num: true },
        { label: 'Rack', value: (r) => r.rack_location ?? '' },
        { label: '', value: (r) => <button type="button" className="btn small-btn" onClick={() => setAdjust(r)}>Write off</button> },
      ]} />
      {adjust && <WriteOff {...props} row={adjust} onClose={() => setAdjust(null)} onSaved={() => { setAdjust(null); reload(); }} />}
    </>
  );
}

function WriteOff(props: PageProps & { row: ExpiryRow; onClose: () => void; onSaved: () => void }) {
  const [qty, setQty] = useState(String(props.row.qty_base));
  const [kind, setKind] = useState(props.row.days_left < 0 ? 'expire' : 'dispose');
  const [reason, setReason] = useState(props.row.days_left < 0 ? 'Expired' : '');
  const { busy, error, submit } = useSubmit(() => props.db.ownerCall('write_off_stock', props.branchId, props.row.batch_id, Number(qty), kind, reason, null), props.onSaved);
  return (
    <Modal title={`Write off · ${props.row.brand_name} ${props.row.batch_number}`} onClose={props.onClose}>
      <form className="form-grid" onSubmit={submit}>
        <label className="field"><span>Quantity (smallest unit)</span><input autoFocus inputMode="numeric" value={qty} onChange={(e) => setQty(e.target.value)} /></label>
        <label className="field"><span>Why</span><select value={kind} onChange={(e) => setKind(e.target.value)}><option value="expire">Expired</option><option value="dispose">Damaged / disposed</option></select></label>
        <label className="field span-2"><span>Note</span><input required value={reason} onChange={(e) => setReason(e.target.value)} /></label>
        {error && <div className="form-error span-2">{error}</div>}
        <div className="row-actions span-2"><button type="button" className="btn ghost" onClick={props.onClose}>Cancel</button><button className="btn danger" disabled={busy}>Write off</button></div>
      </form>
    </Modal>
  );
}

interface MoveRow { occurred_at: string; brand_name: string; batch_number: string; movement_type: string; qty_base: number; reason: string | null; who: string | null; ref: string | null }

export function Movements(props: PageProps) {
  const [q, setQ] = useState('');
  const { data, error } = useLoad(() => props.db.office<MoveRow[]>('movements', props.branchId, q.trim()), [q]);
  const cols: Col<MoveRow>[] = [
    { label: 'When', value: (r) => timeOf(r.occurred_at), csv: (r) => r.occurred_at },
    { label: 'Medicine', value: (r) => r.brand_name },
    { label: 'Batch', value: (r) => r.batch_number },
    { label: 'Type', value: (r) => r.movement_type.replace('_', ' ') },
    { label: 'Qty', value: (r) => <span className={r.qty_base < 0 ? 'bad-text' : 'good-text'}>{r.qty_base > 0 ? `+${r.qty_base}` : r.qty_base}</span>, num: true, csv: (r) => r.qty_base },
    { label: 'Bill / delivery', value: (r) => r.ref ?? r.reason ?? '' },
    { label: 'By', value: (r) => r.who ?? '' },
  ];
  return (
    <>
      <PageHead title="Stock movements" sub="Every unit in and out: sales, deliveries, returns, adjustments, write-offs">{csvButton('stock-movements', data, cols)}</PageHead>
      <div className="filters"><input placeholder="Search medicine" value={q} onChange={(e) => setQ(e.target.value)} /></div>
      <Table rows={data} error={error} cols={cols} />
    </>
  );
}
