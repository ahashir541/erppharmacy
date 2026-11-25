// Settings on Nuskha Local: where the data is backed up, "Back up now", and the address other
// counter PCs open to join (same shop network).
import { useEffect, useState } from 'react';
import { serverStatus, type BackupList, type LicenceStatus, type MirrorStatus, type ServerBackend, type ServerStatus, type UpdateStatus } from '../backend/server.ts';
import { errorText, rs } from '../util.ts';
import { Info, Modal, timeOf, type PageProps } from './ui.tsx';

export const isServer = (db: PageProps['db']): db is PageProps['db'] & ServerBackend => typeof (db as Partial<ServerBackend>).backups === 'function';

export function LocalServerPanel(props: PageProps & { part?: 'backups' | 'counters' }) {
  const part = props.part ?? 'backups';
  const db = props.db as unknown as ServerBackend;
  const [list, setList] = useState<BackupList | null>(null);
  const [status, setStatus] = useState<ServerStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    db.backups().then(setList).catch((e) => setError(errorText(e)));
    serverStatus().then(setStatus).catch(() => {});
  }, []);
  const now = async () => {
    setBusy(true); setError(null);
    try { setList(await db.backups(true)); } catch (e) { setError(errorText(e)); } finally { setBusy(false); }
  };
  const [copy, setCopy] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  const saveCopy = async () => {
    setBusy(true); setError(null); setSaved(null);
    try {
      const l = await db.setBackupCopy((copy ?? '').trim());
      setList(l); setCopy(null);
      setSaved(l.copy_to ? `Every backup is now also saved in ${l.copy_to}. A first copy was made just now.` : 'The second copy is off.');
    } catch (e) { setError(errorText(e)); } finally { setBusy(false); }
  };
  const last = list?.list[0];
  return (
    <section className="panel">
      <div className="panel-title">{part === 'counters' ? 'Counter PCs' : 'Backups'}</div>
      {part === 'counters' ? (
        <>
          <dl className="facts">
            <dt>Add a PC <Info text="On another PC of the shop, open one of these addresses in Chrome or Edge (or install Nuskha there) and link it with your owner PIN. A 100.x address works through Tailscale, from anywhere." /></dt>
            <dd>{status ? (status.addresses.join(', ') || 'No shop network found') : '…'}</dd>
          </dl>
        </>
      ) : (<>
      <dl className="facts">
        <dt>Last backup <Info text="A backup is made every night at 11 pm and kept for 30 days (desktop icon: Nuskha Backups)." /></dt><dd>{last ? `${timeOf(last.at)} · ${(last.size / 1048576).toFixed(1)} MB` : list ? 'None yet' : '…'}</dd>
        <dt>Backups kept</dt><dd>{list ? `${list.list.length} in ${list.folder}` : '…'}</dd>
        <dt>Second copy</dt><dd>{list ? (list.copy_to ?? <span className="warn-text">Not set</span>) : '…'}</dd>
        <dt>Backup key <Info text="Backups are encrypted. Write this key down and keep it safe: you need it to open a backup on another PC. Nuskha HQ keeps a copy too." /></dt><dd>{list?.recovery_key ? <code className="key-code">{list.recovery_key}</code> : '…'}</dd>
      </dl>
      <label className="field"><span>Second copy (USB or Google Drive folder) <Info text="If this PC is lost, stolen or broken, this copy brings your pharmacy back on a new PC." /></span>
        <input value={copy ?? list?.copy_to ?? ''} placeholder="e.g. E:\Nuskha backups  or  G:\My Drive\Nuskha" onChange={(e) => { setCopy(e.target.value); setSaved(null); }} /></label>
      {error && <div className="form-error">{error}</div>}
      {saved && <div className="message info">{saved}</div>}
      <div className="row-actions">
        {copy !== null && <button type="button" className="btn primary" disabled={busy} onClick={() => void saveCopy()}>Save second copy</button>}
        <button type="button" className="btn" disabled={busy} onClick={() => void now()}>{busy ? 'Backing up…' : 'Back up now'}</button>
      </div>
      </>)}
    </section>
  );
}

const STATE_TEXT: Record<string, string> = {
  ok: 'Licensed', offline: 'Licensed (offline)', none: 'No licence key yet', expired: 'Needs to reach Nuskha', stopped: 'Not selling', demo: 'Demo', off: 'Not licensed',
};

/** Settings on Nuskha Local: the licence from Nuskha HQ, Nuskha's invoices, and paying them. */
export function LicencePanel(props: PageProps) {
  const db = props.db as unknown as ServerBackend;
  const [lic, setLic] = useState<LicenceStatus | null>(null);
  const [key, setKey] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ good: boolean; text: string } | null>(null);
  const [paying, setPaying] = useState<LicenceStatus['invoices'][number] | null>(null);
  const [upd, setUpd] = useState<UpdateStatus | null>(null);
  const [installing, setInstalling] = useState(false);
  useEffect(() => { serverStatus().then((s) => { setLic(s.licence); setUpd(s.update); }).catch((e) => setError(errorText(e))); }, []);
  const installNow = async () => {
    if (!window.confirm('Install the update now? Nuskha backs up, installs and restarts (about a minute). Counters reconnect by themselves.')) return;
    setInstalling(true); setError(null);
    try {
      await db.installUpdate();
      // Wait for the new version, then reload the page so this PC uses it too.
      for (let i = 0; i < 120; i++) {
        await new Promise((r) => setTimeout(r, 2000));
        const s = await serverStatus().catch(() => null);
        if (s?.update && s.update.current !== upd?.current) { window.location.reload(); return; }
      }
      setError('Nuskha did not come back yet. Wait a minute and reload the page.');
    } catch (e) { setError(errorText(e)); setInstalling(false); }
  };
  const run = async (fn: () => Promise<LicenceStatus>, what: 'key' | 'check') => {
    setBusy(true); setError(null); setNotice(null);
    try {
      const l = await fn();
      setLic(l); setKey('');
      window.dispatchEvent(new Event('nuskha:licence')); // the bar at the bottom refreshes at once
      const good = l.state === 'ok' || l.state === 'offline';
      setNotice(good
        ? { good, text: what === 'key' ? `Licence key verified.${l.plan_name ? ` Plan: ${l.plan_name}.` : ''}` : 'Checked with Nuskha just now: all good.' }
        : { good, text: l.last_error ?? l.message ?? 'Nuskha did not accept this key.' });
    } catch (e) { setError(errorText(e)); } finally { setBusy(false); }
  };
  if (!lic || lic.state === 'off' || lic.state === 'demo') return null;
  return (
    <section className="panel">
      <div className="panel-title">Nuskha licence and billing</div>
      <dl className="facts">
        <dt>Licence</dt><dd><span className={`pill ${lic.may_sell ? (lic.state === 'ok' ? 'good' : 'warn') : 'bad'}`}>{STATE_TEXT[lic.state] ?? lic.state}</span>{lic.message ? ` ${lic.message}` : ''}</dd>
        <dt>Plan</dt><dd>{lic.plan_name ?? '—'}{lic.status ? ` · ${lic.status.replace('_', '-')}` : ''}</dd>
        <dt>Key</dt><dd>{lic.key_hint ?? 'not entered'}</dd>
        <dt>Last check with Nuskha</dt><dd>{timeOf(lic.last_checkin_at)}</dd>
        <dt>Works offline until</dt><dd>{timeOf(lic.valid_until)}</dd>
      </dl>
      {notice ? <div className={`licence-result ${notice.good ? 'good' : 'bad'}`}><strong>{notice.good ? '✓ ' : ''}{notice.text}</strong></div>
        : lic.last_error && <div className="message error">{lic.last_error}</div>}
      <form className="row-inline" onSubmit={(e) => { e.preventDefault(); void run(() => db.setLicenceKey(key), 'key'); }}>
        <input placeholder={lic.key_hint ? 'New licence key' : 'Licence key MF-XXXX-XXXX-XXXX-XXXX'} value={key} onChange={(e) => setKey(e.target.value.toUpperCase())} />
        <button className="btn" disabled={busy || key.trim().length < 10}>{lic.key_hint ? 'Change key' : 'Enter key'}</button>
        <button type="button" className="btn" disabled={busy || !lic.key_hint} onClick={() => void run(() => db.checkLicence(), 'check')}>{busy ? '…' : 'Check now'}</button>
      </form>
      {lic.invoices.length > 0 && (
        <>
          <div className="panel-title">Nuskha invoices to pay</div>
          <ul className="attention">
            {lic.invoices.map((i) => (
              <li key={i.id}>
                <span><strong>{i.invoice_number}</strong> · {rs(i.amount)} · due {new Date(i.due_at).toLocaleDateString('en-GB')}</span>
                {i.status === 'submitted' ? <span className="pill warn">Payment being checked</span>
                  : <button type="button" className="btn small-btn primary" onClick={() => setPaying(i)}>I have paid</button>}
              </li>
            ))}
          </ul>
          {lic.payment_instructions && <p className="muted small pre">{lic.payment_instructions}</p>}
        </>
      )}
      {upd && (
        <>
          <div className="panel-title">Nuskha version</div>
          <dl className="facts">
            <dt>This PC runs</dt><dd>{upd.current}</dd>
            <dt>Update</dt><dd>{upd.offer?.version ? `${upd.offer.version}${upd.offer.is_rollback ? ' (going back to a safer version)' : ''} — installs by itself ${upd.install_window}, after the backup`
              : 'Up to date'}</dd>
            {upd.last_result && <><dt>Last update</dt><dd>{upd.last_result}</dd></>}
          </dl>
          {upd.offer?.notes && <p className="muted small pre">{upd.offer.notes}</p>}
          {upd.last_error && <div className="message error">{upd.last_error}</div>}
          {upd.offer?.version && <div className="row-actions"><button type="button" className="btn" disabled={installing || upd.installing} onClick={() => void installNow()}>
            {installing || upd.installing ? 'Installing… Nuskha restarts' : 'Install now'}</button></div>}
        </>
      )}
      {lic.announcements.map((a) => (
        <div key={a.id} className={`message ${a.severity === 'info' ? 'info' : 'error'}`}><strong>{a.title}</strong> {a.body}</div>
      ))}
      {error && <div className="form-error">{error}</div>}
      {paying && <PayInvoice invoice={paying} db={db} onClose={() => setPaying(null)} onDone={(s) => { setPaying(null); setLic(s); }} />}
    </section>
  );
}

function PayInvoice(props: { invoice: LicenceStatus['invoices'][number]; db: ServerBackend; onClose: () => void; onDone: (s: LicenceStatus) => void }) {
  const [method, setMethod] = useState('jazzcash');
  const [amount, setAmount] = useState(String(props.invoice.amount / 100));
  const [reference, setReference] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  return (
    <Modal title={`Pay ${props.invoice.invoice_number}`} onClose={props.onClose}>
      <form className="stack" onSubmit={async (e) => {
        e.preventDefault(); setBusy(true); setError(null);
        try { props.onDone(await props.db.payInvoice(props.invoice.id, method, Math.round(Number(amount) * 100), reference)); }
        catch (err) { setError(errorText(err)); setBusy(false); }
      }}>
        <p className="muted">Send the money first, then enter the transaction ID here. Nuskha confirms it, usually the same day.</p>
        <div className="form-grid">
          <label className="field"><span>Paid by</span><select value={method} onChange={(e) => setMethod(e.target.value)}>
            <option value="jazzcash">JazzCash</option><option value="easypaisa">Easypaisa</option><option value="bank_transfer">Bank transfer</option><option value="cash">Cash</option><option value="other">Other</option>
          </select></label>
          <label className="field"><span>Amount (Rs)</span><input inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} /></label>
        </div>
        <label className="field"><span>Transaction ID / reference *</span><input required autoFocus value={reference} onChange={(e) => setReference(e.target.value)} /></label>
        {error && <div className="form-error">{error}</div>}
        <div className="row-actions"><button type="button" className="btn ghost" onClick={props.onClose}>Cancel</button><button className="btn primary" disabled={busy}>{busy ? '…' : 'Send to Nuskha'}</button></div>
      </form>
    </Modal>
  );
}

/** Settings → Owner's laptop: a live, read-only copy of the back office for the owner's home laptop. */
export function OwnerViewPanel(props: PageProps) {
  const db = props.db as unknown as ServerBackend;
  const [st, setSt] = useState<MirrorStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    const load = () => db.mirrorStatus().then(setSt).catch((e) => setError(errorText(e)));
    load();
    const t = window.setInterval(load, 30_000);
    return () => window.clearInterval(t);
  }, []);
  const act = async (f: () => Promise<MirrorStatus>) => {
    setBusy(true); setError(null);
    try { setSt(await f()); } catch (e) { setError(errorText(e)); } finally { setBusy(false); }
  };
  if (st && !st.available) return null;
  return (
    <section className="panel">
      <div className="panel-title">Owner's laptop · live view</div>
      <p className="muted">Open this shop from home with the code and your owner PIN. <Info text="The shop keeps working without internet. Whenever it has internet, Nuskha sends a copy every minute. Changes made from home reach this PC whenever it is online." /></p>
      {st?.enabled ? (
        <>
          <dl className="facts">
            <dt>Pharmacy code <Info text='On the home laptop install Nuskha, choose "I am the owner, at home", then type this code and your owner PIN. Keep it private, like a password.' /></dt><dd><code className="key-code">{st.view_code}</code></dd>
            <dt>Last sent</dt><dd>{st.last_ok ? timeOf(st.last_ok) : 'Not yet'}{st.last_error ? <div className="warn-text small">No internet right now. Selling is not affected.</div> : null}</dd>
          </dl>
          <div className="row-actions">
            <button type="button" className="btn" disabled={busy} onClick={() => void act(() => db.mirrorEnable(true))}>New pharmacy code (old laptops stop)</button>
            <button type="button" className="btn ghost" disabled={busy} onClick={() => void act(() => db.mirrorDisable())}>Turn off and delete the copy</button>
          </div>
        </>
      ) : (
        <div className="row-actions"><button type="button" className="btn primary" disabled={busy || !st} onClick={() => void act(() => db.mirrorEnable(false))}>{busy ? 'Turning on…' : 'Turn on live view'}</button></div>
      )}
      {error && <div className="form-error">{error}</div>}
    </section>
  );
}
