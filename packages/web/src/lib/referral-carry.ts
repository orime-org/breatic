// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * The referral code a visitor carries in from a share link (inner#1868 §11).
 *
 * Read from `?ref=` at start-up, before the router rewrites the address, and
 * held in memory. Only once the visitor accepts analytics or ad cookies is it
 * also kept in localStorage, so it survives to a later visit; withdrawing
 * consent drops the stored copy.
 */

import { STORAGE_KEYS } from '@web/lib/storage-keys';

const STORAGE_KEY = STORAGE_KEYS.referralCode;
const MAX_LENGTH = 40;

let memory: string | null = null;
let persist = false;

/**
 * Normalises a code the way the server compares codes.
 * @param raw - Text from the address or storage.
 * @returns The code upper-cased and trimmed, or null when empty or too long.
 */
function normalise(raw: string | null): string | null {
  const code = raw?.trim().toUpperCase() ?? '';
  return code === '' || code.length > MAX_LENGTH ? null : code;
}

/**
 * Reads the stored copy, if the browser lets us.
 * @returns The stored code, or null.
 */
function stored(): string | null {
  try {
    return normalise(window.localStorage.getItem(STORAGE_KEY));
  } catch {
    // Storage blocked by the browser: the code lives in memory only.
    return null;
  }
}

/**
 * Writes or removes the stored copy, if the browser lets us.
 * @param code - The code to keep, or null to remove it.
 */
function store(code: string | null): void {
  try {
    if (code === null) window.localStorage.removeItem(STORAGE_KEY);
    else window.localStorage.setItem(STORAGE_KEY, code);
  } catch {
    // Storage blocked by the browser: nothing is kept across visits.
  }
}

/**
 * Takes the code from the landing address; call once at start-up.
 * @param url - The address the page loaded on.
 */
export function captureReferralFromUrl(url: URL): void {
  const code = normalise(url.searchParams.get('ref'));
  if (code === null) return;
  memory = code;
  if (persist) store(code);
}

/**
 * Follows the visitor's cookie consent: kept across visits only while accepted.
 * @param allowed - Analytics or ad cookies are accepted.
 */
export function setReferralPersistence(allowed: boolean): void {
  persist = allowed;
  if (allowed) {
    if (memory !== null) store(memory);
  } else {
    store(null);
  }
}

/**
 * The code to pre-fill: this visit's first, then one kept from an earlier visit.
 * @returns The code, or null.
 */
export function carriedReferralCode(): string | null {
  return memory ?? stored();
}

/** Forgets the code everywhere: it was used, removed by the visitor, or refused by the server. */
export function forgetCarriedReferralCode(): void {
  memory = null;
  store(null);
}
