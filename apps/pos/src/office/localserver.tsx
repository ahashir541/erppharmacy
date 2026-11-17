// Settings on MedFlow Local: where the data is backed up, "Back up now", and the address other
// counter PCs open to join (same shop network).
import { useEffect, useState } from 'react';
import { serverStatus, type BackupList, type ServerBackend, type ServerStatus } from '../backend/server.ts';
import { errorText } from '../util.ts';
import { timeOf, type PageProps } from './ui.tsx';

export const isServer = (db: PageProps['db']): db is PageProps['db'] & ServerBackend => typeof (db as Partial<ServerBackend>).backups === 'function';

export function LocalServerPanel(props: PageProps) {
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
  const last = list?.list[0];
  return (
    <section className="panel">
      <div className="panel-title">MedFlow Local · backups and counters</div>
      <dl className="facts">
        <dt>Last backup</dt><dd>{last ? `${timeOf(last.at)} · ${(last.size / 1048576).toFixed(1)} MB` : list ? 'None yet' : '…'}</dd>
        <dt>Backups kept</dt><dd>{list ? `${list.list.length} in ${list.folder}` : '…'}</dd>
        <dt>Second copy</dt><dd>{list ? (list.copy_to ?? 'Not set (see README: copyTo)') : '…'}</dd>
        <dt>Other counters open</dt><dd>{status ? (status.addresses.join(', ') || 'No shop network found') : '…'}</dd>
      </dl>
      <p className="muted small">A backup is made every night at 11 pm. On another PC of the shop, open the address above in Chrome or Edge and link it with your PIN.</p>
      {error && <div className="form-error">{error}</div>}
      <div className="row-actions"><button type="button" className="btn" disabled={busy} onClick={() => void now()}>{busy ? 'Backing up…' : 'Back up now'}</button></div>
    </section>
  );
}
