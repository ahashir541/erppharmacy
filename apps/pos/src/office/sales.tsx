import { formatReceipt } from '@medflow/core';
import { useState } from 'react';
import type { Receipt } from '../backend/types.ts';
import { receiptData } from '../screens/Dialogs.tsx';
import { csvButton, DateRange, dateOf, Modal, money, PageHead, Stat, Table, timeOf, useLoad, type Col, type PageProps } from './ui.tsx';

interface Dash {
  date: string;
  periods: Record<'today' | 'week' | 'month', { sales: number; bills: number; previous_sales: number; change_bp: number | null; gross_profit?: number; margin_bp?: number | null; lines_cost_pending?: number }>;
  top_products: Array<{ name: string; sales: number; qty: number }>;
  top_by_profit?: Array<{ name: string; profit: number }>;
  attention: { voids_today: number; discounts_today: number; returns_today: number; open_flags: number; pending_approvals: number };
  cash_in_open_drawers?: number;
  udhaar_receivable?: number;
  udhaar_given_today?: number;
  udhaar_collected_today?: number;
  supplier_payable?: number;
  expiring_90_days_cost?: number;
  dead_stock_cost?: number;
  cash_short_over_month?: Array<{ staff: string; variance: number; closings: number }>;
}

const change = (bp: number | null | undefined) => (bp === null || bp === undefined ? 'no earlier sales' : `${bp >= 0 ? '▲' : '▼'} ${Math.abs(bp / 100).toFixed(1)}% vs before`);

export function Dashboard(props: PageProps) {
  const { data, error } = useLoad(() => props.db.ownerCall<Dash>('owner_dashboard'), []);
  if (error) return <div className="form-error">{error}</div>;
  if (!data) return <div className="loading-row"><span className="spinner small" /> Loading…</div>;
  const p = data.periods;
  return (
    <>
      <PageHead title="Dashboard" sub={`Business today, ${dateOf(data.date)}`} />
      <div className="stats">
        <Stat label="Sales today" value={money(p.today.sales)} sub={`${p.today.bills} bills · ${change(p.today.change_bp)}`} />
        <Stat label="Profit today" value={money(p.today.gross_profit)} sub={p.today.margin_bp !== null && p.today.margin_bp !== undefined ? `${(p.today.margin_bp / 100).toFixed(1)}% margin` : ''} tone="good" />
        <Stat label="This week" value={money(p.week.sales)} sub={change(p.week.change_bp)} />
        <Stat label="This month" value={money(p.month.sales)} sub={`Profit ${money(p.month.gross_profit)}`} />
      </div>
      <div className="stats">
        <Stat label="Cash in open drawers" value={money(data.cash_in_open_drawers)} />
        <Stat label="Udhaar to collect" value={money(data.udhaar_receivable)} sub={`Given today ${money(data.udhaar_given_today)} · collected ${money(data.udhaar_collected_today)}`} tone="warn" />
        <Stat label="Owed to suppliers" value={money(data.supplier_payable)} />
        <Stat label="Expiring in 90 days (cost)" value={money(data.expiring_90_days_cost)} sub={`Dead stock ${money(data.dead_stock_cost)}`} tone="bad" />
      </div>
      <div className="grid-2">
        <section className="panel">
          <div className="panel-title">Needs attention</div>
          <ul className="attention">
            <li><span>Approvals waiting</span><strong>{data.attention.pending_approvals}</strong></li>
            <li><span>Voids today</span><strong>{data.attention.voids_today}</strong></li>
            <li><span>Returns today</span><strong>{data.attention.returns_today}</strong></li>
            <li><span>Discounts given today</span><strong>{money(data.attention.discounts_today)}</strong></li>
            <li><span>Open flags from offline sales</span><strong>{data.attention.open_flags}</strong></li>
          </ul>
          {data.cash_short_over_month && data.cash_short_over_month.length > 0 && (
            <>
              <div className="panel-title" style={{ marginTop: 12 }}>Cash short / over this month</div>
              <ul className="attention">
                {data.cash_short_over_month.map((s) => (
                  <li key={s.staff}><span>{s.staff} ({s.closings} closings)</span><strong className={s.variance < 0 ? 'bad-text' : ''}>{money(s.variance)}</strong></li>
                ))}
              </ul>
            </>
          )}
        </section>
        <section className="panel">
          <div className="panel-title">Top medicines this month</div>
          <Table rows={data.top_products} empty="No sales this month yet. Make a sale on the POS."
                 cols={[{ label: 'Medicine', value: (r) => r.name }, { label: 'Qty', value: (r) => r.qty, num: true }, { label: 'Sales', value: (r) => money(r.sales), num: true }]} />
        </section>
      </div>
    </>
  );
}

interface InvoiceRow { id: string; invoice_number: string; sold_at: string; status: string; grand_total: number; udhaar_amount: number; discount_total: number;
                       cashier: string; customer: string | null }

export function Invoices(props: PageProps) {
  const [from, setFrom] = useState(props.today);
  const [to, setTo] = useState(props.today);
  const [status, setStatus] = useState('all');
  const [q, setQ] = useState('');
  const [open, setOpen] = useState<InvoiceRow | null>(null);
  const { data, error } = useLoad(() => props.db.ownerRows<InvoiceRow>(`
    select s.id, s.invoice_number, s.sold_at, s.status, s.grand_total, s.udhaar_amount, s.discount_total,
           (select full_name from users where id = s.created_by) cashier, (select name from customers where id = s.customer_id) customer
    from owner_sales s
    where s.business_date between $1 and $2
      and ($3 = 'all' or ($3 = 'udhaar' and s.udhaar_amount > 0 and s.status = 'completed') or ($3 = 'paid' and s.udhaar_amount = 0 and s.status = 'completed') or s.status = $3)
      and ($4 = '' or s.invoice_number ilike '%' || $4 || '%' or exists (select 1 from customers c where c.id = s.customer_id and (c.name ilike '%' || $4 || '%' or c.phone like '%' || $4 || '%')))
    order by s.sold_at desc limit 500`, [from, to, status, q.trim()]), [from, to, status, q]);
  const done = (data ?? []).filter((r) => r.status === 'completed');
  const cols: Col<InvoiceRow>[] = [
    { label: 'Bill', value: (r) => r.invoice_number },
    { label: 'Time', value: (r) => timeOf(r.sold_at), csv: (r) => r.sold_at },
    { label: 'Customer', value: (r) => r.customer ?? 'Walk-in' },
    { label: 'Cashier', value: (r) => r.cashier },
    { label: 'Status', value: (r) => (r.status === 'voided' ? <span className="pill bad">Void</span> : r.udhaar_amount > 0 ? <span className="pill warn">Udhaar</span> : <span className="pill good">Paid</span>),
      csv: (r) => (r.status === 'voided' ? 'void' : r.udhaar_amount > 0 ? 'udhaar' : 'paid') },
    { label: 'Total', value: (r) => money(r.grand_total), num: true, csv: (r) => r.grand_total / 100 },
  ];
  return (
    <>
      <PageHead title="Sales & invoices" sub="Every bill, who sold it, and how it was paid">{csvButton('invoices', data, cols)}</PageHead>
      <div className="stats">
        <Stat label="Sales" value={money(done.reduce((s, r) => s + r.grand_total, 0))} />
        <Stat label="Bills" value={done.length} />
        <Stat label="On udhaar" value={money(done.reduce((s, r) => s + r.udhaar_amount, 0))} tone="warn" />
        <Stat label="Discounts" value={money(done.reduce((s, r) => s + r.discount_total, 0))} />
      </div>
      <div className="filters">
        <DateRange from={from} to={to} onChange={(f, t) => { setFrom(f); setTo(t); }} />
        <select value={status} onChange={(e) => setStatus(e.target.value)}>
          <option value="all">All bills</option><option value="paid">Paid</option><option value="udhaar">Udhaar</option><option value="voided">Void</option>
        </select>
        <input placeholder="Bill number, customer or mobile" value={q} onChange={(e) => setQ(e.target.value)} />
      </div>
      <Table rows={data} error={error} cols={cols} onRow={setOpen} empty="No bills in these dates." />
      {open && <InvoiceModal {...props} invoice={open} onClose={() => setOpen(null)} />}
    </>
  );
}

function InvoiceModal(props: PageProps & { invoice: InvoiceRow; onClose: () => void }) {
  const { data } = useLoad(() => props.db.ownerCall<Receipt>('get_receipt', props.invoice.id), [props.invoice.id]);
  return (
    <Modal title={`Bill ${props.invoice.invoice_number}`} onClose={props.onClose}>
      {data ? <pre className="receipt-preview">{formatReceipt(receiptData(data, props.invoice.cashier, props.invoice.customer, null), 80).join('\n')}</pre>
            : <div className="loading-row"><span className="spinner small" /></div>}
    </Modal>
  );
}

interface ShiftRow { id: string; drawer: string; opened_by: string; closed_by: string | null; opened_at: string; closed_at: string | null; status: string;
                     opening_float: number; counted_cash: number | null; expected_cash: number | null; variance: number | null; in_drawer_now: number | null; bills: number }

export function Shifts(props: PageProps) {
  const [from, setFrom] = useState(props.today.slice(0, 8) + '01');
  const [to, setTo] = useState(props.today);
  const { data, error } = useLoad(() => props.db.ownerRows<ShiftRow>(`
    select ds.id, d.name drawer, (select full_name from users where id = ds.opened_by) opened_by, (select full_name from users where id = ds.closed_by) closed_by,
           ds.opened_at, ds.closed_at, ds.status, ds.opening_float, ds.counted_cash, r.expected_cash, r.variance,
           case when ds.status = 'open' then (select balance from money_balances where account_kind = 'drawer_session' and account_id = ds.id) end in_drawer_now,
           (select count(distinct sale_id) from sale_payments sp where sp.drawer_session_id = ds.id)::int bills
    from drawer_sessions ds join cash_drawers d on d.id = ds.cash_drawer_id
    left join drawer_session_reconciliations r on r.drawer_session_id = ds.id
    where ds.opened_at::date between $1 and $2 order by ds.opened_at desc`, [from, to]), [from, to]);
  return (
    <>
      <PageHead title="Shifts" sub="Each cashier's drawer: what was counted and what was expected. Staff never see the expected amount." />
      <div className="filters"><DateRange from={from} to={to} onChange={(f, t) => { setFrom(f); setTo(t); }} /></div>
      <Table rows={data} error={error} empty="No shifts in these dates." cols={[
        { label: 'Opened', value: (r) => timeOf(r.opened_at) },
        { label: 'Cashier', value: (r) => r.opened_by },
        { label: 'Drawer', value: (r) => r.drawer },
        { label: 'Bills', value: (r) => r.bills, num: true },
        { label: 'Opening cash', value: (r) => money(r.opening_float), num: true },
        { label: 'Expected', value: (r) => (r.status === 'open' ? money(r.in_drawer_now) : money(r.expected_cash)), num: true },
        { label: 'Counted', value: (r) => (r.status === 'open' ? <span className="pill good">Open now</span> : money(r.counted_cash)), num: true },
        { label: 'Short / over', value: (r) => (r.variance === null ? '—' : <strong className={r.variance < 0 ? 'bad-text' : r.variance > 0 ? 'warn-text' : 'good-text'}>{money(r.variance)}</strong>), num: true },
      ]} />
    </>
  );
}
