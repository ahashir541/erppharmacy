import { useEffect, useState } from 'react';
import type { AppProps, Session } from '../App.tsx';
import type { Staff } from '../backend/types.ts';
import { errorText, uuid } from '../util.ts';
import { PinPad } from './PinPad.tsx';

const greeting = (h: number) => (h < 12 ? 'Good morning' : h < 17 ? 'Good afternoon' : 'Good evening');
const initials = (name: string) => name.split(' ').filter(Boolean).map((w) => w[0]).slice(0, 2).join('').toUpperCase();

export function SignIn(props: AppProps & { onSignedIn: (s: Session) => void; onToggleLang: () => void }) {
  const { ctx, t, backend } = props;
  const [who, setWho] = useState<Staff | null>(ctx.staff.length === 1 ? ctx.staff[0]! : null);
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(() => new Date());
  useEffect(() => { const id = window.setInterval(() => setNow(new Date()), 30_000); return () => window.clearInterval(id); }, []);

  return (
    <div className="signin2">
      <aside className="signin2-hero">
        <div className="signin2-brand"><span className="brand-mark">N</span> Nuskha</div>
        <div className="signin2-welcome">
          <div className="signin2-greet">{greeting(now.getHours())}</div>
          <div className="signin2-pharmacy">{ctx.pharmacy}</div>
          <div className="signin2-place">{ctx.branch.name} · {ctx.device.name}</div>
        </div>
        <div className="signin2-clock">
          <strong>{now.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}</strong>
          <span>{now.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })}</span>
        </div>
      </aside>
      <main className="signin2-main">
        <div className="signin2-top">
          <button type="button" className="link-btn" onClick={props.onToggleLang}>{t('pos.language')}</button>
        </div>
        <div className="signin2-box">
          <h1>{t('pos.who')}</h1>
          <div className="signin2-staff" role="list">
            {ctx.staff.map((s) => (
              <button key={s.id} type="button" role="listitem" className={`signin2-person${who?.id === s.id ? ' on' : ''}`}
                      onClick={() => { setWho(s); setError(null); }}>
                <span className="avatar">{initials(s.name)}</span>
                <span className="signin2-person-text"><strong>{s.name}</strong><span>{s.roles.join(', ') || s.kind}</span></span>
              </button>
            ))}
          </div>
          <div className="signin2-pin">
            {who ? (
              <PinPad
                key={who.id}
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
              <div className="pin-placeholder">Tap your name to enter your PIN</div>
            )}
            {error && <div className="form-error">{error}</div>}
          </div>
        </div>
      </main>
    </div>
  );
}
