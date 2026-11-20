// Nuskha HQ console: first run creates your admin sign-in (on the HQ computer only), then the
// screens to run Nuskha as a business: pharmacies, payments, plans and prices, announcements.
import { useEffect, useRef, useState } from 'react';
import { errorText, getSignInOptions, googleSignIn, hqStatus, hqToken, saveSignInOptions, setupAdmin, signIn, signOut, type HqStatus, type SignInOptions } from './api.ts';
import { Announcements, Overview, Payments, Pharmacies, Plans, Updates } from './pages.tsx';

const NAV = [
  { key: 'overview', label: 'Overview', icon: '▦' },
  { key: 'pharmacies', label: 'Pharmacies', icon: '⌂' },
  { key: 'payments', label: 'Payments', icon: '₨' },
  { key: 'plans', label: 'Plans & prices', icon: '☰' },
  { key: 'announcements', label: 'Announcements', icon: '✉' },
  { key: 'updates', label: 'Updates', icon: '⟳' },
  { key: 'signin', label: 'Sign-in & security', icon: '⚿' },
] as const;
type Page = (typeof NAV)[number]['key'];

export function App() {
  const [status, setStatus] = useState<HqStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [signedIn, setSignedIn] = useState(!!hqToken());
  const [page, setPage] = useState<Page>('overview');
  const [open, setOpen] = useState<string | null>(null);
  useEffect(() => { hqStatus().then(setStatus).catch((e) => setError(errorText(e))); }, []);

  if (error) return <div className="boot"><div className="boot-card error">{error}</div></div>;
  if (!status) return <div className="boot"><div className="boot-card"><div className="spinner" /></div></div>;
  if (!status.has_admin) return <CreateAdmin status={status} onDone={() => setStatus({ ...status, has_admin: true })} />;
  if (!signedIn) return <SignIn status={status} onDone={() => setSignedIn(true)} />;

  const go = (p: Page, arg?: string) => { setPage(p); setOpen(arg ?? null); };
  return (
    <div className="office">
      <aside className="sidebar" aria-label="Main menu">
        <div className="sidebar-head"><button type="button" className="brand-home" title="Overview" onClick={() => go('overview')}><span className="brand-mark">N</span><span className="brand-name">Nuskha HQ</span></button></div>
        <nav>
          <div className="nav-group">
            {NAV.map((n) => (
              <button key={n.key} type="button" className={`nav-item${page === n.key ? ' on' : ''}`} onClick={() => go(n.key)}>
                <span className="nav-icon" aria-hidden>{n.icon}</span><span className="nav-label">{n.label}</span>
              </button>
            ))}
          </div>
        </nav>
        <div className="sidebar-foot">
          <div className="who-block"><strong>Platform owner</strong><span className="muted small">v{status.version}</span></div>
          <button type="button" className="link-btn" onClick={async () => { await signOut(); setSignedIn(false); }}>Sign out</button>
        </div>
      </aside>
      <div className="office-main">
        <main className="office-content">
          {page === 'overview' && <Overview go={go} />}
          {page === 'pharmacies' && <Pharmacies openId={open} onOpen={(id) => setOpen(id)} />}
          {page === 'payments' && <Payments go={go} />}
          {page === 'plans' && <Plans />}
          {page === 'announcements' && <Announcements />}
          {page === 'updates' && <Updates />}
          {page === 'signin' && <SignInSettings />}
        </main>
      </div>
    </div>
  );
}

function CreateAdmin(props: { status: HqStatus; onDone: () => void }) {
  const [f, setF] = useState({ name: '', email: '', password: '', password2: '' });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  if (!props.status.this_pc) {
    return <div className="boot"><div className="boot-card setup-card"><div className="brand-mark">N</div><h1>Nuskha HQ is not set up</h1>
      <p className="muted">Create the admin sign-in on the HQ computer itself.</p></div></div>;
  }
  return (
    <div className="boot">
      <form className="boot-card setup-card stack" onSubmit={async (e) => {
        e.preventDefault(); setError(null);
        if (f.password !== f.password2) return setError('The two passwords are not the same');
        setBusy(true);
        try { await setupAdmin(f.name, f.email, f.password); await signIn(f.email, f.password); props.onDone(); window.location.reload(); }
        catch (err) { setError(errorText(err)); setBusy(false); }
      }}>
        <div className="brand-mark">N</div>
        <h1>Nuskha HQ</h1>
        <p className="muted">Your control room for every pharmacy using Nuskha. Create your sign-in. Only you use this.</p>
        <label className="field"><span>Your name</span><input autoFocus required value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></label>
        <label className="field"><span>Email</span><input required type="email" value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} /></label>
        <div className="form-grid">
          <label className="field"><span>Password (10+ characters)</span><input required type="password" minLength={10} value={f.password} onChange={(e) => setF({ ...f, password: e.target.value })} /></label>
          <label className="field"><span>Password again</span><input required type="password" value={f.password2} onChange={(e) => setF({ ...f, password2: e.target.value })} /></label>
        </div>
        {error && <div className="form-error">{error}</div>}
        <button className="btn primary" disabled={busy}>{busy ? 'Creating…' : 'Create and sign in'}</button>
      </form>
    </div>
  );
}

/** Google's own "Sign in with Google" button. HQ checks the token Google returns. */
function GoogleButton(props: { clientId: string; onCredential: (credential: string) => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const [failed, setFailed] = useState(false);
  const cb = useRef(props.onCredential);
  cb.current = props.onCredential;
  useEffect(() => {
    type Gsi = { accounts: { id: { initialize: (o: object) => void; renderButton: (el: HTMLElement, o: object) => void } } };
    const w = window as unknown as { google?: Gsi };
    const draw = () => {
      if (!w.google || !ref.current) return setFailed(true);
      w.google.accounts.id.initialize({ client_id: props.clientId, callback: (r: { credential: string }) => cb.current(r.credential), ux_mode: 'popup' });
      w.google.accounts.id.renderButton(ref.current, { theme: 'outline', size: 'large', text: 'signin_with', shape: 'pill', width: 320 });
    };
    if (w.google?.accounts) { draw(); return; }
    const el = document.createElement('script');
    el.src = 'https://accounts.google.com/gsi/client'; el.async = true; el.onload = draw; el.onerror = () => setFailed(true);
    document.head.appendChild(el);
  }, [props.clientId]);
  return failed ? <div className="form-error">Google sign-in could not load. Check the internet connection.</div> : <div ref={ref} className="google-btn" />;
}

function SignIn(props: { status: HqStatus; onDone: () => void }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const google = props.status.google_client_id;
  const passwordAllowed = props.status.this_pc || props.status.password_from_internet;
  return (
    <div className="boot">
      <div className="boot-card setup-card stack">
        <div className="brand-mark">N</div>
        <h1>Sign in to Nuskha HQ</h1>
        <p className="muted">Your control room for every pharmacy using Nuskha.</p>
        {google && (
          <GoogleButton clientId={google} onCredential={async (credential) => {
            setBusy(true); setError(null);
            try { await googleSignIn(credential); props.onDone(); } catch (err) { setError(errorText(err)); setBusy(false); }
          }} />
        )}
        {google && passwordAllowed && <div className="or-line"><span>or with your password</span></div>}
        {passwordAllowed ? (
          <form className="stack" onSubmit={async (e) => {
            e.preventDefault(); setBusy(true); setError(null);
            try { await signIn(email, password); props.onDone(); } catch (err) { setError(errorText(err)); setBusy(false); }
          }}>
            <label className="field"><span>Email</span><input autoFocus={!google} required type="email" value={email} onChange={(e) => setEmail(e.target.value)} /></label>
            <label className="field"><span>Password</span><input required type="password" value={password} onChange={(e) => setPassword(e.target.value)} /></label>
            <button className="btn primary" disabled={busy}>{busy ? 'Signing in…' : 'Sign in'}</button>
          </form>
        ) : <p className="muted small">Password sign-in works only on the HQ computer. From here, use Sign in with Google.</p>}
        {error && <div className="form-error">{error}</div>}
      </div>
    </div>
  );
}

function SignInSettings() {
  const [o, setO] = useState<SignInOptions | null>(null);
  const [f, setF] = useState({ email: '', google_client_id: '', password_only_this_pc: false, security_contact: '' });
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const load = (x: SignInOptions) => { setO(x); setF({ email: x.email, google_client_id: x.google_client_id ?? '', password_only_this_pc: x.password_only_this_pc, security_contact: x.security_contact ?? '' }); };
  useEffect(() => { getSignInOptions().then(load).catch((e) => setError(errorText(e))); }, []);
  if (!o) return error ? <div className="form-error">{error}</div> : <div className="spinner" />;
  const origins = Array.from(new Set([window.location.origin, 'http://localhost:5299']));
  return (
    <>
      <div className="page-head"><div><h1>Sign-in & security</h1><p className="muted">How you get into Nuskha HQ.</p></div></div>
      <section className="panel">
        <div className="panel-title">Now</div>
        <dl className="facts">
          <dt>Owner account</dt><dd>{o.email}</dd>
          <dt>Sign in with Google</dt><dd>{o.google_client_id ? <span className="pill good">On</span> : <span className="pill warn">Off</span>}</dd>
          <dt>Security contact (security.txt)</dt><dd>{o.security_contact ? <span className="pill good">{o.security_contact}</span> : <span className="pill warn">Not set</span>}</dd>
          <dt>Password from the internet</dt><dd>{o.password_only_this_pc ? <span className="pill good">Off (Google only)</span> : <span className="pill warn">Allowed</span>}</dd>
        </dl>
      </section>
      <form className="panel stack" onSubmit={async (e) => {
        e.preventDefault(); setBusy(true); setError(null); setSaved(null);
        try { load(await saveSignInOptions(f)); setSaved('Saved. Sign out and try Sign in with Google to check it works.'); }
        catch (err) { setError(errorText(err)); } finally { setBusy(false); }
      }}>
        <div className="panel-title">Change</div>
        {!o.this_pc && <div className="message info">For safety, these can only be changed on the HQ computer itself.</div>}
        <label className="field"><span>Your Google email (only this account can sign in with Google)</span>
          <input type="email" required value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} /></label>
        <label className="field"><span>Google Client ID</span>
          <input value={f.google_client_id} placeholder="1234567890-abc123.apps.googleusercontent.com" onChange={(e) => setF({ ...f, google_client_id: e.target.value.trim() })} /></label>
        <label className="check"><input type="checkbox" checked={f.password_only_this_pc} onChange={(e) => setF({ ...f, password_only_this_pc: e.target.checked })} />
          <span>From the internet, allow Google sign-in only (the password still works on this HQ computer)</span></label>
        <label className="field"><span>Security contact, shown publicly in /.well-known/security.txt (an email or https:// link; empty = off)</span>
          <input value={f.security_contact} placeholder="security@yourcompany.com" onChange={(e) => setF({ ...f, security_contact: e.target.value.trim() })} /></label>
        {error && <div className="form-error">{error}</div>}
        {saved && <div className="licence-result good"><strong>{saved}</strong></div>}
        <div className="row-actions"><button className="btn primary" disabled={busy || !o.this_pc}>{busy ? 'Saving…' : 'Save'}</button></div>
      </form>
      <section className="panel">
        <div className="panel-title">Getting a Google Client ID (one time, free)</div>
        <ol className="steps">
          <li>Open <strong>console.cloud.google.com</strong> with your Google account and create a project (e.g. "Nuskha HQ").</li>
          <li>Go to <strong>APIs & Services → OAuth consent screen</strong>: choose External, app name "Nuskha HQ", your email. Save.</li>
          <li>Go to <strong>APIs & Services → Credentials → Create credentials → OAuth client ID</strong>, type <strong>Web application</strong>.</li>
          <li>Under <strong>Authorised JavaScript origins</strong> add: {origins.map((x) => <code key={x}>{x}</code>).reduce<React.ReactNode[]>((a, c, i) => (i ? [...a, ' and ', c] : [c]), [])}. Leave redirect URIs empty.</li>
          <li>Copy the <strong>Client ID</strong> (not the secret) into the box above and press Save.</li>
        </ol>
      </section>
    </>
  );
}
