import { checkPin, hashPin } from '@medflow/core';
import { useState } from 'react';
import { toPaisa } from '../util.ts';
import { isServer, LicencePanel, LocalServerPanel, OwnerViewPanel } from './localserver.tsx';
import { RolePermissions } from './roles.tsx';
import { Modal, money, PageHead, Stat, Table, timeOf, useLoad, useSubmit, type PageProps } from './ui.tsx';

// ---- Approvals & alerts ----------------------------------------------------------------------
interface Approval { id: string; kind: string; permission_code: string; amount: number | null; details: { summary?: string }; created_at: string; who: string; expires_at: string | null }
interface Note { id: string; kind: string; title: string; body: string; created_at: string; read_at: string | null }

export function Approvals(props: PageProps) {
  const approvals = useLoad(() => props.db.office<Approval[]>('approvals'), []);
  const notes = useLoad(() => props.db.office<Note[]>('notifications'), []);
  const decide = async (id: string, ok: boolean) => {
    await props.db.ownerCall('decide_approval', id, ok, null);
    approvals.reload();
    notes.reload();
  };
  const unread = (notes.data ?? []).filter((n) => !n.read_at).length;
  const ICON: Record<string, string> = { approval: '✓', large_discount: '%', void: '⊘', cash_short: '₨', controlled_sale: '℞', sync_flag: '⚠', udhaar_over_limit: '⚠',
    recall: '⛔', expiring_batches: '⏳', low_stock: '▾', licence_expiry: '📄', device_offline: '⚡', billing: '₨', account: 'ⓘ' };
  return (
    <>
      <PageHead title="Approvals & alerts" sub="Requests from the counter, and everything Nuskha wants you to know">
        <button type="button" className="btn" disabled={!unread} onClick={async () => { await props.db.ownerCall('mark_notifications_read', null); notes.reload(); }}>Mark all read</button>
      </PageHead>
      <div className="stats">
        <Stat label="Waiting for your approval" value={approvals.data?.length ?? '…'} tone={approvals.data?.length ? 'warn' : undefined} />
        <Stat label="Unread alerts" value={unread} />
      </div>
      <div className="panel-title">Waiting for approval</div>
      <Table rows={approvals.data} error={approvals.error} empty="Nothing waiting. Requests from the counter appear here at once." cols={[
        { label: 'Asked', value: (r) => timeOf(r.created_at) },
        { label: 'By', value: (r) => r.who },
        { label: 'For', value: (r) => <><strong>{r.kind.replace(/_/g, ' ')}</strong><div className="muted small">{r.details?.summary}</div></> },
        { label: 'Amount', value: (r) => (r.amount === null ? '' : r.permission_code === 'sales.discount' ? `${(r.amount / 100).toFixed(1)}%` : money(r.amount)), num: true },
        { label: '', value: (r) => <div className="row-actions"><button type="button" className="btn small-btn danger" onClick={() => void decide(r.id, false)}>Reject</button><button type="button" className="btn small-btn primary" onClick={() => void decide(r.id, true)}>Approve</button></div> },
      ]} />
      <div className="panel-title" style={{ marginTop: 8 }}>Alerts</div>
      <Table rows={notes.data} error={notes.error} empty="No alerts yet." cols={[
        { label: '', value: (r) => <span className="alert-icon" aria-hidden>{ICON[r.kind] ?? '•'}</span> },
        { label: 'When', value: (r) => timeOf(r.created_at) },
        { label: 'Alert', value: (r) => <><strong className={r.read_at ? '' : 'unread'}>{r.title}</strong><div className="muted small">{r.body}</div></> },
      ]} />
    </>
  );
}

// ---- Team ------------------------------------------------------------------------------------
interface Member { id: string; full_name: string; kind: string; status: string; phone: string | null; roles: string | null; has_pin: boolean; last_seen: string | null }

export function Team(props: PageProps) {
  const [adding, setAdding] = useState(false);
  const [pinFor, setPinFor] = useState<Member | null>(null);
  const [tab, setTab] = useState<'staff' | 'roles'>('staff');
  const { data, error, reload } = useLoad(() => props.db.office<Member[]>('team'), []);
  const toggle = async (m: Member) => {
    if (m.status === 'active') await props.db.ownerCall('disable_user', m.id, 'Disabled by the owner');
    else await props.db.ownerCall('enable_user', m.id);
    reload();
  };
  return (
    <>
      <PageHead title="Team" sub="Staff, their roles and counter PINs. Staff work only on the shop's PCs.">
        <button type="button" className="btn primary" onClick={() => setAdding(true)}>+ Add staff</button>
      </PageHead>
      <div className="tabs">
        <button type="button" className={`tab${tab === 'staff' ? ' on' : ''}`} onClick={() => setTab('staff')}>Staff</button>
        <button type="button" className={`tab${tab === 'roles' ? ' on' : ''}`} onClick={() => setTab('roles')}>What each role can do</button>
      </div>
      {tab === 'roles' ? <RolePermissions {...props} /> : <Table rows={data} error={error} cols={[
        { label: 'Name', value: (r) => <><strong>{r.full_name}</strong><div className="muted small">{r.phone}</div></> },
        { label: 'Role', value: (r) => r.roles ?? '—' },
        { label: 'PIN', value: (r) => (r.has_pin ? <span className="pill good">Set</span> : <span className="pill warn">Not set</span>) },
        { label: 'Last active', value: (r) => timeOf(r.last_seen) },
        { label: 'Status', value: (r) => (r.status === 'active' ? <span className="pill good">Active</span> : <span className="pill bad">Disabled</span>) },
        { label: '', value: (r) => (
          <div className="row-actions">
            {/* The owner needs a PIN too, to sell at a counter; only staff can be disabled. */}
            <button type="button" className="btn small-btn" onClick={() => setPinFor(r)}>{r.has_pin ? 'Change PIN' : 'Set PIN'}</button>
            {r.kind !== 'owner' && <button type="button" className={`btn small-btn${r.status === 'active' ? ' danger' : ''}`} onClick={() => void toggle(r)}>{r.status === 'active' ? 'Disable' : 'Enable'}</button>}
          </div>) },
      ]} />}
      {adding && <AddStaff {...props} onClose={() => setAdding(false)} onSaved={() => { setAdding(false); reload(); }} />}
      {pinFor && <SetPin {...props} member={pinFor} onClose={() => setPinFor(null)} onSaved={() => { setPinFor(null); reload(); }} />}
    </>
  );
}

function AddStaff(props: PageProps & { onClose: () => void; onSaved: () => void }) {
  // Staff work on the counter screen: only roles that can sell are offered (Salesman first).
  const roles = useLoad(async () => (await props.db.office<{ id: string; name: string; counter?: boolean }[]>('roles')).filter((r) => r.counter !== false), []);
  const [f, setF] = useState({ name: '', phone: '', role: '', allBranches: false, pin: '' });
  const set = (k: keyof typeof f, v: string | boolean) => setF((x) => ({ ...x, [k]: v }));
  const { busy, error, submit } = useSubmit(async () => {
    const check = checkPin(f.pin);
    if (!check.ok) throw new Error(check.problem === 'format' ? 'PIN must be 4 to 6 digits' : 'PIN is too easy (no 1234 or 1111)');
    const uid = await props.db.ownerCall<string>('create_staff', f.name, f.phone || null, null, 'ur');
    await props.db.ownerCall('assign_role', uid, f.role || roles.data?.[0]?.id, f.allBranches ? null : props.branchId);
    await props.db.ownerCall('set_staff_pin', uid, await hashPin(f.pin));
  }, props.onSaved);
  return (
    <Modal title="Add staff" onClose={props.onClose}>
      <form className="form-grid" onSubmit={submit}>
        <label className="field"><span>Name *</span><input required autoFocus value={f.name} onChange={(e) => set('name', e.target.value)} /></label>
        <label className="field"><span>Mobile</span><input value={f.phone} onChange={(e) => set('phone', e.target.value)} /></label>
        <label className="field"><span>Role</span><select value={f.role || roles.data?.[0]?.id || ''} onChange={(e) => set('role', e.target.value)}>{(roles.data ?? []).map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}</select></label>
        <p className="muted small span-2">Salesman: sells, udhaar within the limit you set. Pharmacist: also prescriptions and controlled drugs. Manager: sells and gives discounts within your limits. Returns and voids always ask you first.</p>
        <label className="field"><span>Counter PIN (4–6 digits) *</span><input required inputMode="numeric" maxLength={6} value={f.pin} onChange={(e) => set('pin', e.target.value.replace(/\D/g, ''))} /></label>
        <label className="check span-2"><input type="checkbox" checked={f.allBranches} onChange={(e) => set('allBranches', e.target.checked)} /> Works at every branch</label>
        {error && <div className="form-error span-2">{error}</div>}
        <div className="row-actions span-2"><button type="button" className="btn ghost" onClick={props.onClose}>Cancel</button><button className="btn primary" disabled={busy}>{busy ? 'Saving…' : 'Add staff'}</button></div>
      </form>
    </Modal>
  );
}

function SetPin(props: PageProps & { member: Member; onClose: () => void; onSaved: () => void }) {
  const [pin, setPin] = useState('');
  const { busy, error, submit } = useSubmit(async () => {
    const check = checkPin(pin);
    if (!check.ok) throw new Error(check.problem === 'format' ? 'PIN must be 4 to 6 digits' : 'PIN is too easy (no 1234 or 1111)');
    await props.db.ownerCall('set_staff_pin', props.member.id, await hashPin(pin));
  }, props.onSaved);
  return (
    <Modal title={`New PIN · ${props.member.full_name}`} onClose={props.onClose}>
      <form className="stack" onSubmit={submit}>
        <input autoFocus inputMode="numeric" maxLength={6} className="pin-input" value={pin} onChange={(e) => setPin(e.target.value.replace(/\D/g, ''))} />
        {error && <div className="form-error">{error}</div>}
        <div className="row-actions"><button type="button" className="btn ghost" onClick={props.onClose}>Cancel</button><button className="btn primary" disabled={busy}>{busy ? 'Saving…' : 'Save PIN'}</button></div>
      </form>
    </Modal>
  );
}

// ---- Settings --------------------------------------------------------------------------------
const LS = { theme: 'medflow.theme', contrast: 'medflow.contrast' };
export function applyDisplayPrefs() {
  try {
    const theme = localStorage.getItem(LS.theme);
    const contrast = localStorage.getItem(LS.contrast);
    if (theme) localStorage.removeItem(LS.theme); // light only now; forget an old dark choice
    delete document.documentElement.dataset.theme;
    if (contrast === 'high') document.documentElement.dataset.contrast = 'high'; else delete document.documentElement.dataset.contrast;
  } catch { /* private window */ }
}

const HOTKEYS: Array<[string, string]> = [
  ['F2', 'Search medicine / scan'], ['F3', 'Quantity of the selected line'], ['F4', 'Customer'], ['F5', 'Price'], ['F6', 'Discount %'], ['F7', 'Bill discount'],
  ['F8', 'Hold bill'], ['F9', 'Held bills'], ['F10', 'Cash received'], ['F12', 'Complete sale'], ['Ctrl+U', 'Next pack size'], ['Ctrl+M', 'Next payment method'],
  ['Ctrl+Delete', 'Remove line'], ['↑ ↓', 'Move between lines'], ['Esc', 'Clear search / new sale'], ['Ctrl+K', 'Back office: jump to any page'],
];
const ALERTS: Array<[string, string, string | null]> = [
  ['large_discount', 'Large discount on one bill', 'Rs'], ['void', 'A bill is voided', null], ['cash_short', 'Cash drawer short', 'Rs'],
  ['controlled_sale', 'Controlled drug sold', null], ['expiring_batches', 'Batches expiring soon', 'days'], ['low_stock', 'Low stock', null],
  ['device_offline', 'Counter PC offline', 'hours'], ['udhaar_over_limit', 'Udhaar over limit', null],
];

export function Settings(props: PageProps) {
  const biz = useLoad(() => props.db.office<{ business: { name: string; owner_name: string; owner_phone: string; city: string; status: string; trial_ends_at: string | null;
    branch: string; address: string; phone: string | null; footer: string | null; width: number | null; rounding: number | null }; rules: Array<{ kind: string; enabled: boolean; threshold: number | null }>; devices: Array<{ name: string; last_seen_at: string | null; last_sync_at: string | null; app_version: string | null; status: string }> }>('settings', props.branchId), []);
  const [contrast, setContrast] = useState(() => { try { return localStorage.getItem(LS.contrast) ?? 'normal'; } catch { return 'normal'; } });
  const b = biz.data?.business;
  const rules = { data: biz.data?.rules ?? null, reload: biz.reload };
  const devices = { data: biz.data?.devices ?? null };
  const [footer, setFooter] = useState<string | null>(null);
  const [width, setWidth] = useState<string | null>(null);
  const [rounding, setRounding] = useState<string | null>(null);
  const [saved, setSaved] = useState('');
  const save = useSubmit(async () => {
    if (footer !== null) await props.db.ownerCall('set_setting', 'pos.receipt_footer', JSON.stringify(footer), null);
    if (width !== null) await props.db.ownerCall('set_setting', 'pos.receipt_width', width, null);
    if (rounding !== null) await props.db.ownerCall('set_setting', 'pos.bill_rounding_minor', String(rounding === '0' ? 0 : 100), null);
  }, () => { setSaved('Saved. New bills use these settings.'); biz.reload(); });
  const pref = (k: 'contrast', v: string) => {
    try { localStorage.setItem(LS[k], v); } catch { /* ignore */ }
    setContrast(v);
    applyDisplayPrefs();
  };
  const setRule = async (kind: string, enabled: boolean, threshold: number | null) => {
    await props.db.ownerCall('set_alert_rule', kind, enabled, threshold);
    rules.reload();
  };
  return (
    <>
      <PageHead title="Settings" sub="Your pharmacy, receipts, display, alerts, hot keys and sync" />
      <div className="grid-2">
        {isServer(props.db) && <LicencePanel {...props} />}
        {isServer(props.db) && <LocalServerPanel {...props} />}
        {isServer(props.db) && <OwnerViewPanel {...props} />}
        <section className="panel">
          <div className="panel-title">Business</div>
          {b ? (
            <dl className="facts">
              <dt>Pharmacy</dt><dd>{b.name}</dd><dt>Owner</dt><dd>{[b.owner_name, b.owner_phone].filter(Boolean).join(' · ') || '—'}</dd>
              <dt>Branch</dt><dd>{[b.branch, b.address].filter(Boolean).join(', ') || '—'}</dd><dt>Phone</dt><dd>{b.phone || '—'}</dd>
              <dt>Plan</dt><dd>{b.status === 'trial' ? `Free trial until ${timeOf(b.trial_ends_at)}` : b.status === 'active' ? 'Active' : b.status}</dd>
            </dl>
          ) : <div className="loading-row"><span className="spinner small" /></div>}
        </section>
        <section className="panel">
          <div className="panel-title">Counter & receipts</div>
          <form className="stack" onSubmit={save.submit}>
            <label className="field"><span>Line at the bottom of every receipt</span><input value={footer ?? b?.footer ?? ''} onChange={(e) => setFooter(e.target.value)} /></label>
            <div className="form-grid">
              <label className="field"><span>Paper width</span><select value={width ?? String(b?.width ?? 80)} onChange={(e) => setWidth(e.target.value)}><option value="80">80 mm</option><option value="58">58 mm</option></select></label>
              <label className="field"><span>Bill rounding</span><select value={rounding ?? String(b?.rounding ?? 100)} onChange={(e) => setRounding(e.target.value)}><option value="100">To the nearest Re 1</option><option value="0">No rounding</option></select></label>
            </div>
            {save.error && <div className="form-error">{save.error}</div>}
            {saved && <div className="message info">{saved}</div>}
            <div className="row-actions"><button className="btn primary" disabled={save.busy}>Save</button></div>
          </form>
        </section>
        <section className="panel">
          <div className="panel-title">Display (this PC)</div>
          <div className="seg"><span>Contrast</span>{['normal', 'high'].map((v) => <button key={v} type="button" className={`chip${contrast === v ? ' on' : ''}`} onClick={() => pref('contrast', v)}>{v}</button>)}</div>
          <p className="muted small">High contrast makes text darker and borders stronger, for older staff or bright shops.</p>
        </section>
        <section className="panel">
          <div className="panel-title">Alerts to your phone</div>
          <ul className="attention">
            {ALERTS.map(([kind, label, unit]) => {
              const r = (rules.data ?? []).find((x) => x.kind === kind);
              const on = r?.enabled ?? true;
              return (
                <li key={kind}>
                  <label className="check"><input type="checkbox" checked={on} onChange={(e) => void setRule(kind, e.target.checked, r?.threshold ?? null)} /> {label}</label>
                  {unit && <input className="threshold" inputMode="decimal" placeholder="default" defaultValue={r?.threshold ? (unit === 'Rs' ? r.threshold / 100 : r.threshold) : ''}
                                  onBlur={(e) => { const v = e.target.value.trim(); void setRule(kind, on, v ? (unit === 'Rs' ? toPaisa(v) : Number(v)) : null); }} aria-label={`${label} (${unit})`} />}
                </li>
              );
            })}
          </ul>
        </section>
        <section className="panel">
          <div className="panel-title">Hot keys</div>
          <table className="table hotkeys"><tbody>{HOTKEYS.map(([k, v]) => <tr key={k}><td><kbd>{k}</kbd></td><td>{v}</td></tr>)}</tbody></table>
        </section>
        <section className="panel">
          <div className="panel-title">Sync & backup</div>
          <ul className="attention">
            {(devices.data ?? []).map((d) => <li key={d.name}><span>{d.name} {d.app_version ? `· v${d.app_version}` : ''}</span><span className="muted small">last sync {timeOf(d.last_sync_at ?? d.last_seen_at)}</span></li>)}
          </ul>
          <p className="muted small">Every sale is saved on the counter first and sent to the cloud when online. Cloud backups run daily; you can export everything from Reports at any time.</p>
        </section>
      </div>
    </>
  );
}
