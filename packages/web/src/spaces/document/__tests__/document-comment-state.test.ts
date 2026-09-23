// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Whether one comment has been settled (#18, design §9.2).
 *
 * The design names two bits. This is the one that lives on the thread; the
 * other — whether the body still carries the words — reaches a card as its
 * quote, off the same walk that produces the quote itself.
 *
 * The mark's own `orphan` attribute cannot stand in for either of them. The
 * library sets it from `!thread || thread.resolved || thread.deletedAt`
 * (`comments/extension.ts:138-142`), so a resolved thread's mark carries
 * `orphan: true` while its text is perfectly intact — the attribute answers
 * "should this be painted".
 */

import { describe, it, expect } from 'vitest';

import { isSettled } from '@web/spaces/document/document-comment-state';

describe('isSettled', () => {
  it('is false while nobody has resolved the thread', () => {
    expect(isSettled({ resolved: false })).toBe(false);
  });

  it('is true once somebody has', () => {
    expect(isSettled({ resolved: true })).toBe(true);
  });

  it('reads a missing flag as unresolved', () => {
    // The store leaves it off rather than writing false, so the two spellings
    // have to read the same.
    expect(isSettled({})).toBe(false);
  });
});
