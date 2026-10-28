// UUIDv7 (RFC 9562): 48-bit Unix milliseconds, then random bits. Generated
// on the device so records created offline never clash, and sort by time.
export function uuidv7(now: number = Date.now()): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  let ms = BigInt(now);
  for (let i = 5; i >= 0; i--) {
    bytes[i] = Number(ms & 0xffn);
    ms >>= 8n;
  }
  bytes[6] = (bytes[6]! & 0x0f) | 0x70; // version 7
  bytes[8] = (bytes[8]! & 0x3f) | 0x80; // RFC 4122 variant
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function uuidv7Timestamp(id: string): number {
  return Number.parseInt(id.replaceAll('-', '').slice(0, 12), 16);
}
