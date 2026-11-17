// Smaller pieces used by several pages: the 7-day sales chart, a medicine's detail drawer, and
// moving money between the drawer, the safe and bank / wallet accounts.
import { useState } from 'react';
import { toPaisa } from '../util.ts';
import { dateOf, Modal, money, Table, timeOf, useLoad, useSubmit, type PageProps } from './ui.tsx';

export function SalesTrend(props: PageProps) {
  const { data } = useLoad(() => props.db.office<Array<{ day: string; sales: number; bills: number }>>('sales_trend', props.today), []);
  if (!data) return <div className="panel chart-panel"><div className="skeleton" style={{ height: 160 }} /></div>;
  const max = Math.max(1, ...data.map((d) => Number(d.sales)));
  const total = data.reduce((s, d) => s + Number(d.sales), 0);
  return (
    <section className="panel chart-panel" aria-label="Sales in the last 7 days">
      <div className="row-between"><div className="panel-title">Last 7 days</div><span className="muted small">{money(total)} · {data.reduce((s, d) => s + Number(d.bills), 0)} bills</span></div>
      <div className="bars">
        {data.map((d) => {
          const h = Math.round((Number(d.sales) / max) * 100);
          const label = new Date(d.day).toLocaleDateString('en-GB', { weekday: 'short' });
          return (
            <div key={d.day} className="bar-col" title={`${dateOf(d.day)}: ${money(d.sales)}, ${d.bills} bills`}>
              <span className="bar-value">{Number(d.sales) ? money(d.sales).replace(/\.00$/, '') : ''}</span>
              <div className="bar" style={{ height: `${Math.max(h, Number(d.sales) ? 3 : 0)}%` }} />
              <span className="bar-label">{label}</span>
            </div>
          );
        })}
      </div>
    </section>
  );
}

interface Detail {
  batches: Array<{ batch_number: string; expiry_date: string; qty_base: number; days_left: number; mrp: number | null; retail_price: number | null; blocked: boolean }>;
  prices: Array<{ at: string; kind: string; unit: string; amount: number; by: string | null }>;
  movements: Array<{ occurred_at: string; movement_type: string; qty_base: number; batch_number: string; who: string | null }>;
}

export function ProductDrawer(props: PageProps & { productId: string; name: string; onClose: () => void }) {
  const { data, error } = useLoad(() => props.db.office<Detail>('product_detail', props.productId, props.branchId), [props.productId]);
  const sev = (d: number) => (d < 0 ? ['bad', 'Expired'] : d < 30 ? ['bad', `${d} days`] : d <= 90 ? ['warn', `${d} days`] : ['good', `${d} days`]);
  return (
    <div className="drawer-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget) props.onClose(); }}>
      <aside className="drawer" role="dialog" aria-label={props.name}>
        <div className="modal-head"><h2>{props.name}</h2><button type="button" className="icon-btn" onClick={props.onClose} aria-label="Close">×</button></div>
        {error && <div className="form-error">{error}</div>}
        <div className="panel-title">Batches on the shelf (sells first at the top)</div>
        <Table rows={data?.batches ?? null} empty="No stock." cols={[
          { label: 'Batch', value: (r) => <>{r.batch_number}{r.blocked && <span className="tag ctl">Recalled</span>}</> },
          { label: 'Expiry', value: (r) => { const [tone, text] = sev(r.days_left); return <><span className={`pill ${tone}`}>{text}</span> <span className="muted small">{dateOf(r.expiry_date)}</span></>; } },
          { label: 'Qty', value: (r) => r.qty_base, num: true },
          { label: 'Price', value: (r) => money(r.retail_price), num: true },
        ]} />
        <div className="panel-title">Price history</div>
        <Table rows={data?.prices ?? null} empty="No price set." cols={[
          { label: 'From', value: (r) => timeOf(r.at) }, { label: 'Pack', value: (r) => r.unit },
          { label: 'Price', value: (r) => money(r.amount), num: true }, { label: 'By', value: (r) => r.by ?? '' },
        ]} />
        <div className="panel-title">Latest movements</div>
        <Table rows={data?.movements ?? null} empty="Nothing yet." cols={[
          { label: 'When', value: (r) => timeOf(r.occurred_at) }, { label: 'Type', value: (r) => r.movement_type.replace(/_/g, ' ') },
          { label: 'Batch', value: (r) => r.batch_number },
          { label: 'Qty', value: (r) => <span className={r.qty_base < 0 ? 'bad-text' : 'good-text'}>{r.qty_base > 0 ? `+${r.qty_base}` : r.qty_base}</span>, num: true },
          { label: 'By', value: (r) => r.who ?? '' },
        ]} />
      </aside>
    </div>
  );
}

export function MoveMoney(props: PageProps & { onClose: () => void; onSaved: () => void }) {
  const { data } = useLoad(() => props.db.office<Array<{ kind: 'drawer' | 'bank'; id: string; name: string; balance: number }>>('balances'), []);
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [amount, setAmount] = useState('');
  const [memo, setMemo] = useState('');
  const accounts = data ?? [];
  const f = accounts.find((a) => a.id === from) ?? accounts[0];
  const t = accounts.find((a) => a.id === to) ?? accounts.find((a) => a.id !== f?.id);
  const { busy, error, submit } = useSubmit(() => props.db.ownerCall('transfer_money', {
    from_kind: f?.kind, from_id: f?.id, to_kind: t?.kind, to_id: t?.id, amount: toPaisa(amount), memo: memo || null }), props.onSaved);
  return (
    <Modal title="Move money" onClose={props.onClose}>
      <form className="form-grid" onSubmit={submit}>
        <label className="field"><span>From</span><select value={f?.id ?? ''} onChange={(e) => setFrom(e.target.value)}>{accounts.map((a) => <option key={a.id} value={a.id}>{a.name} ({money(a.balance)})</option>)}</select></label>
        <label className="field"><span>To</span><select value={t?.id ?? ''} onChange={(e) => setTo(e.target.value)}>{accounts.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}</select></label>
        <label className="field"><span>Amount (Rs) *</span><input required autoFocus inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} /></label>
        <label className="field"><span>Note</span><input value={memo} onChange={(e) => setMemo(e.target.value)} placeholder="e.g. Deposited at Meezan" /></label>
        <p className="muted small span-2">For cash taken from the drawer to the safe or the bank, a wallet balance sent to the bank, or change put into the drawer.</p>
        {error && <div className="form-error span-2">{error}</div>}
        <div className="row-actions span-2"><button type="button" className="btn ghost" onClick={props.onClose}>Cancel</button><button className="btn primary" disabled={busy}>Move</button></div>
      </form>
    </Modal>
  );
}
