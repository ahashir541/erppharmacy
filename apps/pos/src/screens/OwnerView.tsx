// Nuskha Owner: the owner's live, read-only view of a Nuskha Local pharmacy, from anywhere.
// The shop PC sends a copy of the back-office screens to Nuskha Cloud every minute it has
// internet (apps/server/src/mirror.ts). Here the owner types the view code once; the same Office
// pages render from that copy. Nothing can be changed from here.
import { useEffect, useMemo, useState } from 'react';
import type { PosBackend, PosContext } from '../backend/types.ts';
import { tr } from '../i18n.ts';
import { Office } from '../office/Office.tsx';
import { errorText } from '../util.ts';

const URL = import.meta.env.VITE_SUPABASE_URL as string | undefined;
const KEY = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined;
const CODE_KEY = 'nuskha.owner.view_code';

export const isViewRoute = () => /^#\/?view\b/.test(window.location.hash);

interface Mirror { meta: { pharmacy: string; branch: string; branch_id: string; today: string; version: string }; parts: Record<string, unknown>; pushed_at: string | null; now: string }

async function readMirror(code: string): Promise<Mirror> {
  if (!URL || !KEY) throw new Error('Nuskha Cloud is not set up in this build');
  const res = await fetch(`${URL}/rest/v1/rpc/mirror_read`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', apikey: KEY, Authorization: `Bearer ${KEY}` },
    body: JSON.stringify({ p_view_code: code }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((body as { message?: string }).message ?? `Nuskha Cloud answered ${res.status}`);
  return body as Mirror;
}

const viewOnly = () => Promise.reject(new Error('This is the live view: changes are made at the shop.'));

/** A back office that answers from the copy. */
function mirrorBackend(m: Mirror): PosBackend {
  const part = (k: string) => (k in m.parts ? Promise.resolve(m.parts[k]) : Promise.reject(new Error('Not in the live view yet. It comes with the next update from the shop.')));
  const b = {
    office: (name: string) => part(`office_${name}`),
    ownerCall: (fn: string) => (fn === 'owner_dashboard' ? part('owner_dashboard') : viewOnly()),
    ownerTable: (fn: string, kind: string) => (fn === 'party_ageing' ? part(`party_ageing:${kind}`) : viewOnly()),
  };
  return new Proxy(b, { get: (t, k) => (k in t ? t[k as keyof typeof t] : () => viewOnly()) }) as unknown as PosBackend;
}

function ago(iso: string | null, now: string) {
  if (!iso) return 'never';
  const m = Math.max(0, Math.round((Date.parse(now) - Date.parse(iso)) / 60_000));
  return m < 1 ? 'just now' : m < 60 ? `${m} min ago` : m < 1440 ? `${Math.round(m / 60)} h ago` : `${Math.round(m / 1440)} days ago`;
}

export function OwnerView() {
  const [code, setCode] = useState(() => { try { return localStorage.getItem(CODE_KEY) ?? ''; } catch { return ''; } });
  const [typed, setTyped] = useState('');
  const [m, setM] = useState<Mirror | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = async (c: string, first = false) => {
    if (first) setBusy(true);
    try {
      const r = await readMirror(c);
      setM(r); setError(null);
      if (first) { try { localStorage.setItem(CODE_KEY, c); } catch { /* private window */ } setCode(c); }
    } catch (e) {
      setError(errorText(e));
      if (first) setCode('');
    } finally { setBusy(false); }
  };
  useEffect(() => {
    if (!code) return;
    void load(code, !m);
    const t = window.setInterval(() => void load(code), 60_000);
    return () => window.clearInterval(t);
  }, [code]);

  const backend = useMemo(() => (m ? mirrorBackend(m) : null), [m]);
  if (!code || !m || !backend) {
    return (
      <div className="setup-shell owner-view-gate">
        <form className="card stack" onSubmit={(e) => { e.preventDefault(); void load(typed.trim().toUpperCase(), true); }}>
          <div className="brand-line"><img src="/icon-48.png" alt="" width="32" height="32" /> <strong>Nuskha Owner</strong></div>
          <h1>Your pharmacy, live</h1>
          <p className="muted">On the shop's Nuskha go to Settings → Owner's laptop, press "Turn on live view", and type the view code here.</p>
          <label className="field"><span>View code</span>
            <input autoFocus value={typed} onChange={(e) => setTyped(e.target.value)} placeholder="NSK-XXXX-XXXX-XXXX-XXXX" spellCheck={false} /></label>
          {error && <div className="form-error">{error}</div>}
          <button className="btn primary" disabled={busy || typed.trim().length < 10}>{busy ? 'Opening…' : 'Open my pharmacy'}</button>
          <p className="muted small">Read only. The shop keeps working without internet; this view updates whenever the shop is online.</p>
        </form>
      </div>
    );
  }
  const ctx = {
    pharmacy: m.meta.pharmacy, language: 'en', branch: { id: m.meta.branch_id, code: '', name: m.meta.branch, address: '', phone: null },
    device: { id: '', code: '', name: 'Owner view', invoice_prefix: '' }, drawers: [], open_shift: null, next_invoice_seq: 0, next_return_seq: 0,
    staff: [], settings: { rounding_step: 100, receipt_width: 80, receipt_footer: null }, today: m.meta.today,
  } as PosContext;
  const stale = m.pushed_at ? Date.parse(m.now) - Date.parse(m.pushed_at) > 10 * 60_000 : true;
  const banner = (
    <div className={`live-banner${stale ? ' stale' : ''}`}>
      <span className="dot" aria-hidden /> Live view · {m.meta.pharmacy} · updated {ago(m.pushed_at, m.now)}
      {stale && <span> · the shop PC is offline or switched off; you see its last copy</span>}
      {error && <span className="warn-text"> · {error}</span>}
    </div>
  );
  return (
    <Office backend={backend} ctx={ctx} lang="en" t={(k, v) => tr(k, 'en', v)} reload={async () => ctx}
            session={{ sessionId: '', staff: { id: '', name: 'Owner', kind: 'owner', pin_hash: '', locked_until: null, idle_lock_seconds: null, roles: [], can_approve: false } as never }}
            onOpenPos={() => {}} onToggleLang={() => {}} viewOnly={{ banner }}
            onSignOut={() => { try { localStorage.removeItem(CODE_KEY); } catch { /* ok */ } setCode(''); setM(null); }} />
  );
}
