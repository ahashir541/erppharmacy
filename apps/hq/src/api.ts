// The console talks to MedFlow HQ (the same address it was opened from). Every admin call is a
// platform_* database function; the server checks the admin's sign-in, the database checks it too.
const TOKEN = 'medflow.hq.session';

export class HqError extends Error {
  constructor(message: string, readonly status = 0) { super(message); }
}

export const hqToken = () => { try { return sessionStorage.getItem(TOKEN); } catch { return null; } };
const setToken = (t: string | null) => { try { if (t) sessionStorage.setItem(TOKEN, t); else sessionStorage.removeItem(TOKEN); } catch { /* ignore */ } };

async function req<T>(path: string, body?: unknown, method = 'POST'): Promise<T> {
  let res: Response;
  try {
    const t = hqToken();
    res = await fetch(`/hq/${path}`, {
      method, headers: { 'Content-Type': 'application/json', ...(t ? { Authorization: `Bearer ${t}` } : {}) },
      body: method === 'GET' ? null : JSON.stringify(body ?? {}),
    });
  } catch {
    throw new HqError('Cannot reach MedFlow HQ');
  }
  const data = await res.json().catch(() => ({})) as { error?: string } & T;
  if (!res.ok) {
    if (res.status === 401) setToken(null);
    throw new HqError(data.error ?? `HQ error ${res.status}`, res.status);
  }
  return data;
}

export interface HqStatus { app: string; version: string; has_admin: boolean; this_pc: boolean; public_key: string }
export const hqStatus = () => req<HqStatus>('status', null, 'GET');
export const setupAdmin = (name: string, email: string, password: string) => req('admin/setup', { name, email, password });
export async function signIn(email: string, password: string) { setToken((await req<{ token: string }>('admin/login', { email, password })).token); }
export async function signOut() { await req('admin/logout').catch(() => {}); setToken(null); }

/** platform_<name>(...args) as the signed-in platform owner. */
export async function call<T = unknown>(name: string, ...args: unknown[]): Promise<T> {
  return (await req<{ r: T }>('admin/call', { fn: `platform_${name}`, args })).r;
}

export const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));
export const rs = (minor: unknown) => (minor === null || minor === undefined ? '—'
  : `Rs ${(Number(minor) / 100).toLocaleString('en-PK', { minimumFractionDigits: 0, maximumFractionDigits: 2 })}`);
export const toMinor = (text: string): number | null => {
  const v = Number(text.replace(/[, ]/g, ''));
  return Number.isFinite(v) && v >= 0 ? Math.round(v * 100) : null;
};

/** Uploads a MedFlow Local update package; HQ checks it, signs it and offers it on its channel. */
export async function uploadRelease(file: File, version: string, channel: string, notes: string) {
  const res = await fetch('/hq/admin/release', {
    method: 'POST', body: file,
    headers: { 'Content-Type': 'application/gzip', Authorization: `Bearer ${hqToken() ?? ''}`, 'X-MedFlow-Version': version,
               'X-MedFlow-Channel': channel, 'X-MedFlow-Notes': encodeURIComponent(notes) },
  });
  const data = await res.json().catch(() => ({})) as { error?: string; version?: string; size_bytes?: number };
  if (!res.ok) throw new HqError(data.error ?? `Upload failed (${res.status})`, res.status);
  return data;
}
