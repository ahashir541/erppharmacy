import { useState } from 'react';
import type { AppProps, Session } from '../App.tsx';
import { errorText, toPaisa } from '../util.ts';

export function OpenShift(props: AppProps & { session: Session; onOpened: () => Promise<unknown>; onSignOut: () => void }) {
  const { t, ctx, backend, session } = props;
  const [cash, setCash] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const open = async () => {
    const amount = toPaisa(cash || '0');
    if (amount === null) { setError('Enter the cash in rupees, e.g. 5000'); return; }
    setBusy(true);
    try {
      await backend.openShift(ctx.drawers[0]!.id, amount, session.sessionId);
      await props.onOpened();
    } catch (err) {
      setError(errorText(err));
      setBusy(false);
    }
  };

  return (
    <div className="center-screen">
      <form className="card narrow" onSubmit={(e) => { e.preventDefault(); void open(); }}>
        <h1>{t('pos.open_shift_title')}</h1>
        <p className="muted">{t('pos.open_shift_hint')}</p>
        <label className="field">
          <span>{t('pos.opening_cash')}</span>
          <input autoFocus inputMode="decimal" value={cash} onChange={(e) => setCash(e.target.value)} placeholder="5000" />
        </label>
        {error && <div className="form-error">{error}</div>}
        <div className="row-actions">
          <button type="button" className="btn ghost" onClick={props.onSignOut}>{t('pos.change_user')}</button>
          <button type="submit" className="btn primary" disabled={busy || !ctx.drawers.length}>{t('pos.open_shift')}</button>
        </div>
        <p className="muted small">{session.staff.name} · {ctx.drawers[0]?.name}</p>
      </form>
    </div>
  );
}

/** Blind close: the person counts and enters the cash; they are never shown what was expected. */
export function CloseShift(props: AppProps & { session: Session; onClosed: () => void; onCancel: () => void }) {
  const { t, ctx, backend, session } = props;
  const [cash, setCash] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const close = async () => {
    const amount = toPaisa(cash);
    if (amount === null) { setError('Enter the cash you counted, in rupees'); return; }
    setBusy(true);
    try {
      await backend.closeShift(ctx.open_shift!.drawer_session_id, amount, session.sessionId);
      props.onClosed();
    } catch (err) {
      setError(errorText(err));
      setBusy(false);
    }
  };

  return (
    <div className="modal-backdrop" role="dialog" aria-modal="true">
      <form className="card narrow" onSubmit={(e) => { e.preventDefault(); void close(); }}>
        <h2>{t('pos.close_shift_title')}</h2>
        <p className="muted">{t('pos.close_shift_hint')}</p>
        <label className="field">
          <span>{t('pos.counted_cash')}</span>
          <input autoFocus inputMode="decimal" value={cash} onChange={(e) => setCash(e.target.value)} />
        </label>
        {error && <div className="form-error">{error}</div>}
        <div className="row-actions">
          <button type="button" className="btn ghost" onClick={props.onCancel}>{t('pos.cancel')}</button>
          <button type="submit" className="btn danger" disabled={busy}>{t('pos.close_shift')}</button>
        </div>
      </form>
    </div>
  );
}
