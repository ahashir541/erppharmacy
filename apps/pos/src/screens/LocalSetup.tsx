// MedFlow Local, first start on the main PC: set up the pharmacy (or the demo pharmacy) in three
// short steps. On any other PC of the shop: link it as a counter with the owner's PIN.
import { checkPin } from '@medflow/core';
import { useState } from 'react';
import { linkThisPc, serverStatus, setupServer, type LicenceStatus, type ServerStatus } from '../backend/server.ts';
import { errorText } from '../util.ts';

const codeFrom = (city: string, branch: string) => {
  const letters = (city || branch).toUpperCase().replace(/[^A-Z]/g, '').slice(0, 3);
  return letters.length >= 2 ? `${letters}1` : 'MF1';
};

export function SetupWizard(props: { status: ServerStatus; onDone: () => void }) {
  const [step, setStep] = useState<'choose' | 'shop' | 'owner' | 'counter'>('choose');
  const [f, setF] = useState({ pharmacy: '', address: '', city: '', phone: '', branch_name: 'Main branch', branch_code: '', owner_name: '', owner_phone: '',
    pin: '', pin2: '', counter_name: 'Counter 1', licence_key: '', footer: 'Get well soon. Medicines once sold can be returned within 7 days with the bill.' });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [finished, setFinished] = useState<{ licence: LicenceStatus | null; error: string | null; keyEntered: boolean } | null>(null);
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement>) => setF((x) => ({ ...x, [k]: e.target.value }));

  if (!props.status.this_pc) {
    return (
      <div className="boot"><div className="boot-card setup-card">
        <div className="brand-mark">M</div>
        <h1>MedFlow is not set up yet</h1>
        <p className="muted">Set it up on the main PC first (the one where MedFlow Local is installed), by opening the MedFlow icon there.</p>
      </div></div>
    );
  }

  const run = async (body: Record<string, unknown>) => {
    setBusy(true); setError(null);
    try {
      const licenceError = await setupServer(body);
      const licence = await serverStatus().then((s) => s.licence).catch(() => null);
      setFinished({ licence, error: licenceError, keyEntered: Boolean(String(body.licence_key ?? '').trim()) });
      setBusy(false);
    } catch (err) { setError(errorText(err)); setBusy(false); }
  };
  const next = (to: typeof step) => (e: React.FormEvent) => {
    e.preventDefault(); setError(null);
    if (to === 'owner' && !f.branch_code) setF((x) => ({ ...x, branch_code: codeFrom(x.city, x.branch_name) }));
    if (to === 'counter') {
      const c = checkPin(f.pin);
      if (!c.ok) return setError(c.problem === 'format' ? 'PIN must be 4 to 6 digits' : 'That PIN is too easy to guess (no 1234 or 1111)');
      if (f.pin !== f.pin2) return setError('The two PINs are not the same');
    }
    setStep(to);
  };
  const dots = ['shop', 'owner', 'counter'] as const;

  if (finished) {
    const lic = finished.licence;
    const good = !finished.error && lic && (lic.state === 'ok' || lic.state === 'offline');
    const until = (v: string | null) => (v ? new Date(v).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' }) : null);
    return (
      <div className="boot">
        <div className="boot-card setup-card">
          <div className="done-check" aria-hidden>✓</div>
          <h1>MedFlow is set up</h1>
          {props.status.licensing && (good ? (
            <div className="licence-result good">
              <strong>Licence key verified</strong>
              <span>{lic!.plan_name ? `Plan: ${lic!.plan_name}` : 'Your pharmacy is licensed.'}
                {lic!.trial_ends_at ? ` · Free trial until ${until(lic!.trial_ends_at)}` : ''}</span>
            </div>
          ) : finished.keyEntered ? (
            <div className="licence-result bad">
              <strong>The licence key was not accepted</strong>
              <span>{finished.error ?? lic?.message ?? 'MedFlow could not check it.'}</span>
              <span className="small">You can still use MedFlow. Enter the key again in Settings → Licence.</span>
            </div>
          ) : (
            <div className="licence-result warn">
              <strong>No licence key entered</strong>
              <span>Enter it in Settings → Licence{lic?.no_key_until ? ` before ${until(lic.no_key_until)}` : ' within 7 days'}.</span>
            </div>
          ))}
          <button type="button" className="btn primary big-btn" onClick={props.onDone}>Open MedFlow</button>
        </div>
      </div>
    );
  }

  return (
    <div className="boot">
      <div className="boot-card setup-card">
        <div className="brand-mark">M</div>
        {step === 'choose' && (
          <>
            <h1>Welcome to MedFlow</h1>
            <p className="muted">Your pharmacy's records stay on this PC, backed up every night. No internet or monthly fee needed.</p>
            <div className="setup-choices">
              <button type="button" className="setup-choice" onClick={() => setStep('shop')}>
                <strong>Set up my pharmacy</strong><span className="muted small">Your shop name, owner and PIN. Takes 2 minutes.</span>
              </button>
              <button type="button" className="setup-choice" disabled={busy} onClick={() => void run({ mode: 'demo' })}>
                <strong>{busy ? 'Setting up…' : 'Try the demo pharmacy'}</strong><span className="muted small">28 medicines and 4 staff to practise with. Demo PINs: owner 1470.</span>
              </button>
            </div>
          </>
        )}
        {step !== 'choose' && <div className="setup-dots">{dots.map((d) => <span key={d} className={d === step ? 'on' : dots.indexOf(d) < dots.indexOf(step as never) ? 'done' : ''} />)}</div>}
        {step === 'shop' && (
          <form className="stack" onSubmit={next('owner')}>
            <h1>Your pharmacy</h1>
            <label className="field"><span>Pharmacy name *</span><input autoFocus required value={f.pharmacy} onChange={set('pharmacy')} placeholder="e.g. Al-Shifa Pharmacy" /></label>
            <label className="field"><span>Address (printed on bills)</span><input value={f.address} onChange={set('address')} placeholder="Shop 4, Main Road" /></label>
            <div className="form-grid">
              <label className="field"><span>City</span><input value={f.city} onChange={set('city')} placeholder="Karachi" /></label>
              <label className="field"><span>Shop phone</span><input value={f.phone} onChange={set('phone')} inputMode="tel" /></label>
            </div>
            <div className="row-actions"><button type="button" className="btn ghost" onClick={() => setStep('choose')}>Back</button><button className="btn primary">Next</button></div>
          </form>
        )}
        {step === 'owner' && (
          <form className="stack" onSubmit={next('counter')}>
            <h1>The owner</h1>
            <div className="form-grid">
              <label className="field"><span>Owner's name *</span><input autoFocus required value={f.owner_name} onChange={set('owner_name')} /></label>
              <label className="field"><span>Mobile</span><input value={f.owner_phone} onChange={set('owner_phone')} inputMode="tel" placeholder="03xx xxxxxxx" /></label>
            </div>
            <div className="form-grid">
              <label className="field"><span>Owner PIN (4–6 digits) *</span><input required type="password" inputMode="numeric" maxLength={6} value={f.pin} onChange={set('pin')} /></label>
              <label className="field"><span>PIN again *</span><input required type="password" inputMode="numeric" maxLength={6} value={f.pin2} onChange={set('pin2')} /></label>
            </div>
            <p className="muted small">The owner's PIN opens the back office and links new counter PCs. Keep it secret.</p>
            {error && <div className="form-error">{error}</div>}
            <div className="row-actions"><button type="button" className="btn ghost" onClick={() => setStep('shop')}>Back</button><button className="btn primary">Next</button></div>
          </form>
        )}
        {step === 'counter' && (
          <form className="stack" onSubmit={(e) => { e.preventDefault(); void run({ mode: 'new', ...f }); }}>
            <h1>This counter</h1>
            <div className="form-grid">
              <label className="field"><span>Branch name</span><input value={f.branch_name} onChange={set('branch_name')} /></label>
              <label className="field"><span>Bill prefix *</span><input required value={f.branch_code} maxLength={8}
                onChange={(e) => setF((x) => ({ ...x, branch_code: e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, '') }))} /></label>
            </div>
            <p className="muted small">Bills will be numbered {f.branch_code || 'KHI1'}-C1-000001, -000002…</p>
            <label className="field"><span>Name of this PC</span><input value={f.counter_name} onChange={set('counter_name')} /></label>
            <label className="field"><span>Message at the bottom of bills</span><input value={f.footer} onChange={set('footer')} /></label>
            {props.status.licensing && (
              <label className="field"><span>Licence key from MedFlow (you can also enter it later, within 7 days)</span>
                <input value={f.licence_key} placeholder="MF-XXXX-XXXX-XXXX-XXXX" autoComplete="off"
                       onChange={(e) => setF((x) => ({ ...x, licence_key: e.target.value.toUpperCase() }))} /></label>
            )}
            {error && <div className="form-error">{error}</div>}
            <div className="row-actions"><button type="button" className="btn ghost" onClick={() => setStep('owner')}>Back</button>
              <button className="btn primary" disabled={busy}>{busy ? 'Setting up…' : 'Start using MedFlow'}</button></div>
          </form>
        )}
        {step === 'choose' && error && <div className="form-error">{error}</div>}
      </div>
    </div>
  );
}

export function LinkThisPc(props: { status: ServerStatus; onDone: () => void }) {
  const [name, setName] = useState('');
  const [pin, setPin] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  return (
    <div className="boot">
      <form className="boot-card setup-card stack" onSubmit={async (e) => {
        e.preventDefault(); setBusy(true); setError(null);
        try { await linkThisPc(pin, name); props.onDone(); } catch (err) { setError(errorText(err)); setBusy(false); }
      }}>
        <div className="brand-mark">M</div>
        <h1>Link this PC to {props.status.pharmacy}</h1>
        <p className="muted">This PC becomes a counter of the pharmacy. The owner types their PIN once.</p>
        <label className="field"><span>Name of this PC</span><input autoFocus required value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Counter 2, Front desk" /></label>
        <label className="field"><span>Owner's PIN</span><input required type="password" inputMode="numeric" maxLength={6} value={pin} onChange={(e) => setPin(e.target.value.replace(/\D/g, ''))} /></label>
        {error && <div className="form-error">{error}</div>}
        <button className="btn primary" disabled={busy}>{busy ? 'Linking…' : 'Link this PC'}</button>
      </form>
    </div>
  );
}
