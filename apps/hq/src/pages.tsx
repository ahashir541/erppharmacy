// The console's screens. Money is shown in rupees, stored in paisa. Every change is a platform_*
// database function and goes into the platform audit log with who did it and why.
import { useState } from 'react';
import { Modal, PageHead, Stat, Table, dateOf, timeOf, useLoad, useSubmit } from '../../pos/src/office/ui.tsx';
import { call, errorText, rs, toMinor, uploadRelease } from './api.ts';

type Go = (page: 'overview' | 'pharmacies' | 'payments' | 'plans' | 'announcements' | 'updates', arg?: string) => void;

interface PharmacyRow {
  id: string; name: string; owner_name: string; owner_phone: string; city: string; status: string; plan: string; plan_name: string;
  trial_ends_at: string | null; grace_ends_at: string | null; read_only_from: string | null; created_at: string;
  price: number | null; cycle: string | null; last_checkin_at: string | null; app_version: string | null; installs: number; unpaid: number; key_hint: string | null;
}
interface Feature { code: string; module: string; name: string; kind?: string }
interface Plan { id: string; code: string; name: string; price_monthly: number; price_yearly: number; trial_days: number; is_public: boolean; sort_order: number;
  features: Record<string, { enabled: boolean; limit: number | null }> }
interface PlansData { plans: Plan[]; features: Feature[]; payment_instructions: string | null }

const STATUS: Record<string, [string, string]> = {
  trial: ['Trial', 'warn'], active: ['Active', 'good'], grace: ['Payment late', 'warn'], read_only: ['Read-only', 'bad'],
  suspended: ['Suspended', 'bad'], cancelled: ['Cancelled', 'bad'],
};
const pill = (s: string) => <span className={`pill ${STATUS[s]?.[1] ?? ''}`}>{STATUS[s]?.[0] ?? s}</span>;
const ago = (t: string | null) => {
  if (!t) return 'never';
  const h = (Date.now() - Date.parse(t)) / 3_600_000;
  return h < 1 ? 'just now' : h < 48 ? `${Math.floor(h)} h ago` : `${Math.floor(h / 24)} days ago`;
};
const isLimit = (f: Feature) => (f.kind ? f.kind === 'limit' : f.code.startsWith('max_'));

// ---- Overview -----------------------------------------------------------------------------------
export function Overview(props: { go: Go }) {
  const dash = useLoad(() => call<Record<string, number | Record<string, number> | null>>('revenue_dashboard'), []);
  const list = useLoad(() => call<PharmacyRow[]>('pharmacies'), []);
  const d = dash.data;
  const by = (d?.tenants ?? {}) as Record<string, number>;
  const quiet = (list.data ?? []).filter((p) => p.status !== 'cancelled' && (!p.last_checkin_at || Date.now() - Date.parse(p.last_checkin_at) > 3 * 86_400_000));
  const late = (list.data ?? []).filter((p) => ['grace', 'read_only'].includes(p.status) || p.unpaid > 0);
  return (
    <>
      <PageHead title="Overview" sub="Your Nuskha business at a glance" />
      {dash.error && <div className="form-error">{dash.error}</div>}
      <div className="stats">
        <Stat label="Monthly income (MRR)" value={rs(d?.mrr)} tone="good" />
        <Stat label="Paying pharmacies" value={by.active ?? 0} sub={`${by.trial ?? 0} on trial`} />
        <Stat label="Payment late / read-only" value={(by.grace ?? 0) + (by.read_only ?? 0)} tone={(by.grace ?? 0) + (by.read_only ?? 0) ? 'warn' : undefined} />
        <Stat label="Overdue" value={rs(d?.overdue)} sub={`${d?.overdue_tenants ?? 0} pharmacies`} tone={Number(d?.overdue) ? 'bad' : undefined} />
        <Stat label="Collected this month" value={rs(d?.collected_this_month)} />
        <Stat label="Payments to check" value={Number(d?.payments_to_review ?? 0)} tone={Number(d?.payments_to_review) ? 'warn' : undefined}
              sub={Number(d?.payments_to_review) ? <button type="button" className="link-btn" onClick={() => props.go('payments')}>Check now</button> : 'none'} />
        <Stat label="New in 30 days" value={Number(d?.new_30_days ?? 0)} sub={`${d?.cancelled_30_days ?? 0} left`} />
      </div>
      <div className="grid-2">
        <section className="panel">
          <div className="panel-title">Not seen for 3+ days</div>
          {quiet.length ? <ul className="attention">{quiet.map((p) => (
            <li key={p.id}><button type="button" className="link-btn" onClick={() => props.go('pharmacies', p.id)}>{p.name}</button><span className="muted small">{ago(p.last_checkin_at)}</span></li>
          ))}</ul> : <p className="muted small">Every pharmacy checked in recently.</p>}
        </section>
        <section className="panel">
          <div className="panel-title">Money to follow up</div>
          {late.length ? <ul className="attention">{late.map((p) => (
            <li key={p.id}><button type="button" className="link-btn" onClick={() => props.go('pharmacies', p.id)}>{p.name}</button><span>{pill(p.status)} {rs(p.unpaid)}</span></li>
          ))}</ul> : <p className="muted small">Nothing unpaid.</p>}
        </section>
      </div>
    </>
  );
}

// ---- Pharmacies ---------------------------------------------------------------------------------
export function Pharmacies(props: { openId: string | null; onOpen: (id: string | null) => void }) {
  const [adding, setAdding] = useState(false);
  const [q, setQ] = useState('');
  const list = useLoad(() => call<PharmacyRow[]>('pharmacies'), []);
  if (props.openId) return <PharmacyDetail id={props.openId} onBack={() => { props.onOpen(null); list.reload(); }} />;
  const rows = (list.data ?? []).filter((p) => !q || `${p.name} ${p.owner_name} ${p.city} ${p.owner_phone}`.toLowerCase().includes(q.toLowerCase()));
  return (
    <>
      <PageHead title="Pharmacies" sub="Every pharmacy using Nuskha: plan, status, and when its PC last checked in">
        <button type="button" className="btn primary" onClick={() => setAdding(true)}>+ Add pharmacy</button>
      </PageHead>
      <div className="filters"><input placeholder="Search name, owner, city, phone" value={q} onChange={(e) => setQ(e.target.value)} /></div>
      <Table rows={list.data ? rows : null} error={list.error} onRow={(r) => props.onOpen(r.id)} empty="No pharmacies yet. Add your first one." cols={[
        { label: 'Pharmacy', value: (r) => <><strong>{r.name}</strong><div className="muted small">{[r.owner_name, r.city, r.owner_phone].filter(Boolean).join(' · ')}</div></> },
        { label: 'Plan', value: (r) => r.plan_name },
        { label: 'Status', value: (r) => <>{pill(r.status)}{r.status === 'trial' && r.trial_ends_at && <div className="muted small">until {dateOf(r.trial_ends_at)}</div>}</> },
        { label: 'Price', value: (r) => (r.price !== null ? `${rs(r.price)} / ${r.cycle === 'yearly' ? 'year' : 'month'}` : '—'), num: true },
        { label: 'Unpaid', value: (r) => (r.unpaid ? <span className="bad-text">{rs(r.unpaid)}</span> : '—'), num: true },
        { label: 'Last check-in', value: (r) => <>{ago(r.last_checkin_at)}{r.app_version && <div className="muted small">v{r.app_version}</div>}</> },
      ]} />
      {adding && <AddPharmacy onClose={() => setAdding(false)} onAdded={() => list.reload()} />}
    </>
  );
}

function KeyBox(props: { pharmacy: string; licenceKey: string; phone?: string }) {
  const [copied, setCopied] = useState(false);
  const text = `Assalam o Alaikum! Your Nuskha licence key for ${props.pharmacy} is:\n${props.licenceKey}\nEnter it when Nuskha asks for it (Settings → Licence).`;
  const wa = props.phone ? `https://wa.me/${props.phone.replace(/\D/g, '').replace(/^0/, '92')}?text=${encodeURIComponent(text)}` : null;
  return (
    <div className="key-box">
      <div className="muted small">Licence key for {props.pharmacy}. It is shown only now: copy it or send it.</div>
      <div className="key-text">{props.licenceKey}</div>
      <div className="row-actions">
        <button type="button" className="btn" onClick={async () => { await navigator.clipboard.writeText(props.licenceKey); setCopied(true); }}>{copied ? 'Copied ✓' : 'Copy key'}</button>
        {wa && <a className="btn primary" href={wa} target="_blank" rel="noreferrer">Send on WhatsApp</a>}
      </div>
    </div>
  );
}

function AddPharmacy(props: { onClose: () => void; onAdded: () => void }) {
  const plans = useLoad(() => call<PlansData>('plans'), []);
  const [f, setF] = useState({ name: '', owner_name: '', owner_phone: '', city: '', plan: 'basic', trial_days: '' });
  const [made, setMade] = useState<{ licence_key: string } | null>(null);
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => setF({ ...f, [k]: e.target.value });
  const plan = plans.data?.plans.find((p) => p.code === f.plan);
  const { busy, error, submit } = useSubmit(async () => {
    const r = await call<{ tenant_id: string; licence_key: string }>('create_pharmacy', {
      name: f.name, owner_name: f.owner_name, owner_phone: f.owner_phone, city: f.city, plan: f.plan,
      ...(f.trial_days !== '' ? { trial_days: Number(f.trial_days) } : {}) });
    setMade(r);
    props.onAdded();
  }, () => {});
  return (
    <Modal title="Add a pharmacy" onClose={props.onClose}>
      {made ? (
        <div className="stack">
          <KeyBox pharmacy={f.name} licenceKey={made.licence_key} phone={f.owner_phone} />
          <p className="muted small">Next: the pharmacy installs Nuskha and enters this key. It starts on a {f.trial_days || plan?.trial_days || 0}-day trial.
            To bill them, open the pharmacy and choose "Start billing".</p>
          <div className="row-actions"><button type="button" className="btn primary" onClick={props.onClose}>Done</button></div>
        </div>
      ) : (
        <form className="stack" onSubmit={submit}>
          <label className="field"><span>Pharmacy name *</span><input autoFocus required value={f.name} onChange={set('name')} /></label>
          <div className="form-grid">
            <label className="field"><span>Owner</span><input value={f.owner_name} onChange={set('owner_name')} /></label>
            <label className="field"><span>Owner's mobile (WhatsApp)</span><input value={f.owner_phone} onChange={set('owner_phone')} inputMode="tel" placeholder="03xx xxxxxxx" /></label>
          </div>
          <div className="form-grid">
            <label className="field"><span>City</span><input value={f.city} onChange={set('city')} /></label>
            <label className="field"><span>Plan</span>
              <select value={f.plan} onChange={set('plan')}>
                {(plans.data?.plans ?? []).map((p) => <option key={p.code} value={p.code}>{p.name} · {rs(p.price_monthly)}/month</option>)}
              </select>
            </label>
          </div>
          <label className="field"><span>Free trial days (blank = the plan's {plan?.trial_days ?? 14}; 0 = no trial)</span><input inputMode="numeric" value={f.trial_days} onChange={set('trial_days')} /></label>
          {error && <div className="form-error">{error}</div>}
          <div className="row-actions"><button type="button" className="btn ghost" onClick={props.onClose}>Cancel</button><button className="btn primary" disabled={busy}>{busy ? '…' : 'Add and get the licence key'}</button></div>
        </form>
      )}
    </Modal>
  );
}

interface Detail {
  pharmacy: Record<string, unknown> & { id: string; name: string; status: string; owner_phone: string; trial_ends_at: string | null; read_only_from: string | null; offline_licence_days: number };
  plan: string; key_hint: string | null;
  subscription: { plan_id: string; billing_cycle: string; price: number; status: string; current_period_end: string } | null;
  invoices: Array<{ id: string; invoice_number: string; amount: number; period_start: string; period_end: string; due_at: string; status: string }>;
  payments: Array<{ id: string; method: string; amount: number; reference: string; submitted_at: string; status: string }>;
  installs: Array<{ id: string; machine: string | null; app_version: string | null; first_seen_at: string; last_checkin_at: string; checkins: number; stats: Record<string, unknown>; blocked_at: string | null; backup_key?: string | null }>;
  features: Array<{ code: string; name: string; module: string; enabled: boolean; limit: number | null; override: { enabled: boolean; limit: number | null; reason: string } | null }>;
  log: Array<{ action: string; details: Record<string, unknown>; occurred_at: string }>;
}

function PharmacyDetail(props: { id: string; onBack: () => void }) {
  const d = useLoad(() => call<Detail>('pharmacy', props.id), [props.id]);
  const [modal, setModal] = useState<null | 'status' | 'billing' | 'key' | 'delete'>(null);
  const [newKey, setNewKey] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const x = d.data;
  if (!x) return d.error ? <div className="form-error">{d.error}</div> : <div className="loading-row"><span className="spinner small" /></div>;
  const p = x.pharmacy;
  const act = async (fn: () => Promise<unknown>) => { setErr(null); try { await fn(); d.reload(); } catch (e) { setErr(errorText(e)); } };
  return (
    <>
      <PageHead title={p.name} sub={`${[p.owner_name, p.city, p.owner_phone].filter(Boolean).join(' · ')}`}>
        <button type="button" className="btn ghost" onClick={props.onBack}>← All pharmacies</button>
        <button type="button" className="btn" onClick={() => setModal('status')}>Change status</button>
        <button type="button" className="btn danger-outline" onClick={() => setModal('delete')}>Delete</button>
        <button type="button" className="btn primary" onClick={() => setModal('billing')}>{x.subscription ? 'Change plan / price' : 'Start billing'}</button>
      </PageHead>
      {err && <div className="form-error">{err}</div>}
      <div className="stats">
        <Stat label="Status" value={pill(p.status)} sub={p.status === 'trial' ? `trial until ${dateOf(p.trial_ends_at)}` : p.read_only_from ? `read-only from ${timeOf(p.read_only_from)}` : undefined} />
        <Stat label="Plan" value={x.plan} sub={x.subscription ? `${rs(x.subscription.price)} / ${x.subscription.billing_cycle === 'yearly' ? 'year' : 'month'}` : 'not billed yet'} />
        <Stat label="Licence key" value={x.key_hint ? `…${x.key_hint}` : 'none'} sub={<button type="button" className="link-btn" onClick={() => setModal('key')}>New key</button>} />
        <Stat label="Works offline for" value={`${p.offline_licence_days} days`} />
        <Stat label="Gets updates" value={
          <select value={String(p.release_channel ?? 'stable')} onChange={(e) => void act(() => call('set_release_channel', p.id, e.target.value))} aria-label="Update channel">
            <option value="stable">With everyone (stable)</option><option value="beta">First (beta)</option><option value="internal">Test pharmacy (internal)</option>
          </select>} />
      </div>
      <div className="grid-2">
        <section className="panel">
          <div className="panel-title">Invoices</div>
          <Table rows={x.invoices} empty="No invoices. Start billing to send the first one." cols={[
            { label: 'Invoice', value: (i) => <><strong>{i.invoice_number}</strong><div className="muted small">{dateOf(i.period_start)} – {dateOf(i.period_end)}</div></> },
            { label: 'Due', value: (i) => dateOf(i.due_at) },
            { label: 'Amount', value: (i) => rs(i.amount), num: true },
            { label: 'Status', value: (i) => <span className={`pill ${i.status === 'paid' ? 'good' : i.status === 'overdue' ? 'bad' : 'warn'}`}>{i.status}</span> },
          ]} />
        </section>
        <section className="panel">
          <div className="panel-title">Payments</div>
          <Table rows={x.payments} empty="No payments yet." cols={[
            { label: 'When', value: (m) => timeOf(m.submitted_at) },
            { label: 'How', value: (m) => <>{m.method}<div className="muted small">{m.reference}</div></> },
            { label: 'Amount', value: (m) => rs(m.amount), num: true },
            { label: 'Status', value: (m) => (m.status === 'pending' ? (
              <div className="row-actions">
                <button type="button" className="btn small-btn primary" onClick={() => void act(() => call('review_payment', m.id, true, null))}>Money received</button>
                <button type="button" className="btn small-btn" onClick={() => void act(() => call('review_payment', m.id, false, 'Payment not found'))}>Not found</button>
              </div>) : <span className={`pill ${m.status === 'verified' ? 'good' : 'bad'}`}>{m.status}</span>) },
          ]} />
        </section>
        <section className="panel">
          <div className="panel-title">PCs running Nuskha</div>
          <Table rows={x.installs} empty="Not installed yet (no check-in with this key)." cols={[
            { label: 'PC', value: (i) => <><strong>{i.machine ?? 'PC'}</strong><div className="muted small">v{i.app_version ?? '?'} · since {dateOf(i.first_seen_at)}</div></> },
            { label: 'Last check-in', value: (i) => ago(i.last_checkin_at) },
            { label: 'Backup key', value: (i) => (i.backup_key ? <code className="key-code" title="Give this to the owner only, to open a backup on a new PC">{i.backup_key}</code> : <span className="muted small">not sent yet</span>) },
            { label: 'Use', value: (i) => <span className="muted small">{Object.entries(i.stats ?? {}).map(([k, v]) => `${k.replace(/_/g, ' ')} ${String(v)}`).join(' · ')}</span> },
            { label: '', value: (i) => <button type="button" className={`btn small-btn${i.blocked_at ? '' : ' danger'}`}
                onClick={() => void act(() => call('block_install', i.id, !i.blocked_at, i.blocked_at ? null : 'Blocked from HQ'))}>{i.blocked_at ? 'Unblock' : 'Block'}</button> },
          ]} />
        </section>
        <section className="panel">
          <div className="panel-title">Features and limits for this pharmacy</div>
          <ul className="attention">
            {x.features.filter((f) => f.code !== 'tax_integration').map((f) => (
              <li key={f.code}>
                <label className="check">
                  <input type="checkbox" checked={f.enabled} onChange={(e) => void act(() => call('set_tenant_feature', p.id, f.code, e.target.checked, f.limit, 'Changed in HQ', null))} />
                  {f.name}{f.override && <span className="pill warn">custom</span>}
                </label>
                {f.code.startsWith('max_') && (
                  <input className="threshold" inputMode="numeric" placeholder="no limit" defaultValue={f.limit ?? ''} aria-label={`${f.name} limit`}
                         onBlur={(e) => { const v = e.target.value.trim() === '' ? null : Number(e.target.value); if (v !== f.limit) void act(() => call('set_tenant_feature', p.id, f.code, true, v, 'Limit changed in HQ', null)); }} />
                )}
              </li>
            ))}
          </ul>
        </section>
      </div>
      <section className="panel">
        <div className="panel-title">History</div>
        <Table rows={x.log} empty="Nothing yet." cols={[
          { label: 'When', value: (l) => timeOf(l.occurred_at) },
          { label: 'What', value: (l) => l.action.replace(/_/g, ' ') },
          { label: 'Details', value: (l) => <span className="muted small">{Object.entries(l.details ?? {}).filter(([k]) => k !== 'name').map(([k, v]) => `${k}: ${typeof v === 'object' ? JSON.stringify(v) : String(v)}`).join(' · ')}</span> },
        ]} />
      </section>
      {modal === 'delete' && <DeleteModal id={p.id} name={p.name} status={p.status} onClose={() => setModal(null)}
        onCancelFirst={() => setModal('status')} onDone={props.onBack} />}
      {modal === 'status' && <StatusModal id={p.id} current={p.status} onClose={() => setModal(null)} onDone={() => { setModal(null); d.reload(); }} />}
      {modal === 'billing' && <BillingModal id={p.id} plan={x.plan} onClose={() => setModal(null)} onDone={() => { setModal(null); d.reload(); }} />}
      {modal === 'key' && (
        <Modal title="New licence key" onClose={() => { setModal(null); setNewKey(null); }}>
          {newKey ? <KeyBox pharmacy={p.name} licenceKey={newKey} phone={p.owner_phone} /> : (
            <div className="stack">
              <p>The old key stops working at the pharmacy's next check-in. They must enter the new key. Use this when a key was shared with someone else.</p>
              <div className="row-actions"><button type="button" className="btn ghost" onClick={() => setModal(null)}>Cancel</button>
                <button type="button" className="btn danger" onClick={() => void act(async () => setNewKey(await call<string>('reissue_licence_key', p.id)))}>Make a new key</button></div>
            </div>
          )}
        </Modal>
      )}
    </>
  );
}

function DeleteModal(props: { id: string; name: string; status: string; onClose: () => void; onCancelFirst: () => void; onDone: () => void }) {
  const [typed, setTyped] = useState('');
  const { busy, error, submit } = useSubmit(() => call('delete_pharmacy', props.id, typed), props.onDone);
  if (props.status !== 'cancelled') {
    return (
      <Modal title={`Delete ${props.name}?`} onClose={props.onClose}>
        <div className="stack">
          <p>To delete a pharmacy, first set its status to <strong>Cancelled</strong>. That stops Nuskha at their shop; deleting then removes it from HQ for good.</p>
          <div className="row-actions"><button type="button" className="btn ghost" onClick={props.onClose}>Close</button>
            <button type="button" className="btn primary" onClick={props.onCancelFirst}>Change status</button></div>
        </div>
      </Modal>
    );
  }
  const match = typed.trim().toLowerCase() === props.name.trim().toLowerCase();
  return (
    <Modal title={`Delete ${props.name}?`} onClose={props.onClose}>
      <form className="stack" onSubmit={submit}>
        <div className="licence-result bad">
          <strong>This cannot be undone.</strong>
          <span>The pharmacy, its licence key, invoices, payments and history are removed from Nuskha HQ. Their Nuskha at the shop stops working with this key. Their own records on their PC are not touched.</span>
        </div>
        <label className="field"><span>Type <strong>{props.name}</strong> to confirm</span>
          <input autoFocus value={typed} onChange={(e) => setTyped(e.target.value)} autoComplete="off" /></label>
        {error && <div className="form-error">{error}</div>}
        <div className="row-actions"><button type="button" className="btn ghost" onClick={props.onClose}>Keep it</button>
          <button className="btn danger" disabled={busy || !match}>{busy ? 'Deleting…' : 'Delete for good'}</button></div>
      </form>
    </Modal>
  );
}

function StatusModal(props: { id: string; current: string; onClose: () => void; onDone: () => void }) {
  const [status, setStatus] = useState(props.current === 'active' ? 'read_only' : 'active');
  const [reason, setReason] = useState('');
  const { busy, error, submit } = useSubmit(() => call('set_tenant_status', props.id, status, reason), props.onDone);
  return (
    <Modal title="Change status" onClose={props.onClose}>
      <form className="stack" onSubmit={submit}>
        <label className="field"><span>New status</span>
          <select value={status} onChange={(e) => setStatus(e.target.value)}>
            {Object.entries(STATUS).map(([k, [l]]) => <option key={k} value={k}>{l}</option>)}
          </select>
        </label>
        <p className="muted small">{status === 'read_only' ? 'Read-only starts at the pharmacy\'s closing time tonight, never in the middle of the day. They can still see and export everything.'
          : status === 'active' ? 'Selling works normally again at their next check-in (within a few hours, or when they press "Check now").'
          : status === 'cancelled' ? 'They keep their data on their own PC; Nuskha stops selling.' : ''}</p>
        <label className="field"><span>Reason (kept in the history) *</span><input required value={reason} onChange={(e) => setReason(e.target.value)} /></label>
        {error && <div className="form-error">{error}</div>}
        <div className="row-actions"><button type="button" className="btn ghost" onClick={props.onClose}>Cancel</button><button className="btn primary" disabled={busy}>Save</button></div>
      </form>
    </Modal>
  );
}

function BillingModal(props: { id: string; plan: string; onClose: () => void; onDone: () => void }) {
  const plans = useLoad(() => call<PlansData>('plans'), []);
  const [plan, setPlan] = useState(props.plan);
  const [cycle, setCycle] = useState<'monthly' | 'yearly'>('monthly');
  const [price, setPrice] = useState('');
  const pl = plans.data?.plans.find((p) => p.code === plan);
  const list = pl ? (cycle === 'yearly' ? pl.price_yearly : pl.price_monthly) : 0;
  const { busy, error, submit } = useSubmit(() => call('start_subscription', props.id, plan, cycle, price.trim() ? toMinor(price) : null), props.onDone);
  return (
    <Modal title="Plan and billing" onClose={props.onClose}>
      <form className="stack" onSubmit={submit}>
        <div className="form-grid">
          <label className="field"><span>Plan</span><select value={plan} onChange={(e) => setPlan(e.target.value)}>
            {(plans.data?.plans ?? []).map((p) => <option key={p.code} value={p.code}>{p.name}</option>)}</select></label>
          <label className="field"><span>Billing</span><select value={cycle} onChange={(e) => setCycle(e.target.value as 'monthly' | 'yearly')}>
            <option value="monthly">Every month</option><option value="yearly">Every year</option></select></label>
        </div>
        <label className="field"><span>Price for this pharmacy (Rs) — blank = list price {rs(list)}</span><input inputMode="decimal" value={price} onChange={(e) => setPrice(e.target.value)} /></label>
        <p className="muted small">The first invoice is made now, due in 7 days. Each {cycle === 'yearly' ? 'year' : 'month'} a new one follows. Unpaid after the due date: 7 days' grace, then read-only at closing time.</p>
        {error && <div className="form-error">{error}</div>}
        <div className="row-actions"><button type="button" className="btn ghost" onClick={props.onClose}>Cancel</button><button className="btn primary" disabled={busy}>Start billing</button></div>
      </form>
    </Modal>
  );
}

// ---- Payments -----------------------------------------------------------------------------------
export function Payments(props: { go: Go }) {
  const list = useLoad(() => call<Array<{ id: string; pharmacy: string; tenant_id: string; invoice_number: string; invoice_amount: number; method: string;
    amount: number; reference: string; submitted_at: string; status: string }>>('payments_to_review'), []);
  const plans = useLoad(() => call<PlansData>('plans'), []);
  const [text, setText] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const review = async (id: string, ok: boolean) => {
    setErr(null);
    try { await call('review_payment', id, ok, ok ? null : 'We could not find this payment. Please check the reference.'); list.reload(); } catch (e) { setErr(errorText(e)); }
  };
  return (
    <>
      <PageHead title="Payments" sub="Pharmacies send a transaction reference from Nuskha; check your bank or JazzCash, then confirm" />
      {err && <div className="form-error">{err}</div>}
      <Table rows={list.data} error={list.error} empty="No payments to check." cols={[
        { label: 'Pharmacy', value: (r) => <button type="button" className="link-btn" onClick={() => props.go('pharmacies', r.tenant_id)}>{r.pharmacy}</button> },
        { label: 'Invoice', value: (r) => <>{r.invoice_number}<div className="muted small">{rs(r.invoice_amount)}</div></> },
        { label: 'Paid by', value: (r) => <>{r.method}<div className="muted small">ref {r.reference}</div></> },
        { label: 'Amount', value: (r) => rs(r.amount), num: true },
        { label: 'Sent', value: (r) => timeOf(r.submitted_at) },
        { label: '', value: (r) => (r.status === 'pending' ? (
          <div className="row-actions">
            <button type="button" className="btn small-btn primary" onClick={() => void review(r.id, true)}>Money received</button>
            <button type="button" className="btn small-btn" onClick={() => void review(r.id, false)}>Not found</button>
          </div>) : <span className={`pill ${r.status === 'verified' ? 'good' : 'bad'}`}>{r.status}</span>) },
      ]} />
      <section className="panel">
        <div className="panel-title">How pharmacies pay you (shown in their Nuskha)</div>
        <textarea rows={4} placeholder="e.g. Meezan Bank, Account title: …, IBAN: …  /  JazzCash: 03xx-xxxxxxx (name)"
                  value={text ?? plans.data?.payment_instructions ?? ''} onChange={(e) => setText(e.target.value)} />
        <div className="row-actions"><button type="button" className="btn primary" disabled={text === null}
          onClick={async () => { setErr(null); try { await call('set_payment_instructions', text); setText(null); plans.reload(); } catch (e) { setErr(errorText(e)); } }}>Save</button></div>
      </section>
    </>
  );
}

// ---- Plans --------------------------------------------------------------------------------------
export function Plans() {
  const data = useLoad(() => call<PlansData>('plans'), []);
  const [edit, setEdit] = useState<Plan | null>(null);
  return (
    <>
      <PageHead title="Plans & prices" sub="What each plan costs and includes. Changes reach every pharmacy on the plan at its next check-in." />
      <Table rows={data.data?.plans ?? null} error={data.error} onRow={setEdit} cols={[
        { label: 'Plan', value: (p) => <strong>{p.name}</strong> },
        { label: 'Monthly', value: (p) => rs(p.price_monthly), num: true },
        { label: 'Yearly', value: (p) => rs(p.price_yearly), num: true },
        { label: 'Trial', value: (p) => `${p.trial_days} days` },
        { label: 'Branches / counters / staff', value: (p) => ['max_branches', 'max_counters', 'max_staff'].map((k) => p.features[k]?.limit ?? '∞').join(' / ') },
        { label: 'Includes', value: (p) => <span className="muted small">{(data.data?.features ?? []).filter((f) => !isLimit(f) && f.code !== 'tax_integration' && p.features[f.code]?.enabled).map((f) => f.name).join(', ')}</span> },
      ]} />
      {edit && data.data && <PlanEditor plan={edit} features={data.data.features} onClose={() => setEdit(null)} onSaved={() => { setEdit(null); data.reload(); }} />}
    </>
  );
}

function PlanEditor(props: { plan: Plan; features: Feature[]; onClose: () => void; onSaved: () => void }) {
  const [f, setF] = useState({ name: props.plan.name, monthly: String(props.plan.price_monthly / 100), yearly: String(props.plan.price_yearly / 100), trial: String(props.plan.trial_days) });
  const [feat, setFeat] = useState<Record<string, { enabled: boolean; limit: number | null }>>(() => {
    const o: Record<string, { enabled: boolean; limit: number | null }> = {};
    for (const x of props.features) o[x.code] = props.plan.features[x.code] ?? { enabled: false, limit: null };
    return o;
  });
  const { busy, error, submit } = useSubmit(() => call('save_plan', {
    code: props.plan.code, name: f.name, price_monthly: toMinor(f.monthly) ?? 0, price_yearly: toMinor(f.yearly) ?? 0, trial_days: Number(f.trial) || 0,
    is_public: props.plan.is_public, sort_order: props.plan.sort_order, features: feat }), props.onSaved);
  return (
    <Modal title={`Plan: ${props.plan.name}`} onClose={props.onClose} wide>
      <form className="stack" onSubmit={submit}>
        <div className="form-grid">
          <label className="field"><span>Name</span><input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></label>
          <label className="field"><span>Free trial days</span><input inputMode="numeric" value={f.trial} onChange={(e) => setF({ ...f, trial: e.target.value })} /></label>
          <label className="field"><span>Price per month (Rs)</span><input inputMode="decimal" value={f.monthly} onChange={(e) => setF({ ...f, monthly: e.target.value })} /></label>
          <label className="field"><span>Price per year (Rs)</span><input inputMode="decimal" value={f.yearly} onChange={(e) => setF({ ...f, yearly: e.target.value })} /></label>
        </div>
        <div className="panel-title">Included</div>
        <ul className="attention">
          {props.features.filter((x) => x.code !== 'tax_integration').map((x) => (
            <li key={x.code}>
              <label className="check"><input type="checkbox" checked={feat[x.code]?.enabled ?? false}
                onChange={(e) => setFeat({ ...feat, [x.code]: { enabled: e.target.checked, limit: feat[x.code]?.limit ?? null } })} /> {x.name}</label>
              {isLimit(x) && <input className="threshold" inputMode="numeric" placeholder="no limit" value={feat[x.code]?.limit ?? ''} aria-label={`${x.name} limit`}
                onChange={(e) => setFeat({ ...feat, [x.code]: { enabled: true, limit: e.target.value.trim() === '' ? null : Number(e.target.value) } })} />}
            </li>
          ))}
        </ul>
        <p className="muted small">A price change applies to new billing; pharmacies already billed keep their agreed price until you change it on the pharmacy.</p>
        {error && <div className="form-error">{error}</div>}
        <div className="row-actions"><button type="button" className="btn ghost" onClick={props.onClose}>Cancel</button><button className="btn primary" disabled={busy}>Save plan</button></div>
      </form>
    </Modal>
  );
}

// ---- Announcements ------------------------------------------------------------------------------
export function Announcements() {
  const plans = useLoad(() => call<PlansData>('plans'), []);
  const list = useLoad(() => call<PharmacyRow[]>('pharmacies'), []);
  const [f, setF] = useState({ title: '', body: '', title_ur: '', body_ur: '', severity: 'info', audience: 'all', plan_code: '', tenant_id: '', days: '7' });
  const [sent, setSent] = useState(false);
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) => setF({ ...f, [k]: e.target.value });
  const { busy, error, submit } = useSubmit(() => call('announce', {
    title: f.title, body: f.body, title_ur: f.title_ur || null, body_ur: f.body_ur || null, severity: f.severity, audience: f.audience,
    ...(f.audience === 'plan' ? { plan_code: f.plan_code } : {}), ...(f.audience === 'tenant' ? { tenant_id: f.tenant_id } : {}),
    ends_at: f.days ? new Date(Date.now() + Number(f.days) * 86_400_000).toISOString() : null }), () => { setSent(true); setF({ ...f, title: '', body: '', title_ur: '', body_ur: '' }); });
  return (
    <>
      <PageHead title="Announcements" sub="A message on the screen of every pharmacy, one plan, or one pharmacy (shown after their next check-in)" />
      <form className="panel stack" onSubmit={submit}>
        <div className="form-grid">
          <label className="field"><span>Title *</span><input required value={f.title} onChange={set('title')} placeholder="New: stock count screen" /></label>
          <label className="field"><span>Title in Urdu</span><input dir="rtl" value={f.title_ur} onChange={set('title_ur')} /></label>
        </div>
        <label className="field"><span>Message *</span><textarea required rows={3} value={f.body} onChange={set('body')} /></label>
        <label className="field"><span>Message in Urdu</span><textarea dir="rtl" rows={2} value={f.body_ur} onChange={set('body_ur')} /></label>
        <div className="form-grid">
          <label className="field"><span>Who sees it</span><select value={f.audience} onChange={set('audience')}>
            <option value="all">Every pharmacy</option><option value="plan">One plan</option><option value="tenant">One pharmacy</option></select></label>
          {f.audience === 'plan' && <label className="field"><span>Plan</span><select required value={f.plan_code} onChange={set('plan_code')}>
            <option value="">Choose…</option>{(plans.data?.plans ?? []).map((p) => <option key={p.code} value={p.code}>{p.name}</option>)}</select></label>}
          {f.audience === 'tenant' && <label className="field"><span>Pharmacy</span><select required value={f.tenant_id} onChange={set('tenant_id')}>
            <option value="">Choose…</option>{(list.data ?? []).map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select></label>}
          <label className="field"><span>Kind</span><select value={f.severity} onChange={set('severity')}>
            <option value="info">News</option><option value="warning">Important</option><option value="critical">Urgent</option></select></label>
          <label className="field"><span>Show for (days)</span><input inputMode="numeric" value={f.days} onChange={set('days')} /></label>
        </div>
        {sent && <div className="message info">Sent. Pharmacies see it after their next check-in.</div>}
        {error && <div className="form-error">{error}</div>}
        <div className="row-actions"><button className="btn primary" disabled={busy}>Send</button></div>
      </form>
    </>
  );
}

// ---- Updates ------------------------------------------------------------------------------------
interface ReleasesData {
  releases: Array<{ id: string; version: string; channel: string; notes: string; size_bytes: number | null; published_at: string; rolled_back_at: string | null; pcs: number }>;
  versions: Record<string, number>; min_version: string | null;
}

export function Updates() {
  const data = useLoad(() => call<ReleasesData>('releases', 'local'), []);
  const [file, setFile] = useState<File | null>(null);
  const [version, setVersion] = useState('');
  const [channel, setChannel] = useState('beta');
  const [notes, setNotes] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const pick = (f: File | undefined) => {
    setFile(f ?? null);
    const m = f?.name.match(/medflow-local-([0-9]+\.[0-9]+\.[0-9]+(?:-[a-z0-9.]+)?)\.tar\.gz$/);
    if (m) setVersion(m[1]!);
  };
  const upload = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!file) return;
    setBusy(true); setErr(null); setMsg(null);
    try {
      const r = await uploadRelease(file, version, channel, notes);
      setMsg(`Version ${r.version} is published on the ${channel} channel. Pharmacies on it install it tonight (1–5 am) after their backup.`);
      setFile(null); setNotes(''); data.reload();
    } catch (x) { setErr(errorText(x)); } finally { setBusy(false); }
  };
  const pull = async (id: string, v: string) => {
    if (!window.confirm(`Pull version ${v}? PCs that have not installed it stay where they are; PCs that have it go back to the last good version tonight.`)) return;
    setErr(null);
    try { await call('rollback_release', id, 'Pulled in HQ'); data.reload(); } catch (x) { setErr(errorText(x)); }
  };
  const versions = Object.entries(data.data?.versions ?? {}).sort((a, b) => b[1] - a[1]);
  return (
    <>
      <PageHead title="Updates" sub="New Nuskha versions reach pharmacies by themselves at night, after their backup" />
      <div className="stats">
        {versions.length ? versions.map(([v, n]) => <Stat key={v} label={`PCs on ${v}`} value={n} />) : <Stat label="PCs checking in" value={0} />}
      </div>
      <form className="panel stack" onSubmit={(e) => void upload(e)}>
        <div className="panel-title">Publish a new version</div>
        <p className="muted small">Make the package with <code>node apps/server/build.mjs --update</code> (raise the version in apps/server/package.json first), then upload
          the <code>medflow-local-x.y.z.tar.gz</code> file. Publish on <strong>beta</strong> first (pharmacies you set to beta), then publish the same file on <strong>stable</strong> for everyone.</p>
        <div className="form-grid">
          <label className="field"><span>Package file</span><input type="file" accept=".gz" onChange={(e) => pick(e.target.files?.[0])} /></label>
          <label className="field"><span>Version</span><input required value={version} onChange={(e) => setVersion(e.target.value.trim())} placeholder="0.2.0" /></label>
          <label className="field"><span>Who gets it</span><select value={channel} onChange={(e) => setChannel(e.target.value)}>
            <option value="internal">Internal (only test pharmacies)</option><option value="beta">Beta (pharmacies set to beta)</option><option value="stable">Stable (everyone)</option>
          </select></label>
        </div>
        <label className="field"><span>What is new (pharmacies see this)</span><textarea rows={3} value={notes} onChange={(e) => setNotes(e.target.value)} /></label>
        {msg && <div className="message info">{msg}</div>}
        {err && <div className="form-error">{err}</div>}
        <div className="row-actions"><button className="btn primary" disabled={busy || !file || !version}>{busy ? 'Uploading…' : 'Publish'}</button></div>
      </form>
      <Table rows={data.data?.releases ?? null} error={data.error} empty="No versions published yet." cols={[
        { label: 'Version', value: (r) => <><strong>{r.version}</strong><div className="muted small">{r.notes}</div></> },
        { label: 'Channel', value: (r) => r.channel },
        { label: 'Published', value: (r) => timeOf(r.published_at) },
        { label: 'Size', value: (r) => (r.size_bytes ? `${(r.size_bytes / 1048576).toFixed(1)} MB` : '—'), num: true },
        { label: 'PCs on it', value: (r) => r.pcs, num: true },
        { label: '', value: (r) => (r.rolled_back_at ? <span className="pill bad">Pulled</span>
          : <button type="button" className="btn small-btn danger" onClick={() => void pull(r.id, r.version)}>Pull</button>) },
      ]} />
    </>
  );
}
