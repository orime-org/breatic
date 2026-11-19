// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * inner#1953: a failure of the payer's own key keeps whose key it was, on the Agent's reply and on a Timeline
 * execution alike, so the sentence still names the right owner after the Studio changes hands.
 */

import { describe, expect, it } from 'vitest';
import { renderHook } from '@testing-library/react';
import { setLocale } from '@breatic/shared';

import { readKeyFailure } from '@web/data/api/key-failure';
import { useTranslation } from '@web/i18n/use-translation';
import { executionFailureSentence } from '@web/spaces/timeline/TimelineExecutionList';

const NEW_ADMIN = { payer: 'self', payerUserId: 'u-new', viewerUserId: 'u-new', upstreamNames: { openrouter: 'OpenRouter' } } as const;

describe('whose key a key failure was on', () => {
  it('reads the owner an Agent reply recorded, and drops one that is not text', () => {
    expect(readKeyFailure({ reason: 'account_key_failed', upstream: 'openrouter', keyReason: 'no_balance', keyOwner: 'u-old' })).toEqual({
      reason: 'account_key_failed',
      upstream: 'openrouter',
      keyReason: 'no_balance',
      keyOwner: 'u-old',
    });
    expect(readKeyFailure({ reason: 'account_key_missing', keyOwner: 7 })).toEqual({ reason: 'account_key_missing' });
  });

  it('tells the new admin a Timeline failure on the former admin\'s key was not their own', () => {
    setLocale('en');
    const t = renderHook(() => useTranslation()).result.current;
    const row = { failureReason: 'account_key_failed', failureUpstream: 'openrouter', failureKeyReason: 'no_balance', failureKeyOwner: 'u-old' } as const;
    expect(executionFailureSentence(row, t, NEW_ADMIN)).toBe('The OpenRouter key is out of balance. Top up at OpenRouter.');
    expect(executionFailureSentence({ ...row, failureKeyOwner: 'u-new' }, t, NEW_ADMIN)).toBe('Your OpenRouter key is out of balance. Top up at OpenRouter.');
  });
});
