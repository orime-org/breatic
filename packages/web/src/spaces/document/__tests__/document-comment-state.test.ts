// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * What one comment card is in (#18, design §9.2).
 *
 * A thread's state is two independent bits, and this is the one place they are
 * read together: `resolved`, which lives on the thread, and whether the body
 * still carries a range for it, which is derived from the marks and stored
 * nowhere.
 *
 * The mark's own `orphan` attribute cannot stand in for the second bit. The
 * library sets it from `!thread || thread.resolved || thread.deletedAt`
 * (`comments/extension.ts:138-142`), so a resolved thread's mark carries
 * `orphan: true` while its text is perfectly intact — the attribute answers
 * "should this be painted", not "is the text gone". The test below that pairs
 * `resolved` with a live position is the one that separates them.
 *
 * TDD: red because `commentCardState` does not exist yet.
 */

import { describe, it, expect } from 'vitest';

import { commentCardState } from '@web/spaces/document/document-comment-state';

/** A position table holding just the ids named. */
const positionsFor = (
  ...ids: readonly string[]
): ReadonlyMap<string, { from: number; to: number }> =>
  new Map(ids.map((id) => [id, { from: 1, to: 9 }]));

describe('commentCardState', () => {
  it('is open while the thread is unresolved and its text is there', () => {
    expect(commentCardState({ resolved: false }, 't1', positionsFor('t1'))).toBe(
      'open',
    );
  });

  it('is resolved, not orphaned, when a resolved thread still has its text', () => {
    expect(commentCardState({ resolved: true }, 't1', positionsFor('t1'))).toBe(
      'resolved',
    );
  });

  it('is orphaned once the text it pointed at is gone', () => {
    expect(commentCardState({ resolved: false }, 't1', positionsFor())).toBe(
      'orphaned',
    );
  });

  it('is both when a resolved thread also lost its text', () => {
    expect(commentCardState({ resolved: true }, 't1', positionsFor())).toBe(
      'resolvedOrphaned',
    );
  });

  it('reads a missing resolved flag as unresolved', () => {
    // The store leaves it off rather than writing false, so the two spellings
    // have to land in the same state.
    expect(commentCardState({}, 't1', positionsFor('t1'))).toBe('open');
  });
});
