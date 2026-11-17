// What each role may do: one switch per permission, grouped by area, with "needs my OK" and a
// limit where the permission has one (discount %, return amount, voids per day...). Each change
// saves at once through set_role_permission and is written to the audit log by the database.
import { useEffect, useState } from 'react';
import { errorText, toPaisa } from '../util.ts';
import { useLoad, type PageProps } from './ui.tsx';

interface Perm {
  code: string; module: string; name: string; limit_kind: 'amount' | 'percent_bp' | 'count_per_day' | 'amount_per_day' | null;
  is_sensitive: boolean; allowed: boolean; needs_approval: boolean; limit_value: number | null;
}

const MODULE: Record<string, string> = {
  core: 'Basics', sales: 'Selling', limits: 'Limits', products: 'Medicines', stock: 'Stock', purchasing: 'Purchases',
  customers: 'Customers', udhaar: 'Udhaar & payments', cash: 'Cash & expenses', finance: 'Accounts', compliance: 'Prescriptions & licences',
  reports: 'Reports', admin: 'Admin', owner: 'Owner only', messaging: 'Messages', smart: 'Smart features', sync: 'Offline sync', platform: 'Subscription',
};

const limitLabel = (k: Perm['limit_kind']) => k === 'percent_bp' ? 'Up to %' : k === 'count_per_day' ? 'Times a day' : k ? 'Up to Rs' : '';
const fromLimit = (k: Perm['limit_kind'], v: number | null) => v === null ? '' : k === 'percent_bp' ? String(v / 100) : k === 'count_per_day' ? String(v) : String(v / 100);
const toLimit = (k: Perm['limit_kind'], s: string): number | null => {
  if (s.trim() === '') return null;
  if (k === 'percent_bp') return Math.round(Number(s) * 100);
  if (k === 'count_per_day') return Math.round(Number(s));
  return toPaisa(s);
};

export function RolePermissions(props: PageProps) {
  const roles = useLoad(() => props.db.office<{ id: string; name: string }[]>('roles'), []);
  const [role, setRole] = useState<string>('');
  useEffect(() => { if (!role && roles.data?.[0]) setRole(roles.data[0].id); }, [roles.data]);
  const perms = useLoad(() => (role ? props.db.office<Perm[]>('role_permissions', role) : Promise.resolve([] as Perm[])), [role]);
  const [rows, setRows] = useState<Perm[]>([]);
  useEffect(() => { setRows(perms.data ?? []); }, [perms.data]);
  const [saving, setSaving] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState('');

  const save = async (p: Perm, change: Partial<Perm>) => {
    const next = { ...p, ...change };
    if (!next.allowed) next.needs_approval = false;
    setSaving(p.code); setError(null);
    setRows((rs) => rs.map((r) => (r.code === p.code ? next : r)));
    try {
      await props.db.ownerCall('set_role_permission', role, p.code, next.allowed, next.needs_approval, next.limit_value);
    } catch (err) {
      setError(`${p.name}: ${errorText(err)}`);
      setRows((rs) => rs.map((r) => (r.code === p.code ? p : r)));
    } finally { setSaving(null); }
  };

  const shown = rows.filter((r) => !filter || `${r.name} ${r.code}`.toLowerCase().includes(filter.toLowerCase()));
  const groups = [...new Set(shown.map((r) => r.module))];

  return (
    <div className="stack">
      <div className="toolbar">
        <label className="field inline-field"><span>Role</span>
          <select value={role} onChange={(e) => setRole(e.target.value)}>
            {(roles.data ?? []).map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
          </select>
        </label>
        <input className="search" placeholder="Find a permission…" value={filter} onChange={(e) => setFilter(e.target.value)} />
      </div>
      <p className="muted small">Changes save at once and apply the next time staff unlock the counter. <strong>Needs OK</strong> means they can ask you (PIN or phone) each time.</p>
      {(error || perms.error || roles.error) && <div className="form-error">{error ?? perms.error ?? roles.error}</div>}
      {groups.map((g) => (
        <section key={g} className="panel">
          <div className="panel-title">{MODULE[g] ?? g}</div>
          <div className="perm-list">
            {shown.filter((r) => r.module === g).map((p) => (
              <div key={p.code} className={`perm-row${p.allowed ? '' : ' off'}`}>
                <label className="switch">
                  <input type="checkbox" checked={p.allowed} disabled={saving === p.code} onChange={(e) => void save(p, { allowed: e.target.checked })} />
                  <span className="switch-track" aria-hidden />
                  <span className="perm-name">{p.name}{p.is_sensitive && <span className="pill warn">sensitive</span>}</span>
                </label>
                <label className="check small">
                  <input type="checkbox" checked={p.needs_approval} disabled={!p.allowed || saving === p.code} onChange={(e) => void save(p, { needs_approval: e.target.checked })} /> Needs OK
                </label>
                {p.limit_kind ? (
                  <LimitBox perm={p} disabled={!p.allowed || saving === p.code} onSave={(v) => void save(p, { limit_value: v })} />
                ) : <span />}
              </div>
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}

function LimitBox(props: { perm: Perm; disabled: boolean; onSave: (v: number | null) => void }) {
  const { perm } = props;
  const [text, setText] = useState(fromLimit(perm.limit_kind, perm.limit_value));
  useEffect(() => setText(fromLimit(perm.limit_kind, perm.limit_value)), [perm.limit_value]);
  const commit = () => {
    const v = toLimit(perm.limit_kind, text);
    if (v !== null && (!Number.isFinite(v) || v < 0)) { setText(fromLimit(perm.limit_kind, perm.limit_value)); return; }
    if (v !== perm.limit_value) props.onSave(v);
  };
  return (
    <label className="limit">
      <span className="muted small">{limitLabel(perm.limit_kind)}</span>
      <input inputMode="decimal" placeholder="no limit" disabled={props.disabled} value={text}
             onChange={(e) => setText(e.target.value)} onBlur={commit} onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }} />
    </label>
  );
}
