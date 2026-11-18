// A thin bar at the bottom of every screen on MedFlow Local when the licence needs attention:
// trial days left, payment late, read-only, no key yet, or news from MedFlow. The owner acts on it
// in Settings → MedFlow licence and billing.
import { useEffect, useState } from 'react';
import { serverStatus, type LicenceStatus } from '../backend/server.ts';

const SEEN = 'medflow.announcements.seen';

export function LicenceBar() {
  const [lic, setLic] = useState<LicenceStatus | null>(null);
  const [hidden, setHidden] = useState<string[]>(() => { try { return JSON.parse(localStorage.getItem(SEEN) ?? '[]') as string[]; } catch { return []; } });
  useEffect(() => {
    const load = () => serverStatus().then((s) => setLic(s.licence)).catch(() => {});
    void load();
    const t = window.setInterval(load, 10 * 60_000);
    return () => window.clearInterval(t);
  }, []);
  if (!lic || lic.state === 'off' || lic.state === 'demo') return null;
  const hide = (id: string) => {
    const next = [...hidden, id];
    setHidden(next);
    try { localStorage.setItem(SEEN, JSON.stringify(next.slice(-50))); } catch { /* ignore */ }
  };
  const news = lic.announcements.filter((a) => !hidden.includes(a.id));
  const tone = !lic.may_sell ? 'bad' : lic.status === 'grace' || lic.state === 'none' || lic.state === 'expired' ? 'warn' : 'info';
  const show = lic.message && (lic.state !== 'ok' || lic.status !== 'active');
  if (!show && !news.length) return null;
  return (
    <div className="licence-bar" role="status">
      {show && <div className={`licence-line ${tone}`}><strong>MedFlow:</strong> {lic.message}</div>}
      {news.slice(0, 2).map((a) => (
        <div key={a.id} className={`licence-line ${a.severity === 'info' ? 'info' : 'warn'}`}>
          <strong>{a.title}</strong> {a.body}
          <button type="button" className="link-btn" onClick={() => hide(a.id)} aria-label="Hide this message">OK</button>
        </div>
      ))}
    </div>
  );
}
