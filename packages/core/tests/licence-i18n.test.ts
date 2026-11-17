import { describe, expect, it } from 'vitest';
import { direction, MESSAGES, t } from '../src/i18n.ts';
import { licenceHash, signLicence, verifyLicence, type LicenceClaims } from '../src/licence.ts';

const claims = (over: Partial<LicenceClaims> = {}): LicenceClaims => ({
  tenant_id: 't1', device_id: 'd1', branch_id: 'b1', may_sell: true, status: 'active',
  issued_at: '2026-11-17T10:00:00Z', valid_until: '2026-11-24T10:00:00Z', features: {}, ...over,
});

describe('offline licence', async () => {
  const keys = (await crypto.subtle.generateKey('Ed25519', false, ['sign', 'verify'])) as CryptoKeyPair;
  const other = (await crypto.subtle.generateKey('Ed25519', false, ['sign', 'verify'])) as CryptoKeyPair;
  const now = new Date('2026-11-20T10:00:00Z');

  it('a signed licence lets the counter sell until it runs out', async () => {
    const token = await signLicence(claims(), keys.privateKey);
    expect(await verifyLicence(token, keys.publicKey, 'd1', now)).toMatchObject({ ok: true, hoursLeft: 96 });
    expect(await verifyLicence(token, keys.publicKey, 'd1', new Date('2026-11-25T00:00:00Z'))).toMatchObject({ ok: false, reason: 'expired' });
  });

  it('refuses a token that was changed, signed by someone else, or for another PC', async () => {
    const token = await signLicence(claims(), keys.privateKey);
    const [body, sig] = token.split('.');
    const forged = btoa(JSON.stringify(claims({ valid_until: '2099-01-01T00:00:00Z' }))).replace(/=+$/, '');
    expect(await verifyLicence(`${forged}.${sig}`, keys.publicKey, 'd1', now)).toMatchObject({ ok: false, reason: 'bad_signature' });
    expect(await verifyLicence(await signLicence(claims(), other.privateKey), keys.publicKey, 'd1', now)).toMatchObject({ ok: false, reason: 'bad_signature' });
    expect(await verifyLicence(token, keys.publicKey, 'd2', now)).toMatchObject({ ok: false, reason: 'wrong_device' });
    expect(await verifyLicence(`${body}`, keys.publicKey, 'd1', now)).toMatchObject({ ok: false, reason: 'bad_token' });
  });

  it('a read-only pharmacy cannot sell offline either', async () => {
    const token = await signLicence(claims({ may_sell: false, status: 'read_only' }), keys.privateKey);
    expect(await verifyLicence(token, keys.publicKey, 'd1', now)).toMatchObject({ ok: false, reason: 'not_allowed' });
  });

  it('keeps only a hash on the server', async () => {
    expect(await licenceHash('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  });
});

describe('English and Urdu', () => {
  it('every message exists in both languages', () => {
    for (const key of Object.keys(MESSAGES.en)) {
      expect(MESSAGES.ur[key as keyof typeof MESSAGES.en], key).toBeTruthy();
    }
    expect(Object.keys(MESSAGES.ur).sort()).toEqual(Object.keys(MESSAGES.en).sort());
  });

  it('placeholders match in both languages', () => {
    for (const [key, text] of Object.entries(MESSAGES.en)) {
      const vars = (s: string) => (s.match(/\{\w+\}/g) ?? []).sort();
      expect(vars(MESSAGES.ur[key as keyof typeof MESSAGES.en]), key).toEqual(vars(text));
    }
  });

  it('fills in values and knows Urdu is right to left', () => {
    expect(t('sync.offline', 'en', { n: 12 })).toBe('Offline · 12 waiting');
    expect(t('sync.offline', 'ur', { n: 12 })).toContain('12');
    expect(direction('ur')).toBe('rtl');
    expect(direction('en')).toBe('ltr');
  });
});
