import { describe, expect, it } from 'vitest';
import { exportPublicKey, importPublicKey, signClaims, verifyClaims } from '../src/licence.ts';

describe('the pharmacy licence from MedFlow HQ', () => {
  it('verifies what HQ signed, and nothing else', async () => {
    const hq = await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify']) as CryptoKeyPair;
    const other = await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify']) as CryptoKeyPair;
    const pub = await importPublicKey(await exportPublicKey(hq.publicKey));
    const claims = { kind: 'pharmacy', status: 'active', may_sell: true, valid_until: '2030-01-01T00:00:00Z' };
    const token = await signClaims(claims, hq.privateKey);
    expect(await verifyClaims(token, pub)).toEqual(claims);
    // Someone edits the licence to look active forever: the signature no longer matches.
    const [body, sig] = token.split('.');
    const edited = btoa(JSON.stringify({ ...claims, valid_until: '2099-01-01T00:00:00Z' })).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    expect(await verifyClaims(`${edited}.${sig}`, pub)).toBeNull();
    // A licence signed by a fake HQ.
    expect(await verifyClaims(await signClaims(claims, other.privateKey), pub)).toBeNull();
    expect(await verifyClaims('garbage', pub)).toBeNull();
    expect(body).toBeTruthy();
  });
});
