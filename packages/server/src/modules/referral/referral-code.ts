// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

import { randomInt } from "node:crypto";

/** Characters of generated codes: digits and capitals without 0, 1, I and O, which read alike. */
export const REFERRAL_CODE_ALPHABET = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ";

const GENERATED_LENGTH = 8;
const FORMAT = /^[A-Z0-9][A-Z0-9-]{2,18}[A-Z0-9]$/;

/**
 * Whether a string is a referral code in its stored form.
 * @param code - Upper-case, already trimmed.
 * @returns True for 4–20 letters and digits with hyphens only inside.
 */
export function isValidReferralCode(code: string): boolean {
  return FORMAT.test(code);
}

/**
 * Turns what someone typed or carried in a link into a stored-form code.
 *
 * Codes are not case-sensitive, so every comparison and every insert goes
 * through this first.
 * @param input - Raw text.
 * @returns The code in upper case, or null when it is not a referral code.
 */
export function parseReferralCode(input: string): string | null {
  const code = input.trim().toUpperCase();
  return isValidReferralCode(code) ? code : null;
}

/**
 * Draws a new random code for an approved promoter who asked for none.
 * @returns Eight characters from {@link REFERRAL_CODE_ALPHABET}.
 */
export function generateReferralCode(): string {
  let code = "";
  for (let i = 0; i < GENERATED_LENGTH; i += 1) {
    code += REFERRAL_CODE_ALPHABET[randomInt(REFERRAL_CODE_ALPHABET.length)];
  }
  return code;
}
