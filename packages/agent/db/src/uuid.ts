/**
 * UUIDv7: 48-bit Unix ms timestamp (big-endian) + version 7 + random bits (RFC 9562).
 * Uses division instead of bitwise shifts since Date.now() exceeds 32-bit range.
 */
export function generateUUIDv7(): string {
  const ts = Date.now();
  const rnd = new Uint8Array(10);
  crypto.getRandomValues(rnd);

  const bytes = new Uint8Array(16);
  bytes[0] = Math.floor(ts / 2 ** 40) & 0xff;
  bytes[1] = Math.floor(ts / 2 ** 32) & 0xff;
  bytes[2] = Math.floor(ts / 2 ** 24) & 0xff;
  bytes[3] = Math.floor(ts / 2 ** 16) & 0xff;
  bytes[4] = Math.floor(ts / 2 ** 8) & 0xff;
  bytes[5] = ts & 0xff;

  bytes[6] = 0x70 | (rnd[0]! & 0x0f);
  bytes[7] = rnd[1]!;
  bytes[8] = 0x80 | (rnd[2]! & 0x3f);
  bytes[9] = rnd[3]!;
  bytes[10] = rnd[4]!;
  bytes[11] = rnd[5]!;
  bytes[12] = rnd[6]!;
  bytes[13] = rnd[7]!;
  bytes[14] = rnd[8]!;
  bytes[15] = rnd[9]!;

  const hex = [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
