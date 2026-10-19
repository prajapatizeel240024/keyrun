// RFC 6238 TOTP (HMAC-SHA1, 30 s step, 6 digits), shared by the mock apps and the engine.
import { createHmac, randomBytes } from 'node:crypto';

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function base32Encode(buf: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(s: string): Buffer {
  const clean = s.replace(/=+$/, '').replace(/\s+/g, '').toUpperCase();
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    const idx = ALPHABET.indexOf(ch);
    if (idx < 0) throw new Error('invalid base32');
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

export function newTotpSecret(): string {
  return base32Encode(randomBytes(20));
}

export const TOTP_STEP_SECONDS = 30;

export function counterAt(ms: number = Date.now()): number {
  return Math.floor(ms / 1000 / TOTP_STEP_SECONDS);
}

export function hotp(secret: string, counter: number, digits = 6): string {
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(counter));
  const mac = createHmac('sha1', base32Decode(secret)).update(msg).digest();
  const offset = mac[mac.length - 1] & 0x0f;
  const code = (mac.readUInt32BE(offset) & 0x7fffffff) % 10 ** digits;
  return code.toString().padStart(digits, '0');
}

export function totp(secret: string, ms: number = Date.now()): string {
  return hotp(secret, counterAt(ms));
}

/**
 * Server-side check, the way real apps do it: accept the previous, current and next step,
 * but never a step at or below the last one accepted (replay protection).
 * Returns the matched counter, or null.
 */
export function verifyTotp(secret: string, code: string, lastUsedCounter: number, ms: number = Date.now()): number | null {
  const now = counterAt(ms);
  for (const c of [now - 1, now, now + 1]) {
    if (c <= lastUsedCounter) continue;
    if (hotp(secret, c) === code) return c;
  }
  return null;
}
