// Staff PINs (D11, D25). The PIN is hashed on the device that typed it with
// PBKDF2-SHA256 (WebCrypto: works in browsers, Node, Deno and the Tauri
// webview). The counter verifies PINs offline against synced hashes.
// Stored format: pbkdf2-sha256$<iterations>$<base64 salt>$<base64 hash>

export const PIN_ITERATIONS = 600_000;
const SALT_BYTES = 16;
const HASH_BITS = 256;

export type PinProblem = 'format' | 'too_simple';

/** 4 to 6 digits; not all the same digit; not a straight run like 1234 or 9876. */
export function checkPin(pin: string): { ok: true } | { ok: false; problem: PinProblem } {
  if (!/^\d{4,6}$/.test(pin)) return { ok: false, problem: 'format' };
  const d = [...pin].map(Number);
  const allSame = d.every((x) => x === d[0]);
  const ascending = d.every((x, i) => i === 0 || x === d[i - 1]! + 1);
  const descending = d.every((x, i) => i === 0 || x === d[i - 1]! - 1);
  if (allSame || ascending || descending) return { ok: false, problem: 'too_simple' };
  return { ok: true };
}

export async function hashPin(
  pin: string,
  opts: { iterations?: number; salt?: Uint8Array } = {},
): Promise<string> {
  const check = checkPin(pin);
  if (!check.ok) throw new RangeError(`PIN rejected: ${check.problem}`);
  const iterations = opts.iterations ?? PIN_ITERATIONS;
  const salt = opts.salt ?? crypto.getRandomValues(new Uint8Array(SALT_BYTES));
  const hash = await derive(pin, salt, iterations);
  return `pbkdf2-sha256$${iterations}$${toBase64(salt)}$${toBase64(hash)}`;
}

export async function verifyPin(pin: string, stored: string): Promise<boolean> {
  const parts = stored.split('$');
  if (parts.length !== 4 || parts[0] !== 'pbkdf2-sha256') return false;
  const iterations = Number(parts[1]);
  if (!Number.isSafeInteger(iterations) || iterations < 1) return false;
  const salt = fromBase64(parts[2]!);
  const expected = fromBase64(parts[3]!);
  const actual = await derive(pin, salt, iterations);
  return constantTimeEqual(actual, expected);
}

export interface PinLockPolicy {
  maxAttempts: number;   // setting security.pin_max_attempts (default 5)
  lockMinutes: number;   // setting security.pin_lock_minutes (default 15)
}

export interface PinLockState {
  failedAttempts: number;
  lockedUntil: Date | null;
}

export const DEFAULT_PIN_POLICY: PinLockPolicy = { maxAttempts: 5, lockMinutes: 15 };

export function isPinLocked(state: PinLockState, now: Date): boolean {
  return state.lockedUntil !== null && state.lockedUntil.getTime() > now.getTime();
}

/** Same rule as public.record_pin_failure on the server. */
export function afterPinFailure(state: PinLockState, now: Date, policy = DEFAULT_PIN_POLICY): PinLockState {
  const failedAttempts = state.failedAttempts + 1;
  const lockedUntil =
    failedAttempts >= policy.maxAttempts ? new Date(now.getTime() + policy.lockMinutes * 60_000) : state.lockedUntil;
  return { failedAttempts, lockedUntil };
}

export function afterPinSuccess(): PinLockState {
  return { failedAttempts: 0, lockedUntil: null };
}

async function derive(pin: string, salt: Uint8Array, iterations: number): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(pin), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', hash: 'SHA-256', salt: salt as BufferSource, iterations },
    key,
    HASH_BITS,
  );
  return new Uint8Array(bits);
}

function constantTimeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i]! ^ b[i]!;
  return diff === 0;
}

function toBase64(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

function fromBase64(text: string): Uint8Array {
  const s = atob(text);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}
