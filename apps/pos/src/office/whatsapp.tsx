// WhatsApp & reminders: one button per message, on Nuskha Local and Nuskha Cloud alike.
//  - Udhaar reminders: who owes, how much, for how many days; "send next" walks the due list.
//  - Payment receipts and khata reminders (from the customer's khata).
//  - Refill reminders for regular medicines.
//  - Low stock lists to the supplier who last delivered.
//  - The owner's daily summary.
// Each opens WhatsApp with the message ready and is logged in the history.
import { useMemo, useState } from 'react';
import { errorText } from '../util.ts';
import { amt, DEFAULTS, fill, openWa, reorderText, setWaMode, signature, summaryText, waDate, waMode, waPhone, type WaLang, type WaMode } from '../wa.ts';
import { ProductPicker } from './purchases.tsx';
import { printUdhaarLetter } from '../letter.ts';
import { dateOf, money, PageHead, Stat, Table, timeOf, useLoad, useSubmit, type PageProps } from './ui.tsx';

export interface WaSettings {
  pharmacy: string; owner_phone: string | null; number: string | null; owner_number: string | null; language: WaLang; interval_days: number;
  template_udhaar: string | null; template_refill: string | null; address?: string | null; phone?: string | null;
}
export interface DueRow {
  account_id: string; customer_id: string | null; account_number: string; name: string; phone: string | null; reminders_on: boolean;
  balance: number; overdue: number; oldest_bill: string | null; days: number; days_late: number; last_reminded_at: string | null; due: boolean;
}
interface RefillRow { id: string; customer_id: string; name: string; phone: string | null; medicine: string; interval_days: number; last_bought: string | null;
  next_due: string; days_left: number; reminded_at: string | null }
interface ReorderRow { product_id: string; name: string; stock: number; reorder_level: number | null; base_unit: string | null;
  supplier_id: string | null; supplier: string | null; supplier_whatsapp: string | null }

export const useWaSettings = (props: PageProps) => useLoad(() => props.db.office<WaSettings>('whatsapp_settings'), []);

/** Message builders that use the owner's language, wording and signature. */
export function messages(s: WaSettings) {
  const sign = signature(s.pharmacy, s.number);
  const lang = s.language ?? 'ur';
  return {
    udhaar: (r: { name: string; balance: number; days: number; oldest_bill: string | null }) =>
      fill(s.template_udhaar || DEFAULTS.udhaar[lang], { name: r.name, amount: amt(r.balance), days: r.days, since: waDate(r.oldest_bill), pharmacy: s.pharmacy, sign }),
    receipt: (name: string, paid: number, balance: number, date: string) =>
      fill(DEFAULTS.receipt[lang], { name, paid: amt(paid), balance: amt(balance), date: waDate(date), pharmacy: s.pharmacy, sign }),
    refill: (r: { name: string; medicine: string }) =>
      fill(s.template_refill || DEFAULTS.refill[lang], { name: r.name, medicine: r.medicine, pharmacy: s.pharmacy, sign }),
    sign,
    lang,
  };
}

/** Opens WhatsApp first (still inside the click), then logs the message. */
export async function sendWa(props: PageProps, kind: string, phone: string | null, body: string, extra: Record<string, unknown> = {}) {
  const to = waPhone(phone);
  if (!to) throw new Error('This customer has no valid mobile number. Add one like 03001234567.');
  openWa(to, body);
  await props.db.ownerCall('log_whatsapp', { kind, to_phone: to, body, ...extra });
}

type Tab = 'udhaar' | 'refills' | 'reorder' | 'summary' | 'history' | 'setup';

export function WhatsApp(props: PageProps) {
  const [tab, setTab] = useState<Tab>('udhaar');
  const settings = useWaSettings(props);
  const s = settings.data;
  const tabs: Array<[Tab, string]> = [['udhaar', 'Udhaar reminders'], ['refills', 'Refill reminders'], ['reorder', 'Low stock to suppliers'],
    ['summary', 'Daily summary'], ['history', 'History'], ['setup', 'Setup']];
  return (
    <>
      <PageHead title="WhatsApp & reminders" sub="One button: Nuskha writes the message and opens WhatsApp, you press Send" />
      {s && !s.number && tab !== 'setup' && (
        <div className="message info wa-banner">Add your pharmacy's WhatsApp number so customers know who the message is from.
          <button type="button" className="btn small-btn" onClick={() => setTab('setup')}>Add number</button></div>
      )}
      <div className="tabs">{tabs.map(([k, label]) => <button key={k} type="button" className={`tab${tab === k ? ' on' : ''}`} onClick={() => setTab(k)}>{label}</button>)}</div>
      {settings.error && <div className="form-error">{settings.error}</div>}
      {s && (
        <div className="wa-body">
          {tab === 'udhaar' && <UdhaarReminders {...props} s={s} />}
          {tab === 'refills' && <Refills {...props} s={s} />}
          {tab === 'reorder' && <Reorder {...props} s={s} />}
          {tab === 'summary' && <DailySummary {...props} s={s} />}
          {tab === 'history' && <History {...props} />}
          {tab === 'setup' && <Setup {...props} s={s} onSaved={settings.reload} />}
        </div>
      )}
    </>
  );
}

// ---- Udhaar reminders ----------------------------------------------------------------------
function UdhaarReminders(props: PageProps & { s: WaSettings }) {
  const list = useLoad(() => props.db.office<DueRow[]>('udhaar_reminders', props.today), []);
  const [sent, setSent] = useState<Record<string, boolean>>({});
  const [msg, setMsg] = useState<{ text: string; bad?: boolean } | null>(null);
  const [onlyDue, setOnlyDue] = useState(false);
  const m = useMemo(() => messages(props.s), [props.s]);
  const rows = list.data ?? null;
  const queue = (rows ?? []).filter((r) => r.due && !sent[r.account_id]);
  const dueTotal = (rows ?? []).filter((r) => r.due).length;
  const send = async (r: DueRow) => {
    setMsg(null);
    try {
      await sendWa(props, 'udhaar_reminder', r.phone, m.udhaar(r), { related_type: 'customer_account', related_id: r.account_id, balance: r.balance });
      setSent((x) => ({ ...x, [r.account_id]: true }));
      setMsg({ text: `Reminder for ${r.name} opened in WhatsApp. Press Send there.` });
    } catch (e) { setMsg({ text: errorText(e), bad: true }); }
  };
  const toggle = async (r: DueRow, on: boolean) => {
    if (!r.customer_id) return;
    try { await props.db.ownerCall('update_customer', r.customer_id, { reminders_opt_in: on }, null); list.reload(); }
    catch (e) { setMsg({ text: errorText(e), bad: true }); }
  };
  const shown = (rows ?? []).filter((r) => !onlyDue || r.due);
  const next = queue[0];
  return (
    <>
      <div className="stats">
        <Stat label="Customers who owe" value={rows?.length ?? '…'} />
        <Stat label="Total udhaar" value={money((rows ?? []).reduce((a, r) => a + Number(r.balance), 0))} tone="warn" />
        <Stat label="Reminders due today" value={dueTotal} sub={`Not reminded in the last ${props.s.interval_days} days`} tone={dueTotal ? 'bad' : undefined} />
        <Stat label="Sent this session" value={Object.keys(sent).length} tone="good" />
      </div>
      <div className="filters wa-actions">
        <button type="button" className="btn wa-btn big" disabled={!next} onClick={() => next && void send(next)}>
          <WaIcon /> {next ? `Send next reminder: ${next.name} (${dueTotal - queue.length + 1} of ${dueTotal})` : dueTotal ? 'All due reminders sent' : 'No reminders due today'}
        </button>
        <label className="check"><input type="checkbox" checked={onlyDue} onChange={(e) => setOnlyDue(e.target.checked)} /> Only those due</label>
      </div>
      {msg && <div className={msg.bad ? 'form-error' : 'message info'}>{msg.text}</div>}
      <Table rows={rows ? shown : null} error={list.error} empty="Nobody owes udhaar. 🎉" cols={[
        { label: 'Customer', value: (r) => <><strong>{r.name}</strong><div className="muted small">{r.account_number} · {r.phone ?? <span className="bad-text">no mobile</span>}</div></> },
        { label: 'Owes', value: (r) => <strong className="warn-text">{money(r.balance)}</strong>, num: true },
        { label: 'For', value: (r) => <><strong>{r.days} days</strong><div className="muted small">since {dateOf(r.oldest_bill)}</div></>, num: true },
        { label: 'Last reminder', value: (r) => (sent[r.account_id] ? <span className="pill good">Sent now</span> : r.last_reminded_at ? timeOf(r.last_reminded_at) : <span className="muted">never</span>) },
        { label: 'Reminders', value: (r) => <label className="check" onClick={(e) => e.stopPropagation()}><input type="checkbox" checked={r.reminders_on} disabled={!r.customer_id} onChange={(e) => void toggle(r, e.target.checked)} /> {r.reminders_on ? 'On' : 'Off'}</label> },
        { label: '', value: (r) => (
          <div className="row-actions">
            <button type="button" className="btn small-btn" title="Formal letter on your letterhead. Choose Save as PDF, then attach it in WhatsApp."
                    onClick={(e) => { e.stopPropagation(); printUdhaarLetter({ pharmacy: props.s.pharmacy, address: props.s.address, phone: props.s.phone, number: props.s.number }, r); }}>Letter (PDF)</button>
            <button type="button" className={`btn small-btn wa-btn${r.due && !sent[r.account_id] ? '' : ' quiet'}`} disabled={!waPhone(r.phone)} title={m.udhaar(r)} onClick={(e) => { e.stopPropagation(); void send(r); }}><WaIcon /> Send</button>
          </div>) },
      ]} />
      <p className="muted small">"Send next" goes through everyone who is due: reminders on, a mobile number, a bill past its due date, and not reminded in the last {props.s.interval_days} days. You can send to anyone with the Send button.</p>
    </>
  );
}

// ---- Refill reminders ----------------------------------------------------------------------
function Refills(props: PageProps & { s: WaSettings }) {
  const [ahead, setAhead] = useState(3);
  const list = useLoad(() => props.db.office<RefillRow[]>('refills_due', props.today, ahead), [ahead]);
  const [sent, setSent] = useState<Record<string, boolean>>({});
  const [msg, setMsg] = useState<{ text: string; bad?: boolean } | null>(null);
  const m = useMemo(() => messages(props.s), [props.s]);
  const send = async (r: RefillRow) => {
    setMsg(null);
    try {
      await sendWa(props, 'refill_reminder', r.phone, m.refill(r), { related_type: 'regular_medicine', related_id: r.id });
      setSent((x) => ({ ...x, [r.id]: true }));
    } catch (e) { setMsg({ text: errorText(e), bad: true }); }
  };
  const when = (d: number) => (d < 0 ? <span className="bad-text">{-d} days late</span> : d === 0 ? <strong>today</strong> : `in ${d} day${d === 1 ? '' : 's'}`);
  return (
    <>
      <div className="filters">
        <span className="muted">Due within</span>
        {[0, 3, 7, 15].map((d) => <button key={d} type="button" className={`chip${ahead === d ? ' on' : ''}`} onClick={() => setAhead(d)}>{d === 0 ? 'today' : `${d} days`}</button>)}
      </div>
      {msg && <div className={msg.bad ? 'form-error' : 'message info'}>{msg.text}</div>}
      <Table rows={list.data} error={list.error} empty="No refills due. Add regular medicines in a customer's khata (Customers & udhaar → open a customer)." cols={[
        { label: 'Customer', value: (r) => <><strong>{r.name}</strong><div className="muted small">{r.phone ?? <span className="bad-text">no mobile</span>}</div></> },
        { label: 'Medicine', value: (r) => <>{r.medicine}<div className="muted small">every {r.interval_days} days</div></> },
        { label: 'Last bought', value: (r) => (r.last_bought ? dateOf(r.last_bought) : <span className="muted">not yet</span>) },
        { label: 'Runs out', value: (r) => <>{dateOf(r.next_due)}<div className="small">{when(r.days_left)}</div></> },
        { label: '', value: (r) => (sent[r.id] || r.reminded_at ? <span className="pill good">Reminded</span>
          : <button type="button" className="btn small-btn wa-btn" disabled={!waPhone(r.phone)} title={m.refill(r)} onClick={() => void send(r)}><WaIcon /> Send</button>) },
      ]} />
      <p className="muted small">The next refill date is worked out from the customer's last purchase of that medicine. It moves forward by itself when they buy again.</p>
    </>
  );
}

// ---- Low stock to suppliers ------------------------------------------------------------------
function Reorder(props: PageProps & { s: WaSettings }) {
  const list = useLoad(() => props.db.office<ReorderRow[]>('reorder_list', props.branchId), []);
  const [sent, setSent] = useState<Record<string, boolean>>({});
  const [msg, setMsg] = useState<{ text: string; bad?: boolean } | null>(null);
  const groups = useMemo(() => {
    const g = new Map<string, { id: string | null; name: string; phone: string | null; items: ReorderRow[] }>();
    for (const r of list.data ?? []) {
      const k = r.supplier_id ?? 'none';
      if (!g.has(k)) g.set(k, { id: r.supplier_id, name: r.supplier ?? 'No supplier yet', phone: r.supplier_whatsapp, items: [] });
      g.get(k)!.items.push(r);
    }
    return [...g.values()];
  }, [list.data]);
  const text = (items: ReorderRow[]) => reorderText(props.s.language ?? 'ur', props.s.pharmacy, props.today,
    items.map((x) => ({ name: x.name, stock: Number(x.stock), unit: x.base_unit })), signature(props.s.pharmacy, props.s.number));
  const send = async (g: (typeof groups)[number]) => {
    setMsg(null);
    try {
      await sendWa(props, 'reorder', g.phone, text(g.items), { related_type: 'supplier', related_id: g.id });
      setSent((x) => ({ ...x, [g.id ?? 'none']: true }));
    } catch (e) { setMsg({ text: errorText(e), bad: true }); }
  };
  if (list.error) return <div className="form-error">{list.error}</div>;
  if (!list.data) return <div className="loading-row"><span className="spinner small" /> Loading…</div>;
  if (!groups.length) return <div className="empty">Nothing is running low. Set a reorder level on a medicine (Products & stock) to watch it.</div>;
  return (
    <>
      {msg && <div className={msg.bad ? 'form-error' : 'message info'}>{msg.text}</div>}
      <p className="muted small">Medicines at or under their reorder level, and medicines sold in the last 60 days that are now out of stock, grouped by the supplier who last delivered them.</p>
      <div className="grid-2">
        {groups.map((g) => (
          <section key={g.id ?? 'none'} className="panel">
            <div className="panel-title">{g.name}</div>
            <div className="muted small">{g.phone ?? (g.id ? 'No WhatsApp number for this supplier' : 'Receive a delivery from a supplier to link these')}</div>
            <ul className="attention">{g.items.map((x) => <li key={x.product_id}><span>{x.name}</span><span className={Number(x.stock) <= 0 ? 'bad-text' : 'warn-text'}>{Number(x.stock)} {x.base_unit ?? ''}{x.reorder_level ? ` / ${x.reorder_level}` : ''}</span></li>)}</ul>
            <div className="row-actions">
              {sent[g.id ?? 'none'] ? <span className="pill good">Sent</span>
                : <button type="button" className="btn wa-btn" disabled={!g.id || !waPhone(g.phone)} onClick={() => void send(g)}><WaIcon /> Send list ({g.items.length})</button>}
              <button type="button" className="btn ghost" onClick={() => { void navigator.clipboard?.writeText(text(g.items)); setMsg({ text: 'List copied.' }); }}>Copy</button>
            </div>
          </section>
        ))}
      </div>
    </>
  );
}

// ---- Daily summary --------------------------------------------------------------------------
interface Dash { periods: { today: { sales: number; bills: number; gross_profit?: number } }; cash_in_open_drawers?: number; udhaar_receivable?: number;
  udhaar_given_today?: number; udhaar_collected_today?: number; expiring_90_days_cost?: number }

export function useSummary(props: PageProps, s: WaSettings | null) {
  const d = useLoad(() => Promise.all([
    props.db.ownerCall<Dash>('owner_dashboard'),
    props.db.office<ReorderRow[]>('reorder_list', props.branchId),
    props.db.office<DueRow[]>('udhaar_reminders', props.today),
    props.db.office<RefillRow[]>('refills_due', props.today, 0),
  ]), []);
  const text = useMemo(() => {
    if (!d.data || !s) return null;
    const [dash, low, due, refills] = d.data;
    return summaryText(s.language ?? 'ur', s.pharmacy, props.today, {
      sales: dash.periods.today.sales, bills: dash.periods.today.bills, profit: dash.periods.today.gross_profit ?? null,
      given: dash.udhaar_given_today, collected: dash.udhaar_collected_today, cash: dash.cash_in_open_drawers, owed: dash.udhaar_receivable,
      low: low.length, expiring: dash.expiring_90_days_cost, remindersDue: due.filter((r) => r.due).length, refillsDue: refills.length,
    });
  }, [d.data, s]);
  return { ...d, text, counts: d.data ? { low: d.data[1].length, due: d.data[2].filter((r) => r.due).length, refills: d.data[3].length } : null };
}

function DailySummary(props: PageProps & { s: WaSettings }) {
  const sum = useSummary(props, props.s);
  const to = props.s.owner_number || props.s.owner_phone;
  const [msg, setMsg] = useState<{ text: string; bad?: boolean } | null>(null);
  const send = async () => {
    if (!sum.text) return;
    setMsg(null);
    try { await sendWa(props, 'daily_summary', to, sum.text); setMsg({ text: 'Summary opened in WhatsApp.' }); }
    catch (e) { setMsg({ text: errorText(e), bad: true }); }
  };
  return (
    <div className="grid-2">
      <section className="panel">
        <div className="panel-title">Today's summary for the owner</div>
        {sum.error && <div className="form-error">{sum.error}</div>}
        {sum.text ? <pre className="wa-preview">{sum.text}</pre> : <div className="loading-row"><span className="spinner small" /></div>}
        {msg && <div className={msg.bad ? 'form-error' : 'message info'}>{msg.text}</div>}
        <div className="row-actions"><button type="button" className="btn wa-btn" disabled={!sum.text || !waPhone(to)} onClick={() => void send()}><WaIcon /> Send to {to || 'owner'}</button></div>
      </section>
      <section className="panel">
        <div className="panel-title">How it works</div>
        <p>Sales, profit, cash, udhaar given and collected, what is still owed, low stock, expiring stock and reminders due — in one message, at closing time.</p>
        <p className="muted small">It goes to the owner number in Setup (or the owner's phone). Send it from the shop PC at night, or open Nuskha on your phone and send it to yourself or a partner.</p>
      </section>
    </div>
  );
}

// ---- History ---------------------------------------------------------------------------------
const KIND: Record<string, string> = { customer_account: 'Udhaar reminder', udhaar_reminder: 'Udhaar reminder', payment_receipt: 'Payment receipt',
  regular_medicine: 'Refill reminder', refill_reminder: 'Refill reminder', supplier: 'Order to supplier', reorder: 'Order to supplier', daily_summary: 'Daily summary' };
function History(props: PageProps) {
  const log = useLoad(() => props.db.office<Array<{ id: string; created_at: string; to_phone: string; kind: string; body: string; who: string | null }>>('whatsapp_log', 200), []);
  return <Table rows={log.data} error={log.error} empty="No WhatsApp messages yet." cols={[
    { label: 'When', value: (r) => timeOf(r.created_at) },
    { label: 'What', value: (r) => KIND[r.kind] ?? r.kind },
    { label: 'To', value: (r) => `+${r.to_phone}` },
    { label: 'Message', value: (r) => <span className="wa-snip" title={r.body}>{r.body.split('\n').slice(0, 2).join(' · ')}</span> },
    { label: 'By', value: (r) => r.who ?? '' },
  ]} />;
}

// ---- Setup -----------------------------------------------------------------------------------
function Setup(props: PageProps & { s: WaSettings; onSaved: () => void }) {
  const s = props.s;
  const [f, setF] = useState({ number: s.number ?? '', owner: s.owner_number ?? '', lang: s.language ?? 'ur', interval: String(s.interval_days ?? 7),
    udhaar: s.template_udhaar ?? '', refill: s.template_refill ?? '' });
  const [mode, setMode] = useState<WaMode>(waMode());
  const [saved, setSaved] = useState('');
  const set = (k: keyof typeof f, v: string) => { setF((x) => ({ ...x, [k]: v })); setSaved(''); };
  const save = useSubmit(async () => {
    if (f.number && !waPhone(f.number)) throw new Error('The pharmacy WhatsApp number should look like 03001234567');
    if (f.owner && !waPhone(f.owner)) throw new Error('The owner number should look like 03001234567');
    const days = Number(f.interval);
    if (!Number.isInteger(days) || days < 1 || days > 90) throw new Error('Remind again after 1 to 90 days');
    const put = (k: string, v: unknown) => props.db.ownerCall('set_setting', k, JSON.stringify(v), null);
    await put('whatsapp.number', f.number.trim());
    await put('whatsapp.owner_number', f.owner.trim());
    await put('whatsapp.language', f.lang);
    await put('udhaar.reminder_interval_days', days);
    await put('whatsapp.template.udhaar', f.udhaar.trim());
    await put('whatsapp.template.refill', f.refill.trim());
    setWaMode(mode);
  }, () => { setSaved('Saved.'); props.onSaved(); });
  const preview = messages({ ...s, number: f.number || null, language: f.lang as WaLang, template_udhaar: f.udhaar || null, template_refill: f.refill || null })
    .udhaar({ name: 'Bilal Khan', balance: 250000, days: 32, oldest_bill: props.today });
  return (
    <div className="grid-2">
      <section className="panel">
        <div className="panel-title">Numbers and language</div>
        <form className="stack" onSubmit={save.submit}>
          <label className="field"><span>Pharmacy WhatsApp number</span><input value={f.number} onChange={(e) => set('number', e.target.value)} placeholder="03001234567" /></label>
          <label className="field"><span>Owner's number (daily summary)</span><input value={f.owner} onChange={(e) => set('owner', e.target.value)} placeholder={s.owner_phone ?? '03001234567'} /></label>
          <div className="form-grid">
            <label className="field"><span>Message language</span><select value={f.lang} onChange={(e) => set('lang', e.target.value)}>
              <option value="ur">اردو (Urdu)</option><option value="roman">Roman Urdu</option><option value="en">English</option></select></label>
            <label className="field"><span>Remind again after (days)</span><input inputMode="numeric" value={f.interval} onChange={(e) => set('interval', e.target.value)} /></label>
          </div>
          <label className="field"><span>Open WhatsApp on this PC with</span><select value={mode} onChange={(e) => { setMode(e.target.value as WaMode); setSaved(''); }}>
            <option value="link">Ask each time (app or WhatsApp Web)</option><option value="web">WhatsApp Web</option><option value="app">WhatsApp app</option></select></label>
          <label className="field"><span>Your own udhaar reminder text (optional)</span>
            <textarea rows={4} value={f.udhaar} onChange={(e) => set('udhaar', e.target.value)} placeholder={DEFAULTS.udhaar[f.lang as WaLang]} /></label>
          <label className="field"><span>Your own refill reminder text (optional)</span>
            <textarea rows={3} value={f.refill} onChange={(e) => set('refill', e.target.value)} placeholder={DEFAULTS.refill[f.lang as WaLang]} /></label>
          <p className="muted small">You can use {'{name}'}, {'{amount}'}, {'{days}'}, {'{since}'}, {'{medicine}'}, {'{pharmacy}'} and {'{sign}'} (pharmacy name and number).</p>
          {save.error && <div className="form-error">{save.error}</div>}
          {saved && <div className="message info">{saved}</div>}
          <div className="row-actions"><button className="btn primary" disabled={save.busy}>Save</button></div>
        </form>
      </section>
      <section className="panel">
        <div className="panel-title">Preview: udhaar reminder</div>
        <pre className="wa-preview" dir={f.lang === 'ur' ? 'rtl' : 'ltr'}>{preview}</pre>
        <p className="muted small">Messages are sent from the WhatsApp that is open on this PC or phone. For fully automatic sending without pressing Send, Nuskha needs a WhatsApp Business API account; ask us when you want it.</p>
      </section>
    </div>
  );
}

// ---- Regular medicines (inside a customer's khata) --------------------------------------------
export function RegularMedicines(props: PageProps & { customerId: string }) {
  const list = useLoad(() => props.db.office<Array<{ id: string; name: string; interval_days: number; last_bought: string | null }>>('regular_medicines', props.customerId), []);
  const [pick, setPick] = useState<{ id: string; brand_name: string } | null>(null);
  const [days, setDays] = useState('30');
  const [err, setErr] = useState<string | null>(null);
  const add = async () => {
    setErr(null);
    try {
      if (!pick) throw new Error('Choose a medicine');
      await props.db.ownerCall('save_regular_medicine', { customer_id: props.customerId, product_id: pick.id, interval_days: Number(days) });
      setPick(null); list.reload();
    } catch (e) { setErr(errorText(e)); }
  };
  const remove = async (id: string) => { try { await props.db.ownerCall('archive_regular_medicine', id); list.reload(); } catch (e) { setErr(errorText(e)); } };
  return (
    <div className="regular-meds">
      <div className="panel-title" style={{ marginTop: 12 }}>Regular medicines (refill reminders)</div>
      <ul className="attention">
        {(list.data ?? []).map((r) => <li key={r.id}><span>{r.name} · every {r.interval_days} days{r.last_bought ? ` · last ${dateOf(r.last_bought)}` : ''}</span>
          <button type="button" className="link-btn" onClick={() => void remove(r.id)}>Remove</button></li>)}
        {list.data && !list.data.length && <li className="muted small">None yet. Add the medicines this customer buys every month.</li>}
      </ul>
      <div className="regular-add">
        <ProductPicker {...props} value={null} onPick={(p) => setPick(p)} />
        <label className="field inline"><span>every</span><input inputMode="numeric" value={days} onChange={(e) => setDays(e.target.value)} style={{ width: 70 }} /><span>days</span></label>
        <button type="button" className="btn" onClick={() => void add()}>Add</button>
      </div>
      {err && <div className="form-error">{err}</div>}
    </div>
  );
}

export function WaIcon() {
  return <svg className="wa-ic" width="16" height="16" viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M12 2a10 10 0 0 0-8.6 15.1L2 22l5-1.3A10 10 0 1 0 12 2zm0 18.2a8.2 8.2 0 0 1-4.2-1.2l-.3-.2-3 .8.8-2.9-.2-.3A8.2 8.2 0 1 1 12 20.2zm4.5-6.1c-.2-.1-1.5-.7-1.7-.8-.2-.1-.4-.1-.6.1l-.8 1c-.1.2-.3.2-.5.1a6.7 6.7 0 0 1-3.3-2.9c-.2-.4.2-.4.7-1.3.1-.2 0-.3 0-.4l-.8-1.8c-.2-.5-.4-.4-.6-.4h-.5a1 1 0 0 0-.7.3 3 3 0 0 0-.9 2.2 5.2 5.2 0 0 0 1.1 2.8 11.9 11.9 0 0 0 4.6 4c1.7.7 2.4.8 3.2.7.5-.1 1.5-.6 1.7-1.2.2-.6.2-1.1.2-1.2-.1-.1-.3-.2-.5-.3z" /></svg>;
}

// ---- Dashboard card --------------------------------------------------------------------------
export function WhatsAppToday(props: PageProps) {
  const settings = useWaSettings(props);
  const sum = useSummary(props, settings.data);
  const [msg, setMsg] = useState<{ text: string; bad?: boolean } | null>(null);
  const to = settings.data ? settings.data.owner_number || settings.data.owner_phone : null;
  const n = sum.counts;
  const send = async () => {
    if (!sum.text) return;
    setMsg(null);
    try { await sendWa(props, 'daily_summary', to, sum.text); setMsg({ text: 'Summary opened in WhatsApp.' }); }
    catch (e) { setMsg({ text: errorText(e), bad: true }); }
  };
  if (sum.error) return null;
  return (
    <section className="panel wa-today">
      <div className="wa-today-head"><div className="panel-title"><WaIcon /> WhatsApp today</div>
        <button type="button" className="link-btn" onClick={() => props.go('whatsapp')}>Open WhatsApp & reminders →</button></div>
      <div className="wa-today-row">
        <button type="button" className="wa-count" onClick={() => props.go('whatsapp')}><strong>{n ? n.due : '…'}</strong><span>udhaar reminders due</span></button>
        <button type="button" className="wa-count" onClick={() => props.go('whatsapp')}><strong>{n ? n.refills : '…'}</strong><span>refills due today</span></button>
        <button type="button" className="wa-count" onClick={() => props.go('whatsapp')}><strong>{n ? n.low : '…'}</strong><span>medicines running low</span></button>
        <button type="button" className="btn wa-btn" disabled={!sum.text || !waPhone(to)} title={waPhone(to) ? '' : 'Add the owner number in WhatsApp & reminders → Setup'} onClick={() => void send()}><WaIcon /> Send today's summary to owner</button>
      </div>
      {msg && <div className={msg.bad ? 'form-error' : 'message info'}>{msg.text}</div>}
    </section>
  );
}
