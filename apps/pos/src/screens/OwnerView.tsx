// Nuskha Owner: the owner's back office of a Nuskha Local pharmacy, from home or anywhere.
// The shop PC sends a copy of the back-office screens to Nuskha Cloud every minute it has
// internet (apps/server/src/mirror.ts): pages open from that copy straight away, even when the
// shop PC is off. With the owner PIN the owner can also change things: each change goes through
// Nuskha Cloud to the shop PC, which runs it as if the owner had signed in at the shop. The shop
// keeps the only copy of the records, so there is never a conflict.
import { useEffect, useMemo, useRef, useState } from 'react';
import type { PosBackend, PosContext } from '../backend/types.ts';
import { tr } from '../i18n.ts';
import { Office } from '../office/Office.tsx';
import { errorText } from '../util.ts';

const URL = (import.meta.env.VITE_SUPABASE_URL || import.meta.env.VITE_OWNER_CLOUD_URL) as string | undefined;
const KEY = (import.meta.env.VITE_SUPABASE_ANON_KEY || import.meta.env.VITE_OWNER_CLOUD_KEY) as string | undefined;
const CODE_KEY = 'nuskha.owner.view_code';
const TOKEN_KEY = 'nuskha.owner.token';

export const isViewRoute = () => /^#\/?view\b/.test(window.location.hash);
/** This Nuskha was opened before as the owner at home (the shop's view code is remembered). */
export const ownerAtHome = () => { try { return !!localStorage.getItem(CODE_KEY); } catch { return false; } };

interface Mirror {
  meta: { pharmacy: string; branch: string; branch_id: string; today: string; version: string; args?: Record<string, unknown[]>; can_change?: boolean };
  parts: Record<string, unknown>; pushed_at: string | null; now: string; loadedAt?: number;
}

async function rpc<T>(fn: string, body: unknown): Promise<T> {
  if (!URL || !KEY) throw new Error('Nuskha Cloud is not set up in this build');
  const res = await fetch(`${URL}/rest/v1/rpc/${fn}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', apikey: KEY, Authorization: `Bearer ${KEY}` }, body: JSON.stringify(body),
  });
  const out = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((out as { message?: string }).message ?? `Nuskha Cloud answered ${res.status}`);
  return out as T;
}
// loadedAt: this laptop's clock when the copy came, to compare times on the cloud's clock.
const readMirror = async (code: string) => ({ ...(await rpc<Mirror>('mirror_read', { p_view_code: code })), loadedAt: Date.now() });

export class ShopOffline extends Error {}
export class SignInAgain extends Error {}

/** Ask the shop PC (through Nuskha Cloud) and wait for its answer. */
async function askShop(code: string, body: Record<string, unknown>, waitMs = 30_000): Promise<unknown> {
  const id = crypto.randomUUID();
  await rpc('relay_ask', { p_view_code: code, p_id: id, p_body: body });
  const until = Date.now() + waitMs;
  for (let delay = 600; Date.now() < until; delay = Math.min(delay + 300, 1500)) {
    await new Promise((r) => setTimeout(r, delay));
    const a = await rpc<{ status: string; ok?: boolean; result?: unknown }>('relay_answer', { p_view_code: code, p_id: id });
    if (a.status === 'done') {
      if (a.ok) return a.result;
      const msg = typeof a.result === 'string' ? a.result : 'The shop could not do that';
      if (/sign in again/i.test(msg)) throw new SignInAgain(msg);
      throw new Error(msg);
    }
    if (a.status === 'gone') break;
  }
  throw new ShopOffline('The shop PC is not answering: it is switched off or has no internet. You can still look; changes work when it is online.');
}

const same = (a: unknown, b: unknown) => JSON.stringify(a ?? []) === JSON.stringify(b ?? []);

/** A back office that opens pages from the copy and asks the shop PC for everything else. */
let wroteAt = 0;   // after a change, read from the shop itself until the copy catches up

function ownerBackend(m: Mirror, code: string, token: string | null, onWrite: () => void, onSignInAgain: () => void): PosBackend {
  // Times on the cloud's clock: the copy is fresh again once it was sent after the change.
  const cloudNow = () => Date.parse(m.now) + (Date.now() - (m.loadedAt ?? Date.now()));
  const fresh = () => !wroteAt || (m.pushed_at !== null && Date.parse(m.pushed_at) > wroteAt);
  const fromCopy = (key: string, args: unknown[]) => fresh() && key in m.parts && same(m.meta.args?.[key], args);
  const ask = async (kind: 'call' | 'table', fn: string, args: unknown[]) => {
    if (!token) throw new Error('Sign in with your owner PIN to do this (top of the page).');
    try { return await askShop(code, { kind, fn, args, token }); }
    catch (e) { if (e instanceof SignInAgain) onSignInAgain(); throw e; }
  };
  const write = async (kind: 'call' | 'table', fn: string, args: unknown[]) => {
    const r = await ask(kind, fn, args);
    wroteAt = cloudNow(); onWrite();
    return r;
  };
  const READS = /^(office_|owner_dashboard$|party_|report_|trial_balance$|get_receipt$)/;
  const b = {
    office: (name: string, ...args: unknown[]) => {
      const key = `office_${name}`;
      if (fromCopy(key, args)) return Promise.resolve(m.parts[key]);
      if (!token && key in m.parts) return Promise.resolve(m.parts[key]);   // looking only: the copy as it is
      return ask('call', key, args);
    },
    ownerCall: (fn: string, ...args: unknown[]) => {
      if (fn === 'owner_dashboard' && args.length === 0 && (fromCopy('owner_dashboard', []) || !token)) return Promise.resolve(m.parts.owner_dashboard);
      return READS.test(fn) ? ask('call', fn, args) : write('call', fn, args);
    },
    ownerTable: (fn: string, ...args: unknown[]) => {
      const key = `${fn}:${String(args[0])}`;
      if (fn === 'party_ageing' && key in m.parts && (fromCopy(key, args) || !token)) return Promise.resolve(m.parts[key]);
      return READS.test(fn) ? ask('table', fn, args) : write('table', fn, args);
    },
  };
  const atShop = () => Promise.reject(new Error('This is done on the shop PC itself.'));
  return new Proxy(b, { get: (t, k) => (k in t ? t[k as keyof typeof t] : () => atShop()) }) as unknown as PosBackend;
}

function ago(iso: string | null, now: string) {
  if (!iso) return 'never';
  const m = Math.max(0, Math.round((Date.parse(now) - Date.parse(iso)) / 60_000));
  return m < 1 ? 'just now' : m < 60 ? `${m} min ago` : m < 1440 ? `${Math.round(m / 60)} h ago` : `${Math.round(m / 1440)} days ago`;
}

const get = (k: string) => { try { return localStorage.getItem(k) ?? ''; } catch { return ''; } };
const put = (k: string, v: string | null) => { try { if (v) localStorage.setItem(k, v); else localStorage.removeItem(k); } catch { /* private window */ } };

export function OwnerView(props: { onLeave?: () => void } = {}) {
  const [code, setCode] = useState(() => get(CODE_KEY));
  const [token, setToken] = useState<string | null>(() => get(TOKEN_KEY) || null);
  const [typed, setTyped] = useState('');
  const [pin, setPin] = useState('');
  const [m, setM] = useState<Mirror | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [pinOpen, setPinOpen] = useState(false);
  const codeRef = useRef(code);

  const load = async (c: string) => {
    try { const r = await readMirror(c); setM(r); setError(null); return true; }
    catch (e) { setError(errorText(e)); return false; }
  };
  useEffect(() => {
    codeRef.current = code;
    if (!code) return;
    void load(code).then((ok) => { if (!ok && !m) { setCode(''); put(CODE_KEY, null); } });
    const t = window.setInterval(() => void load(code), 60_000);
    return () => window.clearInterval(t);
  }, [code]);

  const signIn = async (c: string, p: string) => {
    const r = await askShop(c, { kind: 'login', pin: p }) as { token: string };
    put(TOKEN_KEY, r.token); setToken(r.token); setPin(''); setPinOpen(false);
  };
  const open = async () => {
    const c = typed.trim().toUpperCase();
    setBusy(true); setError(null);
    try {
      const r = await readMirror(c);
      put(CODE_KEY, c); setCode(c); setM(r);
      if (pin) await signIn(c, pin).catch((e) => setError(errorText(e)));
    } catch (e) { setError(errorText(e)); } finally { setBusy(false); }
  };
  const signOut = () => { put(CODE_KEY, null); put(TOKEN_KEY, null); setCode(''); setToken(null); setM(null); props.onLeave?.(); };
  const dropToken = () => { put(TOKEN_KEY, null); setToken(null); };

  const backend = useMemo(() => (m ? ownerBackend(m, code, token, () => window.setTimeout(() => void load(codeRef.current), 4000), dropToken) : null), [m, token, code]);

  if (!code || !m || !backend) {
    return (
      <div className="setup-shell owner-view-gate">
        <form className="card stack" onSubmit={(e) => { e.preventDefault(); void open(); }}>
          <div className="brand-line"><img src="/icon-48.png" alt="" width="32" height="32" /> <strong>Nuskha · owner at home</strong></div>
          <h1>Your pharmacy, from anywhere</h1>
          <p className="muted">On the shop's Nuskha go to Settings → Owner's laptop, press "Turn on live view", and type the pharmacy code here.</p>
          <label className="field"><span>Pharmacy code (from the shop's Settings)</span>
            <input autoFocus value={typed} onChange={(e) => setTyped(e.target.value)} placeholder="NSK-XXXX-XXXX-XXXX-XXXX" spellCheck={false} /></label>
          <label className="field"><span>Owner PIN (to make changes; leave empty to only look)</span>
            <input type="password" inputMode="numeric" value={pin} onChange={(e) => setPin(e.target.value)} autoComplete="off" /></label>
          {error && <div className="form-error">{error}</div>}
          <button className="btn primary" disabled={busy || typed.trim().length < 10}>{busy ? 'Opening…' : 'Open my pharmacy'}</button>
          {props.onLeave && <button type="button" className="btn ghost" onClick={props.onLeave}>Back</button>}
          <p className="muted small">The shop keeps working without internet. You see it whenever the shop is online, and its last copy when it is not.</p>
        </form>
      </div>
    );
  }
  const ctx = {
    pharmacy: m.meta.pharmacy, language: 'en', branch: { id: m.meta.branch_id, code: '', name: m.meta.branch, address: '', phone: null },
    device: { id: '', code: '', name: 'Owner laptop', invoice_prefix: '' }, drawers: [], open_shift: null, next_invoice_seq: 0, next_return_seq: 0,
    staff: [], settings: { rounding_step: 100, receipt_width: 80, receipt_footer: null }, today: m.meta.today,
  } as PosContext;
  const stale = m.pushed_at ? Date.parse(m.now) - Date.parse(m.pushed_at) > 10 * 60_000 : true;
  const banner = (
    <div className={`live-banner${stale ? ' stale' : ''}`}>
      <span className="dot" aria-hidden /> {token ? 'Owner, from home' : 'Live view'} · {m.meta.pharmacy} · updated {ago(m.pushed_at, m.now)}
      {stale && <span> · the shop PC is offline or switched off: you see its last copy, and changes wait until it is online</span>}
      {!token && (pinOpen ? (
        <form className="pin-inline" onSubmit={(e) => { e.preventDefault(); setBusy(true); setError(null); void signIn(code, pin).catch((er) => setError(errorText(er))).finally(() => setBusy(false)); }}>
          <input type="password" inputMode="numeric" autoFocus placeholder="Owner PIN" value={pin} onChange={(e) => setPin(e.target.value)} />
          <button className="btn small-btn primary" disabled={busy || pin.length < 4}>{busy ? 'Asking the shop…' : 'Sign in'}</button>
        </form>
      ) : <button type="button" className="btn small-btn" onClick={() => setPinOpen(true)}>Make changes (owner PIN)</button>)}
      {error && <span className="warn-text"> · {error}</span>}
    </div>
  );
  return (
    <Office backend={backend} ctx={ctx} lang="en" t={(k, v) => tr(k, 'en', v)} reload={async () => ctx}
            session={{ sessionId: '', staff: { id: '', name: 'Owner', kind: 'owner', pin_hash: '', locked_until: null, idle_lock_seconds: null, roles: [], can_approve: false } as never }}
            onOpenPos={() => {}} onToggleLang={() => {}} viewOnly={{ banner, readOnly: !token }}
            onSignOut={signOut} />
  );
}
