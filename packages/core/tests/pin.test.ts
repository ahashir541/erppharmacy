import { describe, expect, it } from 'vitest';
import { afterPinFailure, afterPinSuccess, checkPin, hashPin, isPinLocked, verifyPin } from '../src/pin.ts';

// The database only accepts this exact format (public.set_staff_pin).
const SERVER_FORMAT = /^pbkdf2-sha256\$[0-9]{6,7}\$[A-Za-z0-9+/]+=*\$[A-Za-z0-9+/]+=*$/;

describe('PIN rules', () => {
  it('accepts 4 to 6 digits', () => {
    expect(checkPin('2580')).toEqual({ ok: true });
    expect(checkPin('480271')).toEqual({ ok: true });
  });

  it('rejects wrong length or non-digits', () => {
    for (const pin of ['123', '1234567', '12a4', ' 1234', '']) {
      expect(checkPin(pin)).toEqual({ ok: false, problem: 'format' });
    }
  });

  it('rejects PINs anyone would guess', () => {
    for (const pin of ['0000', '1111', '1234', '123456', '4321', '987654']) {
      expect(checkPin(pin)).toEqual({ ok: false, problem: 'too_simple' });
    }
  });
});

describe('PIN hashing', () => {
  it('produces the format the server accepts, and verifies', async () => {
    const stored = await hashPin('2580');
    expect(stored).toMatch(SERVER_FORMAT);
    expect(stored.split('$')[1]).toBe('600000');
    await expect(verifyPin('2580', stored)).resolves.toBe(true);
    await expect(verifyPin('2581', stored)).resolves.toBe(false);
  });

  it('uses a fresh salt each time', async () => {
    const a = await hashPin('2580', { iterations: 1000 });
    const b = await hashPin('2580', { iterations: 1000 });
    expect(a).not.toBe(b);
  });

  it('refuses to hash a weak PIN', async () => {
    await expect(hashPin('1234')).rejects.toThrow(/too_simple/);
  });

  it('treats malformed stored values as a wrong PIN', async () => {
    await expect(verifyPin('2580', 'plain-text-pin')).resolves.toBe(false);
    await expect(verifyPin('2580', 'pbkdf2-sha256$0$AA==$AA==')).resolves.toBe(false);
  });
});

describe('PIN lockout (5 tries, 15 minutes)', () => {
  const now = new Date('2026-10-28T10:00:00Z');

  it('locks after the fifth wrong PIN', () => {
    let state = afterPinSuccess();
    for (let i = 0; i < 4; i++) state = afterPinFailure(state, now);
    expect(isPinLocked(state, now)).toBe(false);
    state = afterPinFailure(state, now);
    expect(isPinLocked(state, now)).toBe(true);
    expect(state.lockedUntil?.toISOString()).toBe('2026-10-28T10:15:00.000Z');
  });

  it('unlocks after the lock time', () => {
    const state = { failedAttempts: 5, lockedUntil: new Date('2026-10-28T10:15:00Z') };
    expect(isPinLocked(state, new Date('2026-10-28T10:14:59Z'))).toBe(true);
    expect(isPinLocked(state, new Date('2026-10-28T10:15:00Z'))).toBe(false);
  });
});
