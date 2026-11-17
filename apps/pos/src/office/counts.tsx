// Physical stock count: start a count (whole shop or one rack), walk the shelves typing what is
// really there, then submit and approve. Approving stores the difference and posts it as stock
// corrections; on a full count, anything with stock that was not counted is treated as 0.
import { useMemo, useState } from 'react';
import { errorText } from '../util.ts';
import { dateOf, Modal, PageHead, Stat, Table, timeOf, useLoad, useSubmit, type PageProps } from './ui.tsx';

interface CountRow { id: string; kind: 'full' | 'cycle'; rack_filter: string | null; status: 'open' | 'submitted' | 'approved' | 'cancelled';
  started_at: string; submitted_at: string | null; approved_at: string | null; lines: number; variance: number }
interface SheetRow { batch_id: string; brand_name: string; rack_location: string | null; batch_number: string; expiry_date: string;
  system_qty: number; counted: number | null; variance: number | null }

const STATUS: Record<CountRow['status'], [string, string]> = {
  open: ['Counting', 'warn'], submitted: ['Waiting for approval', 'warn'], approved: ['Done', 'good'], cancelled: ['Cancelled', 'bad'],
};

export function StockCounts(props: PageProps) {
  const [starting, setStarting] = useState(false);
  const [open, setOpen] = useState<CountRow | null>(null);
  const { data, error, reload } = useLoad(() => props.db.office<CountRow[]>('stock_counts', props.branchId), []);
  if (open) return <CountSheet {...props} count={open} onBack={() => { setOpen(null); reload(); }} />;
  return (
    <>
      <PageHead title="Stock count" sub="Count what is really on the shelves; MedFlow fixes the stock and shows what was missing">
        <button type="button" className="btn primary" onClick={() => setStarting(true)}>+ Start a count</button>
      </PageHead>
      <Table rows={data} error={error} onRow={setOpen} empty="No counts yet. Start one, for the whole shop or a single rack." cols={[
        { label: 'Started', value: (r) => timeOf(r.started_at) },
        { label: 'What', value: (r) => (r.kind === 'full' ? 'Whole shop' : 'Part') + (r.rack_filter ? ` · rack ${r.rack_filter}` : '') },
        { label: 'Counted', value: (r) => r.lines, num: true },
        { label: 'Difference', value: (r) => (r.status === 'approved' ? <span className={r.variance < 0 ? 'bad-text' : r.variance > 0 ? 'good-text' : ''}>{r.variance > 0 ? `+${r.variance}` : r.variance}</span> : '—'), num: true },
        { label: 'Status', value: (r) => <span className={`pill ${STATUS[r.status][1]}`}>{STATUS[r.status][0]}</span> },
      ]} />
      {starting && <StartCount {...props} onClose={() => setStarting(false)} onStarted={(c) => { setStarting(false); setOpen(c); }} />}
    </>
  );
}

function StartCount(props: PageProps & { onClose: () => void; onStarted: (c: CountRow) => void }) {
  const [kind, setKind] = useState<'full' | 'cycle'>('full');
  const [rack, setRack] = useState('');
  const { busy, error, submit } = useSubmit(async () => {
    const id = await props.db.ownerCall<string>('start_stock_count', props.branchId, kind, rack.trim() || null, null);
    props.onStarted({ id, kind, rack_filter: rack.trim() || null, status: 'open', started_at: new Date().toISOString(), submitted_at: null, approved_at: null, lines: 0, variance: 0 });
  }, () => {});
  return (
    <Modal title="Start a stock count" onClose={props.onClose}>
      <form className="stack" onSubmit={(e) => { e.preventDefault(); void submit(); }}>
        <label className="check"><input type="radio" checked={kind === 'full'} onChange={() => setKind('full')} />
          <span><strong>Full count</strong><div className="muted small">Anything not counted is treated as missing (0).</div></span></label>
        <label className="check"><input type="radio" checked={kind === 'cycle'} onChange={() => setKind('cycle')} />
          <span><strong>Spot check</strong><div className="muted small">Only what you count is corrected; the rest stays as it is.</div></span></label>
        <label className="field"><span>Only this rack (optional)</span><input placeholder="e.g. R1 or R2-S3" value={rack} onChange={(e) => setRack(e.target.value)} /></label>
        {error && <div className="form-error">{error}</div>}
        <div className="row-actions">
          <button type="button" className="btn ghost" onClick={props.onClose}>Cancel</button>
          <button className="btn primary" disabled={busy}>{busy ? '…' : 'Start counting'}</button>
        </div>
      </form>
    </Modal>
  );
}

function CountSheet(props: PageProps & { count: CountRow; onBack: () => void }) {
  const [count, setCount] = useState(props.count);
  const sheet = useLoad(() => props.db.office<SheetRow[]>('stock_count_sheet', count.id), [count.status]);
  const [typed, setTyped] = useState<Record<string, string>>({});
  const [saved, setSaved] = useState<Record<string, number>>({});
  const [q, setQ] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<{ lines: number; corrections: number } | null>(null);
  const editable = count.status === 'open';

  const rows = useMemo(() => (sheet.data ?? []).map((r) => ({ ...r, counted: saved[r.batch_id] ?? r.counted })), [sheet.data, saved]);
  const shown = rows.filter((r) => !q || `${r.brand_name} ${r.batch_number} ${r.rack_location ?? ''}`.toLowerCase().includes(q.toLowerCase()));
  const countedN = rows.filter((r) => r.counted !== null).length;
  const diff = rows.reduce((s, r) => s + (r.counted !== null ? r.counted - r.system_qty : 0), 0);

  const record = async (r: SheetRow) => {
    const text = typed[r.batch_id];
    if (text === undefined || text === '' || Number(text) === r.counted) return;
    const n = Number(text);
    if (!Number.isInteger(n) || n < 0) { setError(`${r.brand_name}: count must be a whole number`); return; }
    setError(null);
    try {
      await props.db.ownerCall('record_count', count.id, r.batch_id, n, null);
      setSaved((s) => ({ ...s, [r.batch_id]: n }));
    } catch (err) { setError(`${r.brand_name}: ${errorText(err)}`); }
  };

  const step = async (fn: 'submit_stock_count' | 'approve_stock_count') => {
    setBusy(true); setError(null);
    try {
      if (fn === 'submit_stock_count') {
        await props.db.ownerCall(fn, count.id, null);
        setCount((c) => ({ ...c, status: 'submitted' }));
      } else {
        setDone(await props.db.ownerCall<{ lines: number; corrections: number }>(fn, count.id));
        setCount((c) => ({ ...c, status: 'approved' }));
      }
    } catch (err) { setError(errorText(err)); } finally { setBusy(false); }
  };

  return (
    <>
      <PageHead title={`Stock count · ${count.kind === 'full' ? 'whole shop' : 'spot check'}${count.rack_filter ? ` · rack ${count.rack_filter}` : ''}`}
                sub={`Started ${timeOf(count.started_at)} · ${STATUS[count.status][0]}`}>
        <button type="button" className="btn ghost" onClick={props.onBack}>← All counts</button>
        {editable && <button type="button" className="btn primary" disabled={busy || countedN === 0} onClick={() => void step('submit_stock_count')}>Finish counting</button>}
        {count.status === 'submitted' && <button type="button" className="btn primary" disabled={busy} onClick={() => void step('approve_stock_count')}>Approve and fix stock</button>}
      </PageHead>
      <div className="stats">
        <Stat label="Batches on the list" value={rows.length} />
        <Stat label="Counted" value={`${countedN} / ${rows.length}`} tone={countedN === rows.length && rows.length ? 'good' : undefined} />
        <Stat label="Difference so far (units)" value={diff > 0 ? `+${diff}` : diff} tone={diff < 0 ? 'bad' : diff > 0 ? 'warn' : undefined} />
      </div>
      {count.status === 'submitted' && <div className="message info">Counting is finished. Check the differences below, then approve to correct the stock.{count.kind === 'full' ? ' Batches not counted will be set to 0.' : ''}</div>}
      {done && <div className="message info">Stock corrected: {done.corrections} batches changed out of {done.lines} checked. See them in Stock movements.</div>}
      {error && <div className="form-error">{error}</div>}
      <div className="filters"><input placeholder="Find medicine, batch or rack" value={q} onChange={(e) => setQ(e.target.value)} /></div>
      <Table rows={shown} error={sheet.error} empty="Nothing with stock on this rack." cols={[
        { label: 'Rack', value: (r) => r.rack_location ?? '—' },
        { label: 'Medicine', value: (r) => <strong>{r.brand_name}</strong> },
        { label: 'Batch', value: (r) => <>{r.batch_number}<div className="muted small">exp {dateOf(r.expiry_date)}</div></> },
        { label: 'System says', value: (r) => r.system_qty, num: true },
        { label: 'Counted', num: true, value: (r) => (editable ? (
          <input className="count-input" inputMode="numeric" aria-label={`Counted ${r.brand_name} ${r.batch_number}`}
                 value={typed[r.batch_id] ?? (r.counted ?? '')} placeholder="—"
                 onChange={(e) => setTyped((t) => ({ ...t, [r.batch_id]: e.target.value.replace(/\D/g, '') }))}
                 onBlur={() => void record(r)}
                 onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); const all = [...document.querySelectorAll<HTMLInputElement>('.count-input')]; all[all.indexOf(e.currentTarget) + 1]?.focus(); } }} />
        ) : (r.counted ?? '—')) },
        { label: 'Difference', num: true, value: (r) => {
          const v = r.variance ?? (r.counted !== null ? r.counted - r.system_qty : null);
          return v === null ? '' : <span className={v < 0 ? 'bad-text' : v > 0 ? 'good-text' : 'muted'}>{v > 0 ? `+${v}` : v}</span>;
        } },
      ]} />
    </>
  );
}
