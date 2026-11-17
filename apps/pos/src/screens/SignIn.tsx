import { useState } from 'react';
import type { AppProps, Session } from '../App.tsx';
import type { Staff } from '../backend/types.ts';
import { errorText, isDemo, uuid } from '../util.ts';
import { PinPad } from './PinPad.tsx';

export function SignIn(props: AppProps & { onSignedIn: (s: Session) => void; onToggleLang: () => void }) {
  const { ctx, t, backend } = props;
  const [who, setWho] = useState<Staff | null>(ctx.staff.length === 1 ? ctx.staff[0]! : null);
  const [error, setError] = useState<string | null>(null);

  return (
    <div className="signin">
      <header className="signin-head">
        <div className="brand"><span className="brand-mark">M</span> MedFlow</div>
        <div className="signin-place">{ctx.pharmacy} · {ctx.branch.name} · {ctx.device.name}</div>
        <button type="button" className="link-btn" onClick={props.onToggleLang}>{t('pos.language')}</button>
      </header>
      {isDemo(ctx) && <div className="demo-ribbon">{t('pos.demo')}</div>}
      <main className="signin-body">
        <section className="staff-list" aria-label={t('pos.who')}>
          <h1>{t('pos.who')}</h1>
          <div className="staff-grid">
            {ctx.staff.map((s) => (
              <button key={s.id} type="button" className={`staff-tile${who?.id === s.id ? ' selected' : ''}`} onClick={() => { setWho(s); setError(null); }}>
                <span className="avatar">{s.name.split(' ').map((w) => w[0]).slice(0, 2).join('')}</span>
                <span className="staff-name">{s.name}</span>
                <span className="staff-role">{s.roles.join(', ') || s.kind}</span>
              </button>
            ))}
          </div>
          {isDemo(ctx) && <p className="muted small">Demo PINs: Bilal 1357 · Sana 2580 · Dr. Ayesha 2469 · Owner 1470</p>}
        </section>
        <section className="pin-panel">
          {who ? (
            <PinPad
              staff={who}
              title={t('pos.pin_for', { name: who.name })}
              wrongText={t('pos.wrong_pin')}
              submitText={t('pos.sign_in')}
              onWrong={async () => { await backend.pinFailure(who.id).catch(() => {}); }}
              onOk={async () => {
                const sessionId = uuid();
                try {
                  await backend.startSession(who.id, sessionId);
                  props.onSignedIn({ staff: who, sessionId });
                } catch (err) {
                  setError(errorText(err));
                }
              }}
            />
          ) : (
            <div className="pin-placeholder">{t('pos.who')}</div>
          )}
          {error && <div className="form-error">{error}</div>}
        </section>
      </main>
    </div>
  );
}
