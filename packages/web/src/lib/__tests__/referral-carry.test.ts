// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as ReferralCarry from '@web/lib/referral-carry';

const KEY = 'breatic.referralCode';

/**
 * Loads a fresh copy of the module, as a new page load does.
 * @returns The module.
 */
async function load(): Promise<typeof ReferralCarry> {
  vi.resetModules();
  return import('@web/lib/referral-carry');
}

beforeEach(() => {
  window.localStorage.clear();
});
afterEach(() => {
  window.localStorage.clear();
});

describe('the referral code a visitor carries (inner#1868 §11)', () => {
  it('reads ?ref= at start-up into memory only, upper-cased and trimmed', async () => {
    const carry = await load();
    carry.captureReferralFromUrl(new URL('https://app.example/register?ref=%20alice%20'));
    expect(carry.carriedReferralCode()).toBe('ALICE');
    expect(window.localStorage.getItem(KEY)).toBeNull();
  });

  it('ignores an address without a code, and a code too long to be one', async () => {
    const carry = await load();
    carry.captureReferralFromUrl(new URL('https://app.example/register'));
    expect(carry.carriedReferralCode()).toBeNull();
    carry.captureReferralFromUrl(new URL(`https://app.example/register?ref=${'A'.repeat(41)}`));
    expect(carry.carriedReferralCode()).toBeNull();
  });

  it('keeps the code across visits once cookies are accepted, and drops it when consent is withdrawn', async () => {
    const carry = await load();
    carry.captureReferralFromUrl(new URL('https://app.example/register?ref=alice'));
    carry.setReferralPersistence(true);
    expect(window.localStorage.getItem(KEY)).toBe('ALICE');
    carry.setReferralPersistence(false);
    expect(window.localStorage.getItem(KEY)).toBeNull();
    expect(carry.carriedReferralCode()).toBe('ALICE');
  });

  it('reads the kept code on a later visit, and a new link replaces it', async () => {
    window.localStorage.setItem(KEY, 'ALICE');
    const carry = await load();
    expect(carry.carriedReferralCode()).toBe('ALICE');
    carry.setReferralPersistence(true);
    carry.captureReferralFromUrl(new URL('https://app.example/register?ref=bob'));
    expect(carry.carriedReferralCode()).toBe('BOB');
    expect(window.localStorage.getItem(KEY)).toBe('BOB');
  });

  it('forgets the code everywhere once it is used, removed or refused', async () => {
    const carry = await load();
    carry.captureReferralFromUrl(new URL('https://app.example/register?ref=alice'));
    carry.setReferralPersistence(true);
    carry.forgetCarriedReferralCode();
    expect(carry.carriedReferralCode()).toBeNull();
    expect(window.localStorage.getItem(KEY)).toBeNull();
  });

  it('forgets the code when the server refused that very code, however it was typed', async () => {
    const carry = await load();
    carry.captureReferralFromUrl(new URL('https://app.example/register?ref=alice'));
    carry.setReferralPersistence(true);
    carry.forgetRefusedReferralCode(' alice ');
    expect(carry.carriedReferralCode()).toBeNull();
    expect(window.localStorage.getItem(KEY)).toBeNull();
  });

  it('keeps the code when the server refused other text the visitor typed', async () => {
    const carry = await load();
    carry.captureReferralFromUrl(new URL('https://app.example/register?ref=alice'));
    carry.setReferralPersistence(true);
    carry.forgetRefusedReferralCode('BOB');
    expect(carry.carriedReferralCode()).toBe('ALICE');
    expect(window.localStorage.getItem(KEY)).toBe('ALICE');
  });
});
