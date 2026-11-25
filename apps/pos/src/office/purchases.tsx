import { useEffect, useRef, useState } from 'react';
import { toPaisa } from '../util.ts';
import { useMoneyAccounts } from './parties.tsx';
import { dateOf, Modal, money, PageHead, Stat, Table, timeOf, useLoad, useSubmit, type PageProps } from './ui.tsx';

interface ProductPick { id: string; brand_name: string; units: Array<{ id: string; name: string; factor: number }> }
interface Line { key: string; product: ProductPick | null; unitId: string; batch: string; expiry: string; qty: string; bonus: string; cost: string; retail: string;
                 poLineId?: string; ordered?: number }
const emptyLine = (): Line => ({ key: crypto.randomUUID(), product: null, unitId: '', batch: '', expiry: '', qty: '', bonus: '', cost: '', retail: '' });

/** Find a medicine and its pack sizes (owner side). */
function useProductSearch(props: PageProps, q: string) {
  return useLoad(() => (q.trim().length < 2 ? Promise.resolve([] as ProductPick[]) : props.db.office<ProductPick[]>('product_search', q.trim())), [q]);
}

export function ProductPicker(props: PageProps & { value: ProductPick | null; onPick: (p: ProductPick) => void }) {
  const [q, setQ] = useState(props.value?.brand_name ?? '');
  const [open, setOpen] = useState(false);
  const hits = useProductSearch(props, open ? q : '');
  return (
    <div className="search-wrap">
      <input value={q} placeholder="Product" onFocus={() => setOpen(true)} onBlur={() => window.setTimeout(() => setOpen(false), 150)}
             onChange={(e) => { setQ(e.target.value); setOpen(true); }} />
      {open && (hits.data?.length ?? 0) > 0 && (
        <ul className="results small-results">
          {hits.data!.map((p) => <li key={p.id} onMouseDown={() => { props.onPick(p); setQ(p.brand_name); setOpen(false); }}><span className="r-name">{p.brand_name}</span></li>)}
        </ul>
      )}
    </div>
  );
}

interface Supplier { id: string; name: string; payment_terms_days: number | null; discount_pct?: number | string }
const useSuppliers = (props: PageProps) => useLoad(() => props.db.office<Supplier[]>('suppliers'), []);

export function Purchases(props: PageProps) {
  const [tab, setTab] = useState<'deliveries' | 'orders' | 'returns'>('deliveries');
  const [form, setForm] = useState<null | { kind: 'delivery'; order?: OrderRow; edit?: DeliveryRow } | { kind: 'order' } | { kind: 'return' }>(null);
  const [n, setN] = useState(0);
  const done = () => { setForm(null); setN((x) => x + 1); };
  return (
    <>
      <PageHead title="Purchases" sub="Order → Received → Paid. Deliveries add stock; their invoice adds what you owe the supplier.">
        <button type="button" className="btn" onClick={() => setForm({ kind: 'order' })}>New order</button>
        <button type="button" className="btn" onClick={() => setForm({ kind: 'return' })}>Return to supplier</button>
        <button type="button" className="btn primary" onClick={() => setForm({ kind: 'delivery' })}>+ Receive delivery</button>
      </PageHead>
      <div className="tabs">
        {(['deliveries', 'orders', 'returns'] as const).map((t) => (
          <button key={t} type="button" className={`tab${tab === t ? ' on' : ''}`} onClick={() => setTab(t)}>{t[0]!.toUpperCase() + t.slice(1)}</button>
        ))}
      </div>
      {tab === 'deliveries' && <Deliveries {...props} key={n} onEdit={(d) => setForm({ kind: 'delivery', edit: d })} onChanged={done} />}
      {tab === 'orders' && <Orders {...props} key={n} onReceive={(o) => setForm({ kind: 'delivery', order: o })} />}
      {tab === 'returns' && <Returns {...props} key={n} />}
      {form?.kind === 'delivery' && <ReceiveDelivery {...props} order={form.order ?? null} edit={form.edit ?? null} onClose={() => setForm(null)} onSaved={done} />}
      {form?.kind === 'order' && <NewOrder {...props} onClose={() => setForm(null)} onSaved={done} />}
      {form?.kind === 'return' && <NewReturn {...props} onClose={() => setForm(null)} onSaved={done} />}
    </>
  );
}

interface DeliveryRow { id: string; grn_number: string; received_at: string; supplier: string; invoice_no: string | null; total: number | null; open: number | null; lines: number }

function Deliveries(props: PageProps & { onEdit: (d: DeliveryRow) => void; onChanged: () => void }) {
  const { data, error } = useLoad(() => props.db.office<DeliveryRow[]>('deliveries', props.branchId), []);
  const [deleting, setDeleting] = useState<DeliveryRow | null>(null);
  const del = useSubmit(() => props.db.ownerCall('void_grn', deleting!.id, 'Deleted in Purchases', null), () => { setDeleting(null); props.onChanged(); });
  const total = (data ?? []).reduce((s, r) => s + Number(r.total ?? 0), 0);
  return (
    <>
      <div className="stats">
        <Stat label="Deliveries" value={data?.length ?? '…'} />
        <Stat label="Bought (invoices)" value={money(total)} />
        <Stat label="Still unpaid on these" value={money((data ?? []).reduce((s, r) => s + Number(r.open ?? 0), 0))} tone="warn" />
      </div>
      <Table rows={data} error={error} empty="No deliveries yet. Press “Receive delivery” when stock arrives." cols={[
        { label: 'Delivery', value: (r) => r.grn_number },
        { label: 'Received', value: (r) => timeOf(r.received_at) },
        { label: 'Supplier', value: (r) => r.supplier },
        { label: 'Invoice', value: (r) => r.invoice_no ?? '—' },
        { label: 'Items', value: (r) => r.lines, num: true },
        { label: 'Total', value: (r) => money(r.total), num: true },
        { label: 'Status', value: (r) => (r.total === null ? <span className="pill warn">Awaiting invoice</span> : Number(r.open ?? 0) > 0 ? <span className="pill warn">Unpaid</span> : <span className="pill good">Paid</span>) },
        { label: '', value: (r) => (
          <div className="row-actions">
            <button type="button" className="btn small-btn" onClick={(e) => { e.stopPropagation(); props.onEdit(r); }}>Edit</button>
            <button type="button" className="btn small-btn ghost bad-text" onClick={(e) => { e.stopPropagation(); setDeleting(r); }}>Delete</button>
          </div>) },
      ]} />
      {deleting && (
        <Modal title={`Delete ${deleting.grn_number}?`} onClose={() => setDeleting(null)}>
          <p>The stock of this delivery leaves the shelf again{deleting.total !== null ? ', and its bill is removed from what you owe ' + deleting.supplier : ''}. This cannot be undone.</p>
          {del.error && <div className="form-error">{del.error}</div>}
          <div className="row-actions"><button type="button" className="btn ghost" onClick={() => setDeleting(null)}>No</button>
            <button type="button" className="btn danger" disabled={del.busy} onClick={() => void del.submit()}>{del.busy ? 'Deleting…' : 'Yes, delete'}</button></div>
        </Modal>
      )}
    </>
  );
}

interface Hit extends ProductPick { last_unit_id: string | null; last_cost: number | null; last_batch: string | null; last_expiry: string | null; last_retail: number | null }

/** Search-first product box for deliveries: type, arrow keys, Enter adds the product. */
function ProductSearchBox(props: PageProps & { onPick: (p: Hit) => void; inputRef: React.MutableRefObject<HTMLInputElement | null> }) {
  const [q, setQ] = useState('');
  const [at, setAt] = useState(0);
  const hits = useLoad(() => (q.trim().length < 2 ? Promise.resolve([] as Hit[]) : props.db.office<Hit[]>('product_search', q.trim())), [q]);
  const list = hits.data ?? [];
  const pick = (h: Hit | undefined) => { if (!h) return; props.onPick(h); setQ(''); setAt(0); };
  return (
    <div className="search-wrap grn-search">
      <input ref={props.inputRef} autoFocus value={q} placeholder="Search product: name, formula or barcode, then Enter"
             onChange={(e) => { setQ(e.target.value); setAt(0); }}
             onKeyDown={(e) => {
               if (e.key === 'ArrowDown') { e.preventDefault(); setAt((a) => Math.min(a + 1, list.length - 1)); }
               else if (e.key === 'ArrowUp') { e.preventDefault(); setAt((a) => Math.max(a - 1, 0)); }
               else if (e.key === 'Enter') { e.preventDefault(); pick(list[at]); }
             }} />
      {list.length > 0 && (
        <ul className="results small-results">
          {list.map((h, k) => (
            <li key={h.id} className={k === at ? 'on' : ''} onMouseDown={(e) => { e.preventDefault(); pick(h); }}>
              <span className="r-name">{h.brand_name}</span>
              <span className="muted small">{h.last_cost != null ? `last cost ${money(h.last_cost)}` : 'not bought before'}</span>
            </li>
          ))}
        </ul>
      )}
      {q.trim().length >= 2 && hits.data && list.length === 0 && <div className="muted small">Not found. Add it in Products → Add product, then search again.</div>}
    </div>
  );
}

interface GrnDetail { id: string; grn_number: string; supplier_id: string; invoice_no: string | null; invoice_date: string | null;
  lines: Array<{ product_id: string; brand_name: string; unit_id: string; qty: number; bonus: number; batch: string | null; expiry: string | null;
                 cost: number | null; discount: number | null; retail: number | null; units: ProductPick['units'] }> }

function ReceiveDelivery(props: PageProps & { order: OrderRow | null; edit?: DeliveryRow | null; onClose: () => void; onSaved: () => void }) {
  const editing = useLoad(() => (props.edit ? props.db.office<GrnDetail>('grn_detail', props.edit.id) : Promise.resolve(null)), []);
  const [loadedEdit, setLoadedEdit] = useState(false);
  const suppliers = useSuppliers(props);
  const accounts = useMoneyAccounts(props);
  const orderLines = useLoad(() => (props.order ? props.db.office<{ id: string; product_id: string; brand_name: string; unit_id: string; qty: number; bonus_qty: number;
    units: ProductPick['units'] }[]>('order_lines', props.order.id) : Promise.resolve([])), []);
  const [supplier, setSupplier] = useState(props.order?.supplier_id ?? '');
  const [discPct, setDiscPct] = useState('');
  const [invoiceNo, setInvoiceNo] = useState('');
  const [invoiceDate, setInvoiceDate] = useState(props.today);
  const [lines, setLines] = useState<Line[]>([]);
  const [loadedOrder, setLoadedOrder] = useState(false);
  const [paid, setPaid] = useState('');
  const [acc, setAcc] = useState('');
  const searchRef = useRef<HTMLInputElement | null>(null);
  const qtyRefs = useRef<Record<string, HTMLInputElement | null>>({});
  const [focusKey, setFocusKey] = useState<string | null>(null);
  useEffect(() => { if (focusKey) { qtyRefs.current[focusKey]?.focus(); qtyRefs.current[focusKey]?.select(); setFocusKey(null); } }, [focusKey]);
  // Edit: the delivery as it was saved; saving replaces it.
  if (props.edit && editing.data && !loadedEdit) {
    const d = editing.data;
    setLoadedEdit(true);
    setSupplier(d.supplier_id);
    setInvoiceNo(d.invoice_no ?? '');
    if (d.invoice_date) setInvoiceDate(d.invoice_date);
    const first = d.lines.find((l) => l.cost && l.qty);
    if (first?.discount) setDiscPct(String(Math.round((first.discount / (first.qty * first.cost!)) * 10000) / 100));
    setLines(d.lines.map((l) => ({ ...emptyLine(), product: { id: l.product_id, brand_name: l.brand_name, units: l.units ?? [] }, unitId: l.unit_id,
      qty: String(l.qty), bonus: l.bonus ? String(l.bonus) : '', batch: l.batch ?? '', expiry: l.expiry ? String(l.expiry).slice(0, 10) : '',
      cost: l.cost != null ? String(l.cost / 100) : '', retail: l.retail != null ? String(l.retail / 100) : '' })));
  }
  if (props.order && orderLines.data && !loadedOrder) {
    setLoadedOrder(true);
    setLines(orderLines.data.map((l) => ({ ...emptyLine(), product: { id: l.product_id, brand_name: l.brand_name, units: l.units ?? [] }, unitId: l.unit_id,
                                            qty: String(l.qty), bonus: l.bonus_qty ? String(l.bonus_qty) : '', poLineId: l.id, ordered: l.qty })));
  }
  const chooseSupplier = (id: string) => {
    setSupplier(id);
    const s = (suppliers.data ?? []).find((x) => x.id === id);
    setDiscPct(s && Number(s.discount_pct) > 0 ? String(Number(s.discount_pct)) : '');
  };
  const upd = (i: number, patch: Partial<Line>) => setLines((ls) => ls.map((l, j) => (j === i ? { ...l, ...patch } : l)));
  const add = (h: Hit) => {
    const same = lines.find((l) => l.product?.id === h.id && !l.poLineId);
    if (same) { upd(lines.indexOf(same), { qty: String((Number(same.qty) || 0) + 1) }); setFocusKey(same.key); return; }
    const units = h.units ?? [];
    const line: Line = { ...emptyLine(), product: { id: h.id, brand_name: h.brand_name, units },
      unitId: (h.last_unit_id && units.some((u) => u.id === h.last_unit_id) ? h.last_unit_id : units[0]?.id) ?? '',
      batch: h.last_batch && h.last_batch !== '-' ? h.last_batch : '',
      cost: h.last_cost != null ? String(h.last_cost / 100) : '', retail: h.last_retail != null ? String(h.last_retail / 100) : '' };
    setLines((ls) => [...ls, line]);
    setFocusKey(line.key);
  };
  const pct = Math.min(Math.max(Number(discPct) || 0, 0), 100);
  const gross = (l: Line) => (Number(l.qty) || 0) * (toPaisa(l.cost) ?? 0);
  const discOf = (l: Line) => Math.round((gross(l) * pct) / 100);
  const lineTotal = (l: Line) => gross(l) - discOf(l);
  const total = lines.reduce((s, l) => s + lineTotal(l), 0);
  const saved = lines.reduce((s, l) => s + discOf(l), 0);
  const mismatches = lines.filter((l) => l.ordered !== undefined && Number(l.qty) !== l.ordered);
  const chosen = (accounts.data ?? []).find((a) => a.id === acc) ?? accounts.data?.[0];
  const { busy, error, submit } = useSubmit(async () => {
    const ready = lines.filter((l) => l.product && (Number(l.qty) || 0) + (Number(l.bonus) || 0) > 0);
    if (!supplier) throw new Error('Choose the supplier');
    if (!ready.length) throw new Error('Search a product and enter how many arrived');
    const noUnit = ready.find((l) => !(l.unitId || l.product!.units[0]?.id));
    if (noUnit) throw new Error(`${noUnit.product!.brand_name} has no pack size yet. Open it in Products and add one.`);
    const paidNow = toPaisa(paid || '0') ?? 0;
    const grn = {
      id: crypto.randomUUID(), branch_id: props.branchId, supplier_id: supplier, purchase_order_id: props.order?.id ?? null,
      supplier_invoice_number: invoiceNo || null,
      lines: ready.map((l) => ({ id: crypto.randomUUID(), po_line_id: l.poLineId ?? null, product_unit_id: l.unitId || l.product!.units[0]!.id,
        batch_number: l.batch || null, expiry_date: l.expiry || null, qty: Number(l.qty) || 0, bonus_qty: Number(l.bonus) || 0,
        ...(l.cost ? { unit_cost: toPaisa(l.cost) ?? 0, discount_amount: discOf(l) } : {}), retail_price: l.retail ? toPaisa(l.retail) : null })),
      ...(invoiceNo ? { invoice: { supplier_invoice_number: invoiceNo, invoice_date: invoiceDate, expected_grand_total: total, paid_at_receipt: paidNow,
        payment: chosen ? { method: chosen.kind === 'drawer' ? 'cash' : 'bank_transfer', ...(chosen.kind === 'drawer' ? { drawer_session_id: chosen.id } : { bank_account_id: chosen.id }) } : {} } } : {}),
    };
    if (props.edit) await props.db.ownerCall('replace_grn', props.edit.id, grn, null);
    else await props.db.ownerCall('post_grn', grn, null);
  }, props.onSaved);
  // Ctrl+S saves from anywhere in the form.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') { e.preventDefault(); void submit(); } };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });
  const backToSearch = (e: React.KeyboardEvent) => { if (e.key === 'Enter') { e.preventDefault(); searchRef.current?.focus(); } };
  return (
    <Modal title={props.edit ? `Edit delivery ${props.edit.grn_number}` : props.order ? `Receive order ${props.order.po_number}` : 'Receive delivery'} onClose={props.onClose} wide>
      <form className="stack" onSubmit={submit}>
        <div className="form-grid grn-head">
          <label className="field"><span>Supplier *</span>
            <select required value={supplier} onChange={(e) => chooseSupplier(e.target.value)} disabled={!!props.order}>
              <option value="">Choose…</option>{(suppliers.data ?? []).map((s) => <option key={s.id} value={s.id}>{s.name}{Number(s.discount_pct) > 0 ? ` · ${Number(s.discount_pct)}% off` : ''}</option>)}
            </select>
          </label>
          <label className="field"><span>Supplier discount %</span><input inputMode="decimal" value={discPct} onChange={(e) => setDiscPct(e.target.value)} placeholder="0" /></label>
          <label className="field"><span>Supplier's invoice no.</span><input value={invoiceNo} onChange={(e) => setInvoiceNo(e.target.value)} placeholder="Optional" /></label>
          <label className="field"><span>Invoice date</span><input type="date" value={invoiceDate} onChange={(e) => setInvoiceDate(e.target.value)} /></label>
        </div>
        <ProductSearchBox {...props} inputRef={searchRef} onPick={add} />
        {lines.length > 0 ? (
          <div className="table-wrap">
            <table className="table grn-table">
              <thead><tr><th>Product</th><th className="num">Qty</th><th>Unit</th><th className="num">Bonus</th><th className="num">Cost / unit</th><th className="num">Sell / unit</th><th>Batch</th><th>Expiry</th><th className="num">Total</th><th /></tr></thead>
              <tbody>
                {lines.map((l, i) => (
                  <tr key={l.key} className={l.ordered !== undefined && Number(l.qty) !== l.ordered ? 'mismatch' : ''}>
                    <td className="grn-name">{l.product?.brand_name}</td>
                    <td><input ref={(el) => { qtyRefs.current[l.key] = el; }} className="num" inputMode="numeric" value={l.qty} placeholder="0"
                               onChange={(e) => upd(i, { qty: e.target.value })} onKeyDown={backToSearch} />{l.ordered !== undefined && <div className="muted small">ordered {l.ordered}</div>}</td>
                    <td><select value={l.unitId} onChange={(e) => upd(i, { unitId: e.target.value })}>
                      {(l.product?.units ?? []).length ? l.product!.units.map((u) => <option key={u.id} value={u.id}>{u.name}{u.factor > 1 ? ` (${u.factor})` : ''}</option>)
                        : <option value="">No pack size</option>}
                    </select></td>
                    <td><input className="num" inputMode="numeric" value={l.bonus} onChange={(e) => upd(i, { bonus: e.target.value })} onKeyDown={backToSearch} placeholder="0" /></td>
                    <td><input className="num" inputMode="decimal" value={l.cost} onChange={(e) => upd(i, { cost: e.target.value })} onKeyDown={backToSearch} /></td>
                    <td><input className="num" inputMode="decimal" value={l.retail} onChange={(e) => upd(i, { retail: e.target.value })} onKeyDown={backToSearch} placeholder="MRP" /></td>
                    <td><input value={l.batch} onChange={(e) => upd(i, { batch: e.target.value })} onKeyDown={backToSearch} placeholder="Optional" /></td>
                    <td><input type="date" value={l.expiry} onChange={(e) => upd(i, { expiry: e.target.value })} onKeyDown={backToSearch} /></td>
                    <td className="num">{money(lineTotal(l))}</td>
                    <td><button type="button" className="icon-btn" tabIndex={-1} onClick={() => setLines((ls) => ls.filter((_, j) => j !== i))} aria-label="Remove">×</button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : <div className="empty-hint muted">Search a product above. Its pack size, last cost, price and batch fill in; you only type the quantity.</div>}
        <div className="row-between">
          <span className="muted small">{lines.length} item(s){saved > 0 ? ` · supplier discount saves ${money(saved)}` : ''}</span>
          <div className="grand-mini">Invoice total <strong>{money(total)}</strong></div>
        </div>
        {mismatches.length > 0 && <div className="message info">⚠ {mismatches.length} line(s) differ from the order: {mismatches.map((l) => `${l.product?.brand_name} ${l.qty} of ${l.ordered}`).join(', ')}. The order stays open for the rest.</div>}
        {invoiceNo && (
          <div className="form-grid">
            <label className="field"><span>Paid now (Rs)</span><input inputMode="decimal" value={paid} onChange={(e) => setPaid(e.target.value)} placeholder="0" /></label>
            <label className="field"><span>Paid from</span><select value={chosen?.id ?? ''} onChange={(e) => setAcc(e.target.value)}>{(accounts.data ?? []).map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}</select></label>
          </div>
        )}
        <p className="muted small">Enter after a quantity goes back to the search box. Batch and expiry are optional. Bonus units cost nothing, so they lower the average cost. Ctrl+S saves.</p>
        {error && <div className="form-error">{error}</div>}
        <div className="row-actions"><button type="button" className="btn ghost" onClick={props.onClose}>Cancel</button><button className="btn primary" disabled={busy}>Save delivery (Ctrl+S)</button></div>
      </form>
    </Modal>
  );
}

interface OrderRow { id: string; po_number: string; supplier_id: string; supplier: string; supplier_whatsapp: string | null; order_date: string; status: string; lines: number }

function Orders(props: PageProps & { onReceive: (o: OrderRow) => void }) {
  const [sent, setSent] = useState<{ text: string; phone: string | null } | null>(null);
  const { data, error, reload } = useLoad(() => props.db.office<OrderRow[]>('orders', props.branchId), []);
  const send = async (o: OrderRow) => {
    const text = await props.db.ownerCall<string>('send_purchase_order', o.id, 'whatsapp');
    const phone = o.supplier_whatsapp;
    setSent({ text, phone });
    reload();
  };
  const STATUS: Record<string, string> = { draft: 'warn', sent: 'warn', partially_received: 'warn', received: 'good', cancelled: 'bad' };
  return (
    <>
      <Table rows={data} error={error} empty="No orders yet." cols={[
        { label: 'Order', value: (r) => r.po_number },
        { label: 'Date', value: (r) => dateOf(r.order_date) },
        { label: 'Supplier', value: (r) => r.supplier },
        { label: 'Items', value: (r) => r.lines, num: true },
        { label: 'Status', value: (r) => <span className={`pill ${STATUS[r.status]}`}>{r.status.replace('_', ' ')}</span> },
        { label: '', value: (r) => (
          <div className="row-actions">
            {['draft', 'sent'].includes(r.status) && <button type="button" className="btn small-btn" onClick={() => void send(r)}>Send on WhatsApp</button>}
            {['draft', 'sent', 'partially_received'].includes(r.status) && <button type="button" className="btn small-btn primary" onClick={() => props.onReceive(r)}>Receive</button>}
          </div>) },
      ]} />
      {sent && (
        <Modal title="Order message" onClose={() => setSent(null)}>
          <pre className="receipt-preview">{sent.text}</pre>
          <div className="row-actions">
            <button type="button" className="btn" onClick={() => void navigator.clipboard.writeText(sent.text)}>Copy</button>
            {sent.phone && <a className="btn primary" target="_blank" rel="noreferrer"
                              href={`https://wa.me/${sent.phone.replace(/\D/g, '').replace(/^0/, '92')}?text=${encodeURIComponent(sent.text)}`}>Open WhatsApp</a>}
          </div>
        </Modal>
      )}
    </>
  );
}

function NewOrder(props: PageProps & { onClose: () => void; onSaved: () => void }) {
  const suppliers = useSuppliers(props);
  const [supplier, setSupplier] = useState('');
  const [lines, setLines] = useState<Line[]>([emptyLine()]);
  const upd = (i: number, patch: Partial<Line>) => setLines((ls) => ls.map((l, j) => (j === i ? { ...l, ...patch } : l)));
  const { busy, error, submit } = useSubmit(() => props.db.ownerCall('create_purchase_order', {
    id: crypto.randomUUID(), branch_id: props.branchId, supplier_id: supplier,
    lines: lines.filter((l) => l.product).map((l) => ({ product_unit_id: l.unitId || l.product!.units[0]!.id, qty: Number(l.qty) || 1, bonus_qty: Number(l.bonus) || 0 })) }), props.onSaved);
  return (
    <Modal title="New purchase order" onClose={props.onClose} wide>
      <form className="stack" onSubmit={submit}>
        <label className="field"><span>Supplier *</span>
          <select required value={supplier} onChange={(e) => setSupplier(e.target.value)}><option value="">Choose…</option>{(suppliers.data ?? []).map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</select>
        </label>
        {lines.map((l, i) => (
          <div key={l.key} className="order-line">
            <ProductPicker {...props} value={l.product} onPick={(p) => upd(i, { product: p, unitId: p.units[0]?.id ?? '' })} />
            <select value={l.unitId} onChange={(e) => upd(i, { unitId: e.target.value })}>{(l.product?.units ?? []).map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}</select>
            <input inputMode="numeric" placeholder="Qty" value={l.qty} onChange={(e) => upd(i, { qty: e.target.value })} />
            <input inputMode="numeric" placeholder="Bonus" value={l.bonus} onChange={(e) => upd(i, { bonus: e.target.value })} />
          </div>
        ))}
        <button type="button" className="btn" onClick={() => setLines((ls) => [...ls, emptyLine()])}>+ Add line</button>
        {error && <div className="form-error">{error}</div>}
        <div className="row-actions"><button type="button" className="btn ghost" onClick={props.onClose}>Cancel</button><button className="btn primary" disabled={busy}>Save order</button></div>
      </form>
    </Modal>
  );
}

interface ReturnRow { id: string; return_number: string; created_at: string; supplier: string; reason: string; status: string; claimed: number | null; settled: number | null }

function Returns(props: PageProps) {
  const [settle, setSettle] = useState<ReturnRow | null>(null);
  const { data, error, reload } = useLoad(() => props.db.office<ReturnRow[]>('returns', props.branchId), []);
  return (
    <>
      <Table rows={data} error={error} empty="No returns to suppliers." cols={[
        { label: 'Return', value: (r) => r.return_number },
        { label: 'Date', value: (r) => dateOf(r.created_at) },
        { label: 'Supplier', value: (r) => r.supplier },
        { label: 'Reason', value: (r) => r.reason.replace('_', ' ') },
        { label: 'Value (cost)', value: (r) => money(r.claimed), num: true },
        { label: 'Credited', value: (r) => money(r.settled), num: true },
        { label: 'Status', value: (r) => (r.status === 'sent' ? <button type="button" className="btn small-btn" onClick={() => setSettle(r)}>Credit note received</button>
                                                                : <span className={`pill ${r.status === 'credited' ? 'good' : 'bad'}`}>{r.status}</span>) },
      ]} />
      {settle && <SettleReturn {...props} row={settle} onClose={() => setSettle(null)} onSaved={() => { setSettle(null); reload(); }} />}
    </>
  );
}

function SettleReturn(props: PageProps & { row: ReturnRow; onClose: () => void; onSaved: () => void }) {
  const [note, setNote] = useState('');
  const [amount, setAmount] = useState(props.row.claimed ? String(props.row.claimed / 100) : '');
  const { busy, error, submit } = useSubmit(() => props.db.ownerCall('settle_purchase_return', props.row.id, note, toPaisa(amount) ?? 0), props.onSaved);
  return (
    <Modal title={`Credit note · ${props.row.return_number}`} onClose={props.onClose}>
      <form className="form-grid" onSubmit={submit}>
        <label className="field"><span>Credit note no.</span><input autoFocus value={note} onChange={(e) => setNote(e.target.value)} /></label>
        <label className="field"><span>Amount credited (Rs)</span><input inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} /></label>
        <p className="muted small span-2">Enter 0 if the supplier refused the return.</p>
        {error && <div className="form-error span-2">{error}</div>}
        <div className="row-actions span-2"><button type="button" className="btn ghost" onClick={props.onClose}>Cancel</button><button className="btn primary" disabled={busy}>Save</button></div>
      </form>
    </Modal>
  );
}

function NewReturn(props: PageProps & { onClose: () => void; onSaved: () => void }) {
  const suppliers = useSuppliers(props);
  const batches = useLoad(() => props.db.office<{ batch_id: string; label: string; qty_base: number }[]>('shelf_batches', props.branchId), []);
  const [supplier, setSupplier] = useState('');
  const [batch, setBatch] = useState('');
  const [qty, setQty] = useState('');
  const [reason, setReason] = useState('expired');
  const { busy, error, submit } = useSubmit(() => props.db.ownerCall('post_purchase_return', {
    id: crypto.randomUUID(), branch_id: props.branchId, supplier_id: supplier, reason, lines: [{ batch_id: batch, qty_base: Number(qty) }] }, null), props.onSaved);
  return (
    <Modal title="Return to supplier" onClose={props.onClose}>
      <form className="form-grid" onSubmit={submit}>
        <label className="field span-2"><span>Supplier *</span><select required value={supplier} onChange={(e) => setSupplier(e.target.value)}><option value="">Choose…</option>{(suppliers.data ?? []).map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</select></label>
        <label className="field span-2"><span>Batch *</span><select required value={batch} onChange={(e) => setBatch(e.target.value)}><option value="">Choose…</option>{(batches.data ?? []).map((b) => <option key={b.batch_id} value={b.batch_id}>{b.label}</option>)}</select></label>
        <label className="field"><span>Quantity (smallest unit) *</span><input required inputMode="numeric" value={qty} onChange={(e) => setQty(e.target.value)} /></label>
        <label className="field"><span>Reason</span><select value={reason} onChange={(e) => setReason(e.target.value)}>
          {['expired', 'short_dated', 'damaged', 'wrong_item', 'recall', 'other'].map((r) => <option key={r} value={r}>{r.replace('_', ' ')}</option>)}</select></label>
        <p className="muted small span-2">Stock leaves now. What you owe the supplier goes down when their credit note arrives.</p>
        {error && <div className="form-error span-2">{error}</div>}
        <div className="row-actions span-2"><button type="button" className="btn ghost" onClick={props.onClose}>Cancel</button><button className="btn primary" disabled={busy}>Send back</button></div>
      </form>
    </Modal>
  );
}
