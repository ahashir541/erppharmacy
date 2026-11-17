// Small building blocks for the back office: a page header, stat cards, tables, a pop-up and a
// data loader. Pages stay short and read like the screen.
import { useEffect, useState, type ReactNode } from 'react';
import type { OfficeBackend } from '../backend/types.ts';
import { errorText, rs } from '../util.ts';

export interface PageProps {
  db: OfficeBackend;
  branchId: string;
  today: string;
  go: (page: string, arg?: string) => void;
}

/** Loads data for a page and reloads when asked or when its inputs change. */
export function useLoad<T>(fn: () => Promise<T>, deps: unknown[]) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [n, setN] = useState(0);
  useEffect(() => {
    let live = true;
    setError(null);
    fn().then((d) => { if (live) setData(d); }).catch((e) => { if (live) setError(errorText(e)); });
    return () => { live = false; };
  }, [...deps, n]);
  return { data, error, reload: () => setN((x) => x + 1) };
}

export function PageHead(props: { title: string; sub?: string; children?: ReactNode }) {
  return (
    <div className="page-head">
      <div>
        <h1>{props.title}</h1>
        {props.sub && <div className="muted">{props.sub}</div>}
      </div>
      <div className="page-actions">{props.children}</div>
    </div>
  );
}

export function Stat(props: { label: string; value: ReactNode; sub?: ReactNode; tone?: 'good' | 'bad' | 'warn' | undefined }) {
  return (
    <div className={`stat${props.tone ? ` ${props.tone}` : ''}`}>
      <div className="stat-label">{props.label}</div>
      <div className="stat-value">{props.value}</div>
      {props.sub && <div className="stat-sub">{props.sub}</div>}
    </div>
  );
}

export interface Col<T> {
  label: string;
  value: (row: T) => ReactNode;
  num?: boolean;
  csv?: (row: T) => string | number | null;
}

export function Table<T>(props: { rows: T[] | null; cols: Col<T>[]; onRow?: (row: T) => void; empty?: string; error?: string | null }) {
  if (props.error) return <div className="form-error">{props.error}</div>;
  if (!props.rows) return <div className="loading-row"><span className="spinner small" /> Loading…</div>;
  if (!props.rows.length) return <div className="empty">{props.empty ?? 'Nothing here yet.'}</div>;
  return (
    <div className="table-wrap">
      <table className="table">
        <thead><tr>{props.cols.map((c) => <th key={c.label} className={c.num ? 'num' : ''}>{c.label}</th>)}</tr></thead>
        <tbody>
          {props.rows.map((r, i) => (
            <tr key={i} className={props.onRow ? 'clickable' : ''} onClick={() => props.onRow?.(r)}>
              {props.cols.map((c) => <td key={c.label} className={c.num ? 'num' : ''}>{c.value(r)}</td>)}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** Download rows as a CSV file (opens in Excel). */
export function csvButton<T>(name: string, rows: T[] | null, cols: Col<T>[]) {
  return (
    <button type="button" className="btn" disabled={!rows?.length} onClick={() => {
      const esc = (v: unknown) => { const s = v === null || v === undefined ? '' : String(v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
      const text = [cols.map((c) => esc(c.label)).join(','),
        ...rows!.map((r) => cols.map((c) => esc(c.csv ? c.csv(r) : textOf(c.value(r)))).join(','))].join('\r\n');
      const url = URL.createObjectURL(new Blob(['﻿' + text], { type: 'text/csv;charset=utf-8' }));
      const a = document.createElement('a');
      a.href = url;
      a.download = `${name}.csv`;
      a.click();
      URL.revokeObjectURL(url);
    }}>Export to Excel</button>
  );
}
const textOf = (n: ReactNode): string => (typeof n === 'string' || typeof n === 'number' ? String(n) : '');

export function Modal(props: { title: string; children: ReactNode; onClose: () => void; wide?: boolean }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') props.onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
  return (
    <div className="modal-backdrop" role="dialog" aria-modal="true" onMouseDown={(e) => { if (e.target === e.currentTarget) props.onClose(); }}>
      <div className={`card${props.wide ? ' wide' : ''}`}>
        <div className="modal-head"><h2>{props.title}</h2><button type="button" className="icon-btn" onClick={props.onClose} aria-label="Close">×</button></div>
        {props.children}
      </div>
    </div>
  );
}

/** A form inside a pop-up: shows the error from the server and disables the button while saving. */
export function useSubmit(action: () => Promise<unknown>, onDone: () => void) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submit = async (e?: { preventDefault: () => void }) => {
    e?.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await action();
      onDone();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };
  return { busy, error, submit };
}

export function DateRange(props: { from: string; to: string; onChange: (from: string, to: string) => void }) {
  return (
    <div className="date-range">
      <label>From <input type="date" value={props.from} onChange={(e) => props.onChange(e.target.value, props.to)} /></label>
      <label>To <input type="date" value={props.to} onChange={(e) => props.onChange(props.from, e.target.value)} /></label>
    </div>
  );
}

export const money = (v: unknown) => rs(v === null || v === undefined ? null : Number(v));
export const dateOf = (v: unknown) => (v ? new Date(String(v)).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' }) : '—');
export const timeOf = (v: unknown) => (v ? new Date(String(v)).toLocaleString('en-GB', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }) : '—');
export const monthStart = (today: string) => `${today.slice(0, 8)}01`;
export const daysAgo = (today: string, n: number) => new Date(Date.parse(today) - n * 86_400_000).toISOString().slice(0, 10);
