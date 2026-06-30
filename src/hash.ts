// Password hashing that matches Postiz exactly.
//
// Postiz hashes with `bcrypt.hashSync(pw, 10)` (libraries/helpers/src/auth/
// auth.service.ts) producing `$2b$10$...`. bcryptjs emits an identical digest
// but labels it `$2a$`; we relabel the prefix to `$2b$` so stored hashes are
// byte-for-byte the shape Postiz writes. For passwords < 256 bytes the $2a/$2b
// digest is identical, and Postiz's verifier accepts both regardless.
import bcrypt from 'bcryptjs';
import * as crypto from 'crypto';

export const BCRYPT_COST = 10;

export function hashPassword(plain: string): string {
  const h = bcrypt.hashSync(plain, BCRYPT_COST);
  return h.replace(/^\$2a\$/, '$2b$');
}

export function verifyPassword(plain: string, hash: string): boolean {
  return bcrypt.compareSync(plain, hash);
}

const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';

// Cryptographically-secure random alphanumeric password (no ambiguous chars).
export function generatePassword(length = 20): string {
  const out: string[] = [];
  // Rejection sampling to avoid modulo bias.
  const max = 256 - (256 % ALPHABET.length);
  while (out.length < length) {
    const bytes = crypto.randomBytes(length);
    for (let i = 0; i < bytes.length && out.length < length; i++) {
      if (bytes[i] < max) out.push(ALPHABET[bytes[i] % ALPHABET.length]);
    }
  }
  return out.join('');
}
