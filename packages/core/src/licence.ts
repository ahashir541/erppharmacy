// The counter's offline licence: claims from public.device_licence_claims, signed by MedFlow
// (Ed25519, in the device-licence Edge Function). The counter keeps the token and checks it with
// MedFlow's public key, so it knows offline whether it may keep selling, and until when.

export interface LicenceClaims {
  tenant_id: string;
  device_id: string;
  branch_id: string | null;
  may_sell: boolean;
  status: string;
  issued_at: string;
  valid_until: string;
  features: Record<string, { enabled: boolean; limit: number | null }>;
}

export type LicenceCheck =
  | { ok: true; claims: LicenceClaims; hoursLeft: number }
  | { ok: false; reason: 'bad_token' | 'bad_signature' | 'expired' | 'not_allowed' | 'wrong_device'; claims?: LicenceClaims };

const enc = new TextEncoder();
const b64url = (bytes: Uint8Array): string =>
  btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const fromB64url = (s: string): Uint8Array<ArrayBuffer> => {
  const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (s.length % 4)) % 4));
  const out = new Uint8Array(new ArrayBuffer(bin.length));
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
};

export async function signLicence(claims: LicenceClaims, privateKey: CryptoKey): Promise<string> {
  const body = b64url(enc.encode(JSON.stringify(claims)));
  const sig = new Uint8Array(await crypto.subtle.sign('Ed25519', privateKey, enc.encode(body)));
  return `${body}.${b64url(sig)}`;
}

export async function verifyLicence(token: string, publicKey: CryptoKey, deviceId: string, now: Date = new Date()): Promise<LicenceCheck> {
  const [body, sig] = token.split('.');
  if (!body || !sig) return { ok: false, reason: 'bad_token' };
  let valid = false;
  try {
    valid = await crypto.subtle.verify('Ed25519', publicKey, fromB64url(sig), enc.encode(body));
  } catch {
    return { ok: false, reason: 'bad_token' };
  }
  if (!valid) return { ok: false, reason: 'bad_signature' };
  const claims = JSON.parse(new TextDecoder().decode(fromB64url(body))) as LicenceClaims;
  if (claims.device_id !== deviceId) return { ok: false, reason: 'wrong_device', claims };
  if (!claims.may_sell) return { ok: false, reason: 'not_allowed', claims };
  const left = (Date.parse(claims.valid_until) - now.getTime()) / 3_600_000;
  if (left <= 0) return { ok: false, reason: 'expired', claims };
  return { ok: true, claims, hoursLeft: Math.floor(left) };
}

/** SHA-256 of the token, which is all the server keeps (device_licences.token_sha256). */
export async function licenceHash(token: string): Promise<string> {
  const d = new Uint8Array(await crypto.subtle.digest('SHA-256', enc.encode(token)));
  return Array.from(d, (b) => b.toString(16).padStart(2, '0')).join('');
}
