import { useState } from 'react';
import { toPaisa } from '../util.ts';
import { MoveMoney } from './extras.tsx';
import { useMoneyAccounts } from './parties.tsx';
import { csvButton, DateRange, dateOf, Modal, money, monthStart, PageHead, Stat, Table, timeOf, useLoad, useSubmit, type Col, type PageProps } from './ui.tsx';

// ---- Expenses --------------------------------------------------------------------------------
interface ExpenseRow { id: string; expense_date: string; category: string; description: string; amount: number; paid_from: string; status: string; by: string | null }

export function Expenses(props: PageProps) {
  const [from, setFrom] = useState(monthStart(props.today));
  const [to, setTo] = useState(props.today);
  const [adding, setAdding] = useState(false);
  const { data, error, reload } = useLoad(() => props.db.office<ExpenseRow[]>('expenses', props.branchId, from, to), [from, to]);
  const posted = (data ?? []).filter((r) => r.status === 'posted');
  const byCat = Object.entries(posted.reduce<Record<string, number>>((m, r) => ({ ...m, [r.category]: (m[r.category] ?? 0) + Number(r.amount) }), {})).sort((a, b) => b[1] - a[1]);
  const cols: Col<ExpenseRow>[] = [
    { label: 'Date', value: (r) => dateOf(r.expense_date), csv: (r) => r.expense_date },
    { label: 'Category', value: (r) => r.category },
    { label: 'What for', value: (r) => r.description },
    { label: 'Paid from', value: (r) => (r.paid_from === 'unpaid' ? <span className="pill warn">Unpaid</span> : r.paid_from.replace('_', ' ')), csv: (r) => r.paid_from },
    { label: 'By', value: (r) => r.by ?? '' },
    { label: 'Amount', value: (r) => (r.status === 'voided' ? <s className="muted">{money(r.amount)}</s> : money(r.amount)), num: true, csv: (r) => r.amount / 100 },
  ];
  return (
    <>
      <PageHead title="Expenses" sub="Rent, bills, tea, repairs: everything the shop spends">
        {csvButton('expenses', data, cols)}
        <button type="button" className="btn primary" onClick={() => setAdding(true)}>+ Add expense</button>
      </PageHead>
      <div className="stats">
        <Stat label="Spent in these dates" value={money(posted.reduce((s, r) => s + Number(r.amount), 0))} />
        {byCat.slice(0, 3).map(([c, v]) => <Stat key={c} label={c} value={money(v)} />)}
      </div>
      <div className="filters"><DateRange from={from} to={to} onChange={(f, t) => { setFrom(f); setTo(t); }} /></div>
      <Table rows={data} error={error} cols={cols} empty="No expenses in these dates." />
      {adding && <AddExpense {...props} onClose={() => setAdding(false)} onSaved={() => { setAdding(false); reload(); }} />}
    </>
  );
}

function AddExpense(props: PageProps & { onClose: () => void; onSaved: () => void }) {
  const cats = useLoad(() => props.db.office<{ id: string; name: string }[]>('expense_categories'), []);
  const accounts = useMoneyAccounts(props);
  const [f, setF] = useState({ category: '', description: '', amount: '', date: props.today, from: '' });
  const set = (k: keyof typeof f, v: string) => setF((x) => ({ ...x, [k]: v }));
  const acc = (accounts.data ?? []).find((a) => a.id === f.from);
  const { busy, error, submit } = useSubmit(() => props.db.ownerCall('post_expense', {
    branch_id: props.branchId, category_id: f.category || cats.data?.[0]?.id, description: f.description, amount: toPaisa(f.amount), expense_date: f.date,
    paid_from: !acc ? 'unpaid' : acc.kind === 'drawer' ? 'drawer' : 'bank_account', ...(acc?.kind === 'drawer' ? { drawer_session_id: acc.id } : acc ? { bank_account_id: acc.id } : {}) }, null), props.onSaved);
  return (
    <Modal title="Add expense" onClose={props.onClose}>
      <form className="form-grid" onSubmit={submit}>
        <label className="field"><span>Category</span><select value={f.category || cats.data?.[0]?.id || ''} onChange={(e) => set('category', e.target.value)}>{(cats.data ?? []).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select></label>
        <label className="field"><span>Date</span><input type="date" value={f.date} onChange={(e) => set('date', e.target.value)} /></label>
        <label className="field span-2"><span>What for *</span><input required autoFocus value={f.description} onChange={(e) => set('description', e.target.value)} placeholder="e.g. K-Electric bill October" /></label>
        <label className="field"><span>Amount (Rs) *</span><input required inputMode="decimal" value={f.amount} onChange={(e) => set('amount', e.target.value)} /></label>
        <label className="field"><span>Paid from</span>
          <select value={f.from} onChange={(e) => set('from', e.target.value)}>
            <option value="">Not paid yet</option>{(accounts.data ?? []).map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
          </select>
        </label>
        {error && <div className="form-error span-2">{error}</div>}
        <div className="row-actions span-2"><button type="button" className="btn ghost" onClick={props.onClose}>Cancel</button><button className="btn primary" disabled={busy}>Save expense</button></div>
      </form>
    </Modal>
  );
}

// ---- Accounts & books ------------------------------------------------------------------------
interface PL { sales: number; returns: number; net_sales: number; cost_of_goods: number; gross_profit: number; expenses: Array<{ category: string; amount: number }>;
               expenses_total: number; salaries: number; net_profit: number; lines_cost_pending: number }
interface TB { as_of: string; total: number; lines: Array<{ account: string; type: string; debit: number; credit: number }> }

export function Accounts(props: PageProps) {
  const [tab, setTab] = useState<'cash' | 'pl' | 'tb'>('cash');
  const [from, setFrom] = useState(monthStart(props.today));
  const [to, setTo] = useState(props.today);
  return (
    <>
      <PageHead title="Accounts & books" sub="Where the money is, what the business earned, and the accountant's trial balance" />
      <div className="tabs">
        {([['cash', 'Cash book'], ['pl', 'Profit & loss'], ['tb', 'Trial balance']] as const).map(([k, l]) => (
          <button key={k} type="button" className={`tab${tab === k ? ' on' : ''}`} onClick={() => setTab(k)}>{l}</button>
        ))}
      </div>
      {tab !== 'tb' && <div className="filters"><DateRange from={from} to={to} onChange={(f, t) => { setFrom(f); setTo(t); }} /></div>}
      {tab === 'cash' && <CashBook {...props} from={from} to={to} />}
      {tab === 'pl' && <ProfitLoss {...props} from={from} to={to} />}
      {tab === 'tb' && <TrialBalance {...props} />}
    </>
  );
}

function CashBook(props: PageProps & { from: string; to: string }) {
  const balances = useLoad(() => props.db.office<{ kind: string; id: string; name: string; balance: number }[]>('balances'), []);
  const [moving, setMoving] = useState(false);
  const [acc, setAcc] = useState<string>('all');
  const moves = useLoad(() => props.db.office<{ occurred_at: string; account: string; movement_type: string; memo: string | null; amount: number; who: string | null }[]>('cash_moves', props.from, props.to, acc), [props.from, props.to, acc]);
  const cashIn = (moves.data ?? []).filter((m) => m.amount > 0).reduce((s, m) => s + Number(m.amount), 0);
  const cashOut = (moves.data ?? []).filter((m) => m.amount < 0).reduce((s, m) => s - Number(m.amount), 0);
  return (
    <>
      <div className="stats">
        {(balances.data ?? []).map((b) => <Stat key={b.id} label={b.kind === 'drawer' ? `Cash in hand · ${b.name}` : b.name} value={money(b.balance)} />)}
      </div>
      <div className="filters">
        <select value={acc} onChange={(e) => setAcc(e.target.value)}>
          <option value="all">All accounts</option>{(balances.data ?? []).map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
        </select>
        <span className="muted">Money in <strong className="good-text">{money(cashIn)}</strong> · money out <strong className="bad-text">{money(cashOut)}</strong></span>
        <button type="button" className="btn primary" onClick={() => setMoving(true)}>Move money</button>
      </div>
      {moving && <MoveMoney {...props} onClose={() => setMoving(false)} onSaved={() => { setMoving(false); balances.reload(); moves.reload(); }} />}
      <Table rows={moves.data} error={moves.error} empty="No money moved in these dates." cols={[
        { label: 'When', value: (r) => timeOf(r.occurred_at) },
        { label: 'Account', value: (r) => r.account },
        { label: 'What', value: (r) => r.movement_type.replace(/_/g, ' ') },
        { label: 'Note', value: (r) => r.memo ?? '' },
        { label: 'By', value: (r) => r.who ?? '' },
        { label: 'In', value: (r) => (r.amount > 0 ? money(r.amount) : ''), num: true },
        { label: 'Out', value: (r) => (r.amount < 0 ? money(-r.amount) : ''), num: true },
      ]} />
    </>
  );
}

function ProfitLoss(props: PageProps & { from: string; to: string }) {
  const { data, error } = useLoad(() => props.db.ownerCall<PL>('report_profit_and_loss', props.from, props.to, null), [props.from, props.to]);
  if (error) return <div className="form-error">{error}</div>;
  if (!data) return <div className="loading-row"><span className="spinner small" /> Loading…</div>;
  const row = (label: string, v: number, strong = false, minus = false) => (
    <div className={`pl-row${strong ? ' strong' : ''}`}><span>{label}</span><span>{minus && v ? '− ' : ''}{money(v)}</span></div>
  );
  return (
    <div className="grid-2">
      <section className="panel pl">
        {row('Sales', data.sales)}{row('Less: returns', data.returns, false, true)}{row('Net sales', data.net_sales, true)}
        {row('Cost of medicines sold', data.cost_of_goods, false, true)}{row('Gross profit', data.gross_profit, true)}
        {data.expenses.map((e) => <div key={e.category}>{row(e.category, e.amount, false, true)}</div>)}
        {row('Salaries', data.salaries, false, true)}
        <div className={`pl-row total ${data.net_profit < 0 ? 'bad-text' : 'good-text'}`}><span>Net profit</span><span>{money(data.net_profit)}</span></div>
      </section>
      <section className="panel">
        <div className="panel-title">How this is worked out</div>
        <p className="muted">Sales and returns come from the bills; cost of medicines from each batch's average purchase cost (bonus stock lowers it). Expenses count when they are owed, salaries when paid.</p>
        {data.lines_cost_pending > 0 && <div className="message info">{data.lines_cost_pending} sold line(s) have no purchase cost yet (stock received without an invoice), so profit may be higher than shown.</div>}
      </section>
    </div>
  );
}

function TrialBalance(props: PageProps) {
  const { data, error } = useLoad(() => props.db.ownerCall<TB>('trial_balance', props.today), []);
  const cols: Col<TB['lines'][number]>[] = [
    { label: 'Account', value: (r) => r.account },
    { label: 'Type', value: (r) => r.type },
    { label: 'Debit', value: (r) => (r.debit ? money(r.debit) : ''), num: true, csv: (r) => r.debit / 100 },
    { label: 'Credit', value: (r) => (r.credit ? money(r.credit) : ''), num: true, csv: (r) => r.credit / 100 },
  ];
  return (
    <>
      <div className="filters"><span className="muted">As of {dateOf(data?.as_of)}</span>{csvButton('trial-balance', data?.lines ?? null, cols)}</div>
      <Table rows={data ? [...data.lines, { account: 'Total', type: '', debit: data.total, credit: data.total }] : null} error={error} cols={cols} />
    </>
  );
}

// ---- Reports ---------------------------------------------------------------------------------
type ReportKey = 'sales_day' | 'sales_product' | 'sales_staff' | 'sales_hour' | 'payments' | 'profit_product' | 'stock_value' | 'dead_stock' | 'purchases_supplier' | 'collections' | 'staff';
const REPORTS: Array<{ key: ReportKey; group: string; label: string }> = [
  { key: 'sales_day', group: 'Sale', label: 'Sales by day' }, { key: 'sales_product', group: 'Sale', label: 'Sales by medicine' },
  { key: 'sales_staff', group: 'Sale', label: 'Sales by staff' }, { key: 'sales_hour', group: 'Sale', label: 'Sales by hour' },
  { key: 'payments', group: 'Sale', label: 'Sales by payment method' }, { key: 'profit_product', group: 'Profit', label: 'Profit by medicine' },
  { key: 'stock_value', group: 'Stock', label: 'Stock value' }, { key: 'dead_stock', group: 'Stock', label: 'Dead stock (90 days)' },
  { key: 'purchases_supplier', group: 'Purchase', label: 'Purchases by supplier' }, { key: 'collections', group: 'Ledger', label: 'Udhaar collections' },
  { key: 'staff', group: 'Staff', label: 'Staff performance' },
];
const PRESETS = (today: string): Array<[string, string, string]> => {
  const d = (n: number) => new Date(Date.parse(today) - n * 86_400_000).toISOString().slice(0, 10);
  return [['Today', today, today], ['Yesterday', d(1), d(1)], ['Last 7 days', d(6), today], ['This month', monthStart(today), today], ['Last 30 days', d(29), today]];
};

export function Reports(props: PageProps) {
  const [key, setKey] = useState<ReportKey>('sales_day');
  const [from, setFrom] = useState(monthStart(props.today));
  const [to, setTo] = useState(props.today);
  const load = (): Promise<Array<Record<string, unknown>>> => {
    const t = props.db.ownerTable.bind(props.db);
    switch (key) {
      case 'sales_day': return t('report_sales', from, to, 'day', null);
      case 'sales_product': return t('report_sales', from, to, 'product', null);
      case 'sales_staff': return t('report_sales', from, to, 'staff', null);
      case 'sales_hour': return t('report_sales', from, to, 'hour', null);
      case 'payments': return t('report_payments', from, to, null);
      case 'profit_product': return t('report_profit', from, to, 'product', null);
      case 'stock_value': return t('report_stock_valuation', null);
      case 'dead_stock': return t('report_dead_stock', 90, null);
      case 'purchases_supplier': return t('report_purchases', from, to, 'supplier', null);
      case 'collections': return t('report_collections', from, to);
      case 'staff': return t('report_staff', from, to, null);
    }
  };
  const { data, error } = useLoad(load, [key, from, to]);
  const cols: Col<Record<string, unknown>>[] = data?.[0]
    ? Object.keys(data[0]).filter((k) => !['key', 'product_id', 'user_id', 'tax'].includes(k)).map((k) => {
        const isMoney = /sales|revenue|cogs|profit|value|amount|discount|returns|gross|net|tax|short/.test(k) && !/bp$|qty|bills|lines|deliveries/.test(k);
        return { label: k.replace(/_/g, ' '), num: typeof data[0]![k] === 'number' || /^\d+$/.test(String(data[0]![k] ?? '')),
                 value: (r) => (isMoney ? money(r[k]) : k.endsWith('_bp') ? `${(Number(r[k] ?? 0) / 100).toFixed(1)}%` : String(r[k] ?? '')),
                 csv: (r) => (isMoney ? Number(r[k] ?? 0) / 100 : (r[k] as string | number | null)) };
      })
    : [];
  const current = REPORTS.find((r) => r.key === key)!;
  const noDates = key === 'stock_value' || key === 'dead_stock';
  return (
    <div className="reports">
      <aside className="report-list">
        {[...new Set(REPORTS.map((r) => r.group))].map((g) => (
          <div key={g}><div className="nav-group-label">{g}</div>
            {REPORTS.filter((r) => r.group === g).map((r) => (
              <button key={r.key} type="button" className={`nav-item${key === r.key ? ' on' : ''}`} onClick={() => setKey(r.key)}>{r.label}</button>
            ))}
          </div>
        ))}
      </aside>
      <section className="report-body">
        <PageHead title={current.label}>{csvButton(current.label.toLowerCase().replace(/\W+/g, '-'), data, cols)}<button type="button" className="btn" onClick={() => window.print()}>Print / PDF</button></PageHead>
        {!noDates && (
          <div className="filters">
            {PRESETS(props.today).map(([l, f, t]) => <button key={l} type="button" className={`chip${from === f && to === t ? ' on' : ''}`} onClick={() => { setFrom(f); setTo(t); }}>{l}</button>)}
            <DateRange from={from} to={to} onChange={(f, t) => { setFrom(f); setTo(t); }} />
          </div>
        )}
        <Table rows={data} error={error} cols={cols} empty="No data for these dates." />
        {key.startsWith('profit') && <p className="muted small">Profit = what the medicine sold for (after discounts) minus its average purchase cost in that batch.</p>}
      </section>
    </div>
  );
}
