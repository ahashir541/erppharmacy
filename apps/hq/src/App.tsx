// MedFlow HQ console: first run creates your admin sign-in (on the HQ computer only), then the
// screens to run MedFlow as a business: pharmacies, payments, plans and prices, announcements.
import { useEffect, useState } from 'react';
import { errorText, hqStatus, hqToken, setupAdmin, signIn, signOut, type HqStatus } from './api.ts';
import { Announcements, Overview, Payments, Pharmacies, Plans } from './pages.tsx';

const NAV = [
  { key: 'overview', label: 'Overview', icon: '▦' },
  { key: 'pharmacies', label: 'Pharmacies', icon: '⌂' },
  { key: 'payments', label: 'Payments', icon: '₨' },
  { key: 'plans', label: 'Plans & prices', icon: '☰' },
  { key: 'announcements', label: 'Announcements', icon: '✉' },
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
  if (!signedIn) return <SignIn onDone={() => setSignedIn(true)} />;

  const go = (p: Page, arg?: string) => { setPage(p); setOpen(arg ?? null); };
  return (
    <div className="office">
      <aside className="sidebar" aria-label="Main menu">
        <div className="sidebar-head"><span className="brand-mark">M</span><span className="brand-name">MedFlow HQ</span></div>
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
    return <div className="boot"><div className="boot-card setup-card"><div className="brand-mark">M</div><h1>MedFlow HQ is not set up</h1>
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
        <div className="brand-mark">M</div>
        <h1>MedFlow HQ</h1>
        <p className="muted">Your control room for every pharmacy using MedFlow. Create your sign-in. Only you use this.</p>
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

function SignIn(props: { onDone: () => void }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  return (
    <div className="boot">
      <form className="boot-card setup-card stack" onSubmit={async (e) => {
        e.preventDefault(); setBusy(true); setError(null);
        try { await signIn(email, password); props.onDone(); } catch (err) { setError(errorText(err)); setBusy(false); }
      }}>
        <div className="brand-mark">M</div>
        <h1>Sign in to MedFlow HQ</h1>
        <label className="field"><span>Email</span><input autoFocus required type="email" value={email} onChange={(e) => setEmail(e.target.value)} /></label>
        <label className="field"><span>Password</span><input required type="password" value={password} onChange={(e) => setPassword(e.target.value)} /></label>
        {error && <div className="form-error">{error}</div>}
        <button className="btn primary" disabled={busy}>{busy ? 'Signing in…' : 'Sign in'}</button>
      </form>
    </div>
  );
}
