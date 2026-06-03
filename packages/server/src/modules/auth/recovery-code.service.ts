// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * Recovery code service (PR-a task 5).
 *
 * GitHub-style single-use backup codes for password reset without
 * relying on an SMTP backend (self-host friendly). One code per user,
 * displayed once at registration; consumed on use and replaced with
 * a fresh code that the user must re-save.
 *
 * Format: `XXXX-XXXX-XXXX-XXXX` — 16 RFC 4648 base32 characters
 * (alphabet A-Z + 2-7, no padding), grouped 4 + 4 + 4 + 4 with hyphens.
 * 16 chars × 5 bits/char ≈ 80 bits of entropy per code (similar
 * strength to a v4 UUID's 122 bits, more than enough for a single-use
 * recovery secret rotated on every consumption).
 *
 * Storage: bcrypt cost 12 (matches the rest of the auth surface) on
 * `users.recovery_code_hash`; `users.recovery_code_used_at` flips
 * non-null on consumption so the same code can't be replayed.
 */

import crypto from "node:crypto";
import bcrypt from "bcryptjs";

/** RFC 4648 base32 alphabet (uppercase only, no padding). */
const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

/**
 * bcrypt cost factor — matches `BCRYPT_ROUNDS` in `auth.service.ts`.
 * Keep these aligned; the invariant test `bcrypt-cost` enforces 12.
 */
const BCRYPT_COST = 12;

/**
 * Generate a fresh recovery code in `XXXX-XXXX-XXXX-XXXX` format.
 *
 * Uses `crypto.randomInt(0, 32)` per character — unbiased selection
 * from the 32-char alphabet. 16 characters → ~80 bits of entropy.
 * @returns A fresh plaintext recovery code in `XXXX-XXXX-XXXX-XXXX` format
 */
export function generateRecoveryCode(): string {
  let s = "";
  for (let i = 0; i < 16; i++) {
    s += ALPHABET[crypto.randomInt(0, 32)];
  }
  return `${s.slice(0, 4)}-${s.slice(4, 8)}-${s.slice(8, 12)}-${s.slice(12, 16)}`;
}

/**
 * Hash a recovery code for storage. Bcrypt cost 12.
 *
 * Use the returned string as `users.recovery_code_hash`. Never store
 * the plaintext code server-side — it is shown to the user exactly
 * once after generation.
 * @param code - Plaintext recovery code to hash
 * @returns The bcrypt hash to persist as `users.recovery_code_hash`
 */
export async function hashRecoveryCode(code: string): Promise<string> {
  return bcrypt.hash(code, BCRYPT_COST);
}

/**
 * Verify a plaintext code against a stored bcrypt hash.
 * @param code - Plaintext recovery code supplied by the user
 * @param hash - Stored bcrypt hash from `users.recovery_code_hash`
 * @returns `true` when `code` matches `hash`, `false` otherwise.
 *   Case-sensitive and format-strict (verification compares the
 *   exact bytes — `xxxx-xxxx...` lowercase or `XXXXXXXXXXXXXXXX`
 *   without hyphens will both fail).
 */
export async function verifyRecoveryCode(
  code: string,
  hash: string,
): Promise<boolean> {
  return bcrypt.compare(code, hash);
}
