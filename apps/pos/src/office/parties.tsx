import { useMemo, useState } from 'react';
import { errorText, toPaisa } from '../util.ts';
import { waPhone } from '../wa.ts';
import { messages, RegularMedicines, sendWa, useWaSettings, WaIcon } from './whatsapp.tsx';
import { csvButton, DateRange, dateOf, Modal, money, monthStart, PageHead, Stat, Table, useLoad, useSubmit, type Col, type PageProps } from './ui.tsx';

/** Where money can come from or go to: an open cash drawer, or a bank / wallet account. */
export function useMoneyAccounts(props: PageProps) {
  return useLoad(() => props.db.office<{ kind: 'drawer' | 'bank'; id: string; name: string }[]>('money_accounts', props.branchId), []);
}
const methodFor = (kind: string, name: string) => (kind === 'drawer' ? 'cash' : /jazz/i.test(name) ? 'jazzcash' : /easy/i.test(name) ? 'easypaisa' : 'bank_transfer');

interface Ageing { party_id: string; name: string; balance: number; not_due: number; days_1_30: number; days_31_60: number; days_61_90: number; days_over_90: number; oldest_due: string | null }

// ---- Customers -------------------------------------------------------------------------------
interface CustomerRow { customer_id: string; account_id: string; account_number: string; name: string; phone: string | null; balance: number; credit_limit: number | null;
                        status: string; udhaar_blocked: boolean }

export function Customers(props: PageProps) {
  const [q, setQ] = useState('');
  const [adding, setAdding] = useState(false);
  const [open, setOpen] = useState<CustomerRow | null>(null);
  const { data, error, reload } = useLoad(() => props.db.office<CustomerRow[]>('customers', q.trim()), [q]);
  const ageing = useLoad(() => props.db.ownerTable<Ageing>('party_ageing', 'customer_account', props.today), [data]);
  const owed = (ageing.data ?? []).filter((a) => a.balance > 0);
  const overdue = owed.reduce((s, a) => s + Number(a.days_1_30) + Number(a.days_31_60) + Number(a.days_61_90) + Number(a.days_over_90), 0);
  const cols: Col<CustomerRow>[] = [
    { label: 'Account', value: (r) => r.account_number },
    { label: 'Customer', value: (r) => <><strong>{r.name}</strong><div className="muted small">{r.phone}</div></>, csv: (r) => r.name },
    { label: 'Credit limit', value: (r) => money(r.credit_limit), num: true, csv: (r) => (r.credit_limit ?? 0) / 100 },
    { label: 'Udhaar', value: (r) => (r.udhaar_blocked ? <span className="pill bad">Blocked</span> : r.status === 'over_limit' ? <span className="pill bad">Over limit</span> : <span className="pill good">Allowed</span>), csv: (r) => r.status },
    { label: 'Owes', value: (r) => <strong className={r.balance > 0 ? 'warn-text' : ''}>{money(r.balance)}</strong>, num: true, csv: (r) => r.balance / 100 },
  ];
  return (
    <>
      <PageHead title="Customers & udhaar" sub="Khata accounts, limits, what each customer owes, and recovery">
        {csvButton('customers', data, cols)}
        <button type="button" className="btn primary" onClick={() => setAdding(true)}>+ New customer</button>
      </PageHead>
      <div className="stats">
        <Stat label="Total udhaar to collect" value={money(owed.reduce((s, a) => s + Number(a.balance), 0))} tone="warn" />
        <Stat label="Overdue" value={money(overdue)} tone={overdue ? 'bad' : undefined} />
        <Stat label="Customers who owe" value={owed.length} />
        <Stat label="Over 90 days" value={money(owed.reduce((s, a) => s + Number(a.days_over_90), 0))} />
      </div>
      <div className="filters"><input placeholder="Name, mobile or account no." value={q} onChange={(e) => setQ(e.target.value)} /></div>
      <Table rows={data} error={error} cols={cols} onRow={setOpen} empty="No customers yet." />
      {adding && <NewCustomer {...props} onClose={() => setAdding(false)} onSaved={() => { setAdding(false); reload(); }} />}
      {open && <Khata {...props} type="customer_account" id={open.account_id} title={`${open.name} · ${open.account_number}`}
                      onClose={() => { setOpen(null); reload(); }} />}
    </>
  );
}

function NewCustomer(props: PageProps & { onClose: () => void; onSaved: () => void }) {
  const [f, setF] = useState({ name: '', phone: '', cnic: '', address: '', limit: '', opening: '', days: '30', reminders: true });
  const set = (k: keyof typeof f, v: string | boolean) => setF((x) => ({ ...x, [k]: v }));
  const { busy, error, submit } = useSubmit(() => props.db.ownerCall('create_customer', {
    name: f.name, phone: f.phone || null, cnic: f.cnic || null, address: f.address || null, branch_id: props.branchId,
    default_due_days: Number(f.days) || null, reminders_opt_in: f.reminders,
    ...(f.limit ? { credit_limit: toPaisa(f.limit) } : {}),
    ...(f.opening ? { opening_balance: toPaisa(f.opening), opening_date: props.today } : {}) }, null), props.onSaved);
  return (
    <Modal title="New customer" onClose={props.onClose} wide>
      <form className="form-grid" onSubmit={submit}>
        <label className="field"><span>Name *</span><input required autoFocus value={f.name} onChange={(e) => set('name', e.target.value)} /></label>
        <label className="field"><span>Mobile</span><input value={f.phone} onChange={(e) => set('phone', e.target.value)} placeholder="03xx xxxxxxx" /></label>
        <label className="field"><span>CNIC (optional)</span><input value={f.cnic} onChange={(e) => set('cnic', e.target.value)} /></label>
        <label className="field"><span>Address</span><input value={f.address} onChange={(e) => set('address', e.target.value)} /></label>
        <label className="field"><span>Credit limit (Rs)</span><input inputMode="decimal" value={f.limit} onChange={(e) => set('limit', e.target.value)} placeholder="Blank = no udhaar limit set" /></label>
        <label className="field"><span>Payment period (days)</span><input inputMode="numeric" value={f.days} onChange={(e) => set('days', e.target.value)} /></label>
        <label className="field"><span>Old balance they owe (Rs)</span><input inputMode="decimal" value={f.opening} onChange={(e) => set('opening', e.target.value)} /></label>
        <label className="check"><input type="checkbox" checked={f.reminders} onChange={(e) => set('reminders', e.target.checked)} /> Send WhatsApp reminders</label>
        {error && <div className="form-error span-2">{error}</div>}
        <div className="row-actions span-2"><button type="button" className="btn ghost" onClick={props.onClose}>Cancel</button><button className="btn primary" disabled={busy}>Save customer</button></div>
      </form>
    </Modal>
  );
}

interface Statement { name: string; opening_balance: number; closing_balance: number; total_debit: number; total_credit: number;
                      entries: Array<{ date: string; type: string; reference: string | null; method: string | null; debit: number; credit: number; balance: number }> }

/** A khata: the statement for a period, open bills, and receiving (or paying) money. */
export function Khata(props: PageProps & { type: 'customer_account' | 'supplier'; id: string; title: string; onClose: () => void }) {
  const [from, setFrom] = useState(monthStart(props.today).slice(0, 5) + '01-01');
  const [to, setTo] = useState(props.today);
  const [paying, setPaying] = useState(false);
  const st = useLoad(() => props.db.ownerCall<Statement>('party_statement', props.type, props.id, from, to), [from, to, paying]);
  const bills = useLoad(() => props.db.ownerTable<{ entry_id: string; reference: string | null; entry_date: string; due_date: string | null; amount: number; open_amount: number; days_overdue: number }>(
    'open_bills', props.type, props.id), [paying]);
  const isCust = props.type === 'customer_account';
  const s = st.data;
  const [paid, setPaid] = useState<number | null>(null);
  const [waMsg, setWaMsg] = useState<{ text: string; bad?: boolean } | null>(null);
  const wa = useWaSettings(props);
  const contact = useLoad(() => (isCust ? props.db.office<{ customer_id: string | null; name: string; phone: string | null; balance: number; oldest_bill: string | null; last_reminded_at: string | null }>(
    'customer_contact', props.id) : Promise.resolve(null)), [paying]);
  const m = useMemo(() => (wa.data ? messages(wa.data) : null), [wa.data]);
  const c = contact.data;
  const remind = async () => {
    if (!m || !c) return;
    setWaMsg(null);
    try {
      const days = c.oldest_bill ? Math.max(0, Math.round((Date.parse(props.today) - Date.parse(c.oldest_bill)) / 86_400_000)) : 0;
      await sendWa(props, 'udhaar_reminder', c.phone, m.udhaar({ name: c.name, balance: Number(c.balance), days, oldest_bill: c.oldest_bill }),
        { related_type: 'customer_account', related_id: props.id, balance: c.balance });
      setWaMsg({ text: 'Reminder opened in WhatsApp. Press Send there.' });
    } catch (e) { setWaMsg({ text: errorText(e), bad: true }); }
  };
  const receipt = async () => {
    if (!m || !c || paid === null) return;
    setWaMsg(null);
    try {
      await sendWa(props, 'payment_receipt', c.phone, m.receipt(c.name, paid, Number(c.balance), props.today), { related_type: 'customer_account', related_id: props.id });
      setPaid(null);
      setWaMsg({ text: 'Receipt opened in WhatsApp.' });
    } catch (e) { setWaMsg({ text: errorText(e), bad: true }); }
  };
  return (
    <Modal title={props.title} onClose={props.onClose} wide>
      <div className="stats">
        <Stat label={isCust ? 'Owes you now' : 'You owe now'} value={money(s?.closing_balance)} tone="warn" />
        <Stat label={isCust ? 'Bills (period)' : 'Invoices (period)'} value={money(isCust ? s?.total_debit : s?.total_credit)} />
        <Stat label={isCust ? 'Paid (period)' : 'Paid (period)'} value={money(isCust ? s?.total_credit : s?.total_debit)} />
      </div>
      <div className="filters">
        <DateRange from={from} to={to} onChange={(f, t) => { setFrom(f); setTo(t); }} />
        <button type="button" className="btn primary" onClick={() => { setPaid(null); setPaying(true); }}>{isCust ? 'Receive payment' : 'Pay supplier'}</button>
        {isCust && c && Number(c.balance) > 0 && (
          <button type="button" className="btn wa-btn" disabled={!waPhone(c.phone)} title={waPhone(c.phone) ? '' : 'No mobile number for this customer'} onClick={() => void remind()}>
            <WaIcon /> WhatsApp reminder</button>)}
      </div>
      {isCust && c?.last_reminded_at && <div className="muted small">Last reminder: {new Date(c.last_reminded_at).toLocaleString('en-GB', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })}</div>}
      {paid !== null && isCust && (
        <div className="message info wa-banner">Payment of {money(paid)} saved.
          {waPhone(c?.phone) && <button type="button" className="btn small-btn wa-btn" onClick={() => void receipt()}><WaIcon /> Send receipt on WhatsApp</button>}</div>)}
      {waMsg && <div className={waMsg.bad ? 'form-error' : 'message info'}>{waMsg.text}</div>}
      {paying ? <PaymentForm {...props} onDone={(amount) => { setPaying(false); if (amount) setPaid(amount); }} /> : (
        <>
          <div className="panel-title">Statement (khata)</div>
          <Table rows={s ? [{ date: from, type: 'Opening balance', reference: '', method: null, debit: 0, credit: 0, balance: s.opening_balance }, ...s.entries] : null}
                 error={st.error} cols={[
            { label: 'Date', value: (r) => dateOf(r.date) },
            { label: 'What', value: (r) => r.type.replace(/_/g, ' ') },
            { label: 'Ref', value: (r) => r.reference ?? r.method ?? '' },
            { label: isCust ? 'Bill' : 'Paid', value: (r) => (r.debit ? money(r.debit) : ''), num: true },
            { label: isCust ? 'Paid' : 'Invoice', value: (r) => (r.credit ? money(r.credit) : ''), num: true },
            { label: 'Balance', value: (r) => <strong>{money(r.balance)}</strong>, num: true },
          ]} />
          <div className="panel-title" style={{ marginTop: 12 }}>Unpaid bills</div>
          <Table rows={bills.data} error={bills.error} empty="Nothing unpaid." cols={[
            { label: 'Bill', value: (r) => r.reference ?? 'Opening balance' },
            { label: 'Date', value: (r) => dateOf(r.entry_date) },
            { label: 'Due', value: (r) => dateOf(r.due_date) },
            { label: 'Late', value: (r) => (r.days_overdue > 0 ? <span className="bad-text">{r.days_overdue} days</span> : 'not due'), num: true },
            { label: 'Unpaid', value: (r) => money(r.open_amount), num: true },
          ]} />
          {isCust && c?.customer_id && <RegularMedicines {...props} customerId={c.customer_id} />}
        </>
      )}
    </Modal>
  );
}

function PaymentForm(props: PageProps & { type: 'customer_account' | 'supplier'; id: string; onDone: (amount?: number | null) => void }) {
  const accounts = useMoneyAccounts(props);
  const [amount, setAmount] = useState('');
  const [acc, setAcc] = useState('');
  const [memo, setMemo] = useState('');
  const chosen = (accounts.data ?? []).find((a) => a.id === acc) ?? accounts.data?.[0];
  const { busy, error, submit } = useSubmit(async () => {
    if (!chosen) throw new Error('Open a shift on the counter, or add a bank account, to record money');
    const p = { id: crypto.randomUUID(), amount: toPaisa(amount), method: methodFor(chosen.kind, chosen.name), memo: memo || null, branch_id: props.branchId,
                ...(chosen.kind === 'drawer' ? { drawer_session_id: chosen.id } : { bank_account_id: chosen.id }) };
    if (props.type === 'customer_account') await props.db.ownerCall('receive_udhaar_payment', { ...p, account_id: props.id }, null);
    else await props.db.ownerCall('pay_supplier', { ...p, supplier_id: props.id });
  }, () => props.onDone(toPaisa(amount)));
  return (
    <form className="form-grid panel" onSubmit={submit}>
      <label className="field"><span>Amount (Rs) *</span><input required autoFocus inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} /></label>
      <label className="field"><span>{props.type === 'customer_account' ? 'Received into' : 'Paid from'}</span>
        <select value={chosen?.id ?? ''} onChange={(e) => setAcc(e.target.value)}>{(accounts.data ?? []).map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}</select>
      </label>
      <label className="field span-2"><span>Note</span><input value={memo} onChange={(e) => setMemo(e.target.value)} /></label>
      <p className="muted small span-2">The payment pays the oldest bills first.</p>
      {error && <div className="form-error span-2">{error}</div>}
      <div className="row-actions span-2"><button type="button" className="btn ghost" onClick={() => props.onDone()}>Back</button><button className="btn primary" disabled={busy}>Save payment</button></div>
    </form>
  );
}

// ---- Suppliers -------------------------------------------------------------------------------
interface SupplierRow { id: string; name: string; phone: string | null; payment_terms_days: number | null; balance: number }

export function Suppliers(props: PageProps) {
  const [adding, setAdding] = useState(false);
  const [open, setOpen] = useState<SupplierRow | null>(null);
  const { data, error, reload } = useLoad(() => props.db.office<SupplierRow[]>('suppliers'), []);
  const ageing = useLoad(() => props.db.ownerTable<Ageing>('party_ageing', 'supplier', props.today), [data]);
  const total = (data ?? []).reduce((s, r) => s + Number(r.balance), 0);
  const dueSoon = (ageing.data ?? []).reduce((s, a) => s + Number(a.days_1_30) + Number(a.days_31_60) + Number(a.days_61_90) + Number(a.days_over_90), 0);
  return (
    <>
      <PageHead title="Suppliers" sub="Distributors, what you owe each one, and payments">
        <button type="button" className="btn primary" onClick={() => setAdding(true)}>+ New supplier</button>
      </PageHead>
      <div className="stats">
        <Stat label="You owe suppliers" value={money(total)} tone="warn" />
        <Stat label="Overdue" value={money(dueSoon)} tone={dueSoon ? 'bad' : undefined} />
        <Stat label="Suppliers" value={data?.length ?? '…'} />
      </div>
      <Table rows={data} error={error} onRow={setOpen} cols={[
        { label: 'Supplier', value: (r) => <><strong>{r.name}</strong><div className="muted small">{r.phone}</div></> },
        { label: 'Terms', value: (r) => (r.payment_terms_days ? `${r.payment_terms_days} days` : 'cash') },
        { label: 'You owe', value: (r) => <strong className={r.balance > 0 ? 'warn-text' : ''}>{money(r.balance)}</strong>, num: true },
      ]} />
      {adding && <NewSupplier {...props} onClose={() => setAdding(false)} onSaved={() => { setAdding(false); reload(); }} />}
      {open && <Khata {...props} type="supplier" id={open.id} title={open.name} onClose={() => { setOpen(null); reload(); }} />}
    </>
  );
}

function NewSupplier(props: PageProps & { onClose: () => void; onSaved: () => void }) {
  const [f, setF] = useState({ name: '', contact_name: '', phone: '', city: '', ntn: '', terms: '30' });
  const set = (k: keyof typeof f, v: string) => setF((x) => ({ ...x, [k]: v }));
  const { busy, error, submit } = useSubmit(() => props.db.ownerCall('save_supplier', {
    name: f.name, contact_name: f.contact_name || null, phone: f.phone || null, whatsapp: f.phone || null, city: f.city || null, ntn: f.ntn || null,
    payment_terms_days: Number(f.terms) || 0 }), props.onSaved);
  return (
    <Modal title="New supplier" onClose={props.onClose}>
      <form className="form-grid" onSubmit={submit}>
        <label className="field span-2"><span>Name *</span><input required autoFocus value={f.name} onChange={(e) => set('name', e.target.value)} /></label>
        <label className="field"><span>Contact person</span><input value={f.contact_name} onChange={(e) => set('contact_name', e.target.value)} /></label>
        <label className="field"><span>Mobile / WhatsApp</span><input value={f.phone} onChange={(e) => set('phone', e.target.value)} /></label>
        <label className="field"><span>City</span><input value={f.city} onChange={(e) => set('city', e.target.value)} /></label>
        <label className="field"><span>Payment terms (days)</span><input inputMode="numeric" value={f.terms} onChange={(e) => set('terms', e.target.value)} /></label>
        {error && <div className="form-error span-2">{error}</div>}
        <div className="row-actions span-2"><button type="button" className="btn ghost" onClick={props.onClose}>Cancel</button><button className="btn primary" disabled={busy}>Save supplier</button></div>
      </form>
    </Modal>
  );
}
