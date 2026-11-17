// Owner sign-in on the cloud: email and password, then the 6-digit code from an authenticator app
// (Google Authenticator, Microsoft Authenticator…). The first time, MedFlow shows a QR code to set
// the app up. Cloud sign-in is for owners only (D11); staff use PINs on the shop's PCs.
import { useEffect, useState } from 'react';
import { clients, linkCounter } from '../backend/cloud.ts';
import { errorText } from '../util.ts';

export function OwnerSignIn(props: { onReady: () => void; onCancel?: () => void }) {
  const [step, setStep] = useState<'password' | 'code' | 'enroll'>('password');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [factorId, setFactorId] = useState('');
  const [qr, setQr] = useState<{ svg: string; secret: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { owner } = clients();

  const afterPassword = async () => {
    const { data: aal } = await owner.auth.mfa.getAuthenticatorAssuranceLevel();
    if (aal?.currentLevel === 'aal2') { props.onReady(); return; }
    const { data: factors } = await owner.auth.mfa.listFactors();
    const totp = factors?.totp?.find((f) => f.status === 'verified');
    if (totp) { setFactorId(totp.id); setStep('code'); return; }
    const { data, error: e } = await owner.auth.mfa.enroll({ factorType: 'totp', friendlyName: 'MedFlow' });
    if (e) throw e;
    setFactorId(data.id);
    setQr({ svg: data.totp.qr_code, secret: data.totp.secret });
    setStep('enroll');
  };
  useEffect(() => { owner.auth.getSession().then(({ data }) => { if (data.session) void afterPassword().catch(() => {}); }); }, []);

  const run = async (fn: () => Promise<void>) => {
    setBusy(true); setError(null);
    try { await fn(); } catch (err) { setError(errorText(err)); } finally { setBusy(false); }
  };
  return (
    <div className="center-screen">
      <form className="card narrow" onSubmit={(e) => {
        e.preventDefault();
        void run(async () => {
          if (step === 'password') {
            const { error: e2 } = await owner.auth.signInWithPassword({ email: email.trim(), password });
            if (e2) throw e2;
            await afterPassword();
          } else {
            const { error: e3 } = await owner.auth.mfa.challengeAndVerify({ factorId, code: code.trim() });
            if (e3) throw e3;
            await owner.auth.refreshSession();
            props.onReady();
          }
        });
      }}>
        <div className="brand"><span className="brand-mark">M</span> MedFlow</div>
        <h1>{step === 'password' ? 'Owner sign-in' : step === 'enroll' ? 'Set up 2-step sign-in' : 'Enter your 6-digit code'}</h1>
        {step === 'password' && (
          <>
            <label className="field"><span>Email</span><input type="email" autoFocus required value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="username" /></label>
            <label className="field"><span>Password</span><input type="password" required value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" /></label>
          </>
        )}
        {step === 'enroll' && qr && (
          <>
            <p className="muted">Scan this with Google Authenticator or Microsoft Authenticator on your phone, then type the 6-digit code it shows. This keeps your pharmacy safe even if someone learns your password.</p>
            <img src={qr.svg} alt="QR code for your authenticator app" className="qr" />
            <p className="muted small">Can't scan? Enter this key in the app: <code>{qr.secret}</code></p>
          </>
        )}
        {step !== 'password' && (
          <label className="field"><span>6-digit code</span><input autoFocus inputMode="numeric" maxLength={6} required value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))} className="pin-input" /></label>
        )}
        {error && <div className="form-error">{error}</div>}
        <div className="row-actions">
          {props.onCancel && <button type="button" className="btn ghost" onClick={props.onCancel}>Back</button>}
          <button className="btn primary" disabled={busy}>{busy ? '…' : step === 'password' ? 'Continue' : 'Verify'}</button>
        </div>
        <p className="muted small">Staff don't sign in here: they use their PIN on the shop's counter PC.</p>
      </form>
    </div>
  );
}

/** The owner turns this browser into a counter PC for a branch. */
export function LinkCounter(props: { branches: Array<{ id: string; name: string }>; onLinked: () => void; onCancel: () => void }) {
  const [branch, setBranch] = useState(props.branches[0]?.id ?? '');
  const [code, setCode] = useState('C1');
  const [name, setName] = useState('Counter 1');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <div className="modal-backdrop" role="dialog" aria-modal="true">
      <form className="card narrow" onSubmit={async (e) => {
        e.preventDefault(); setBusy(true); setError(null);
        try { await linkCounter(branch, code.toUpperCase(), name); props.onLinked(); } catch (err) { setError(errorText(err)); setBusy(false); }
      }}>
        <h2>Use this computer as a counter</h2>
        <p className="muted">Staff will sell here with their PIN. Bills from this PC are numbered with the branch and counter code.</p>
        <label className="field"><span>Branch</span><select value={branch} onChange={(e) => setBranch(e.target.value)}>{props.branches.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}</select></label>
        <div className="form-grid">
          <label className="field"><span>Counter code</span><input value={code} maxLength={4} onChange={(e) => setCode(e.target.value.replace(/[^a-z0-9]/gi, '').toUpperCase())} /></label>
          <label className="field"><span>Name</span><input value={name} onChange={(e) => setName(e.target.value)} /></label>
        </div>
        {error && <div className="form-error">{error}</div>}
        <div className="row-actions"><button type="button" className="btn ghost" onClick={props.onCancel}>Cancel</button><button className="btn primary" disabled={busy}>Link this PC</button></div>
      </form>
    </div>
  );
}
