import type { Lang } from '@medflow/core';
import { useCallback, useEffect, useRef, useState } from 'react';
import { openLocalBackend } from './backend/local.ts';
import type { PosBackend, PosContext, Staff } from './backend/types.ts';
import { tr } from './i18n.ts';
import { Pos } from './screens/Pos.tsx';
import { OpenShift } from './screens/Shift.tsx';
import { SignIn } from './screens/SignIn.tsx';
import { errorText } from './util.ts';

export interface Session {
  staff: Staff;
  sessionId: string;
}

export interface AppProps {
  backend: PosBackend;
  ctx: PosContext;
  lang: Lang;
  t: (key: Parameters<typeof tr>[0], vars?: Record<string, string | number>) => string;
  reload: () => Promise<PosContext>;
}

const LANG_KEY = 'medflow.pos.lang';

export function App() {
  const [backend, setBackend] = useState<PosBackend | null>(null);
  const [ctx, setCtx] = useState<PosContext | null>(null);
  const [progress, setProgress] = useState('');
  const [fatal, setFatal] = useState<string | null>(null);
  const [session, setSession] = useState<Session | null>(null);
  const [lang, setLang] = useState<Lang>(() => {
    try { return (localStorage.getItem(LANG_KEY) as Lang) || 'en'; } catch { return 'en'; }
  });
  const started = useRef(false);

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    (async () => {
      try {
        const b = await openLocalBackend(setProgress);
        setBackend(b);
        setCtx(await b.context());
      } catch (err) {
        setFatal(errorText(err));
      }
    })();
  }, []);

  useEffect(() => {
    document.documentElement.lang = lang;
    document.documentElement.dir = lang === 'ur' ? 'rtl' : 'ltr';
    try { localStorage.setItem(LANG_KEY, lang); } catch { /* private window */ }
  }, [lang]);

  const t = useCallback((key: Parameters<typeof tr>[0], vars?: Record<string, string | number>) => tr(key, lang, vars), [lang]);
  const reload = useCallback(async () => {
    const c = await backend!.context();
    setCtx(c);
    return c;
  }, [backend]);

  const signOut = useCallback(async (reason: 'logout' | 'idle_lock' = 'logout') => {
    if (session && backend) await backend.endSession(session.sessionId, reason).catch(() => {});
    setSession(null);
    if (backend) setCtx(await backend.context());
  }, [session, backend]);

  // Lock the counter after the person's idle time (default 5 minutes) with no key or click.
  useEffect(() => {
    if (!session) return;
    const limit = (session.staff.idle_lock_seconds ?? 300) * 1000;
    let timer = window.setTimeout(() => void signOut('idle_lock'), limit);
    const bump = () => { window.clearTimeout(timer); timer = window.setTimeout(() => void signOut('idle_lock'), limit); };
    window.addEventListener('keydown', bump);
    window.addEventListener('pointerdown', bump);
    return () => { window.clearTimeout(timer); window.removeEventListener('keydown', bump); window.removeEventListener('pointerdown', bump); };
  }, [session, signOut]);

  if (fatal) {
    return <div className="boot"><div className="boot-card error">{fatal}</div></div>;
  }
  if (!backend || !ctx) {
    return (
      <div className="boot">
        <div className="boot-card">
          <div className="brand-mark">M</div>
          <div className="boot-title">MedFlow POS</div>
          <div className="spinner" />
          <div className="muted">{progress || tr('pos.loading', lang)}</div>
        </div>
      </div>
    );
  }

  const props: AppProps = { backend, ctx, lang, t, reload };
  const toggleLang = () => setLang((l) => (l === 'en' ? 'ur' : 'en'));

  if (!session) {
    return <SignIn {...props} onSignedIn={setSession} onToggleLang={toggleLang} />;
  }
  if (!ctx.open_shift) {
    return <OpenShift {...props} session={session} onOpened={reload} onSignOut={() => void signOut()} />;
  }
  return <Pos {...props} session={session} onSignOut={() => void signOut()} onToggleLang={toggleLang} />;
}
