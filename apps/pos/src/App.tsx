import type { Lang } from '@medflow/core';
import { useCallback, useEffect, useRef, useState } from 'react';
import { cloudEnabled, CloudBackend, openCloudCounter, ownerContext, ownerReady } from './backend/cloud.ts';
import type { PosBackend, PosContext, Staff } from './backend/types.ts';
import { tr } from './i18n.ts';
import { Office } from './office/Office.tsx';
import { Pos } from './screens/Pos.tsx';
import { OpenShift } from './screens/Shift.tsx';
import { SignIn } from './screens/SignIn.tsx';
import { LinkCounter, OwnerSignIn } from './screens/CloudOwner.tsx';
import { LinkThisPc, SetupWizard } from './screens/LocalSetup.tsx';
import { LicenceBar } from './screens/LicenceBar.tsx';
import { savedToken, ServerBackend, serverMode, serverStatus, type ServerStatus } from './backend/server.ts';
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
  const [mode, setMode] = useState<'office' | 'pos'>('office');
  const [lang, setLang] = useState<Lang>(() => {
    try { return (localStorage.getItem(LANG_KEY) as Lang) || 'en'; } catch { return 'en'; }
  });
  const started = useRef(false);
  // Cloud: no counter login on this PC means the owner works from a browser or phone.
  const [ownerOnly, setOwnerOnly] = useState(false);
  const [ownerOk, setOwnerOk] = useState(false);
  const [branches, setBranches] = useState<Array<{ id: string; name: string }>>([]);
  const [linking, setLinking] = useState(false);
  // Nuskha Local: the pharmacy's server is not set up yet, or this PC is not linked.
  const [local, setLocal] = useState<{ status: ServerStatus; need: 'setup' | 'link' } | null>(null);

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    (async () => {
      try {
        if (serverMode) {
          setProgress('Connecting to Nuskha…');
          const status = await serverStatus();
          if (!status.ready) { setLocal({ status, need: 'setup' }); return; }
          const token = savedToken();
          if (!token) { setLocal({ status, need: 'link' }); return; }
          const b = new ServerBackend(token);
          try { setCtx(await b.context()); } catch (err) {
            if (!savedToken()) { setLocal({ status, need: 'link' }); return; }
            throw err;
          }
          setBackend(b);
          return;
        }
        if (cloudEnabled) {
          setProgress('Connecting to Nuskha…');
          const counter = await openCloudCounter();
          if (!counter) { setOwnerOnly(true); return; }
          setBackend(counter);
          setCtx(await counter.context());
          setOwnerOk(await ownerReady().catch(() => false));
          return;
        }
        // Demo mode: Nuskha's database runs inside this browser (loaded only when needed).
        const { openLocalBackend } = await import('./backend/local.ts');
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

  if (local) {
    const done = () => window.location.reload();
    return local.need === 'setup' ? <SetupWizard status={local.status} onDone={done} /> : <LinkThisPc status={local.status} onDone={done} />;
  }
  if (fatal) {
    return <div className="boot"><div className="boot-card error">{fatal}</div></div>;
  }
  // Cloud, owner from a browser or phone: sign in with 2FA, then the back office.
  if (ownerOnly) {
    if (!ownerOk || !backend || !ctx) {
      return <OwnerSignIn onReady={async () => {
        try {
          const c = await ownerContext();
          setBranches(c.branches);
          setBackend(new CloudBackend());
          setCtx(c);
          setOwnerOk(true);
        } catch (err) { setFatal(errorText(err)); }
      }} />;
    }
    const ownerSession: Session = { staff: { id: '', name: 'Owner', kind: 'owner', pin_hash: '', locked_until: null, idle_lock_seconds: null, roles: ['Owner'], can_approve: true }, sessionId: '' };
    return (
      <>
        <Office backend={backend} ctx={ctx} lang={lang} t={t} reload={async () => ctx} session={ownerSession}
                onOpenPos={() => setLinking(true)} onToggleLang={() => setLang((l) => (l === 'en' ? 'ur' : 'en'))}
                onSignOut={async () => { const { clients } = await import('./backend/cloud.ts'); await clients().owner.auth.signOut(); window.location.reload(); }} />
        {linking && <LinkCounter branches={branches} onCancel={() => setLinking(false)} onLinked={() => window.location.reload()} />}
      </>
    );
  }
  if (!backend || !ctx) {
    return (
      <div className="boot">
        <div className="boot-card">
          <div className="brand-mark">N</div>
          <div className="boot-title">Nuskha</div>
          <div className="spinner" />
          <div className="muted">{progress || tr('pos.loading', lang)}</div>
        </div>
      </div>
    );
  }

  const props: AppProps = { backend, ctx, lang, t, reload };
  const screen = (() => {
  const toggleLang = () => setLang((l) => (l === 'en' ? 'ur' : 'en'));

  if (!session) {
    return <SignIn {...props} onSignedIn={(s) => { setSession(s); setMode(s.staff.kind === 'owner' ? 'office' : 'pos'); }} onToggleLang={toggleLang} />;
  }
  // The owner lands in the back office; staff go straight to the counter.
  if (session.staff.kind === 'owner' && mode === 'office' && cloudEnabled && !ownerOk) {
    // On the cloud the back office needs the owner's own sign-in with 2FA, not just the PIN.
    return <OwnerSignIn onReady={() => setOwnerOk(true)} onCancel={() => setMode('pos')} />;
  }
  if (session.staff.kind === 'owner' && mode === 'office') {
    return <Office {...props} session={session} onOpenPos={() => setMode('pos')} onSignOut={() => void signOut()} onToggleLang={toggleLang} />;
  }
  if (!ctx.open_shift) {
    return <OpenShift {...props} session={session} onOpened={reload} onSignOut={() => void signOut()} />;
  }
  return <Pos {...props} session={session} onSignOut={() => void signOut()} onToggleLang={toggleLang}
              onBackOffice={session.staff.kind === 'owner' ? () => setMode('office') : undefined} />;
  })();
  return <>{screen}{serverMode && <LicenceBar />}</>;
}
