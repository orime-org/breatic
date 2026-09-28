// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { describe, it, expect } from 'vitest';

import { rankQuoteCandidates } from '@web/spaces/document/document-comment-quote';

describe('rankQuoteCandidates', () => {
  it('puts first the copy whose surroundings match, over one nearer the old place', () => {
    const text = 'the cat sat. a dog ran. the cat ate.';
    const ranked = rankQuoteCandidates(text, {
      exact: 'cat',
      prefix: 'the ',
      suffix: ' ate.',
      start: 4,
    });
    expect(ranked[0]).toEqual({ start: 28, end: 31 });
  });

  it('breaks a tie in surroundings by where the words were', () => {
    const text = 'x ab y x ab y x ab y';
    const ranked = rankQuoteCandidates(text, {
      exact: 'ab',
      prefix: 'x ',
      suffix: ' y',
      start: 14,
    });
    expect(ranked[0]).toEqual({ start: 16, end: 18 });
  });

  it('finds words changed by a letter when no exact copy is left', () => {
    const text = 'alpha brave charlie';
    const ranked = rankQuoteCandidates(text, {
      exact: 'bravo',
      prefix: 'alpha ',
      suffix: ' charlie',
      start: 6,
    });
    expect(text.slice(ranked[0]!.start, ranked[0]!.end)).toBe('brave');
  });

  it('finds nothing when the words are gone', () => {
    expect(
      rankQuoteCandidates('alpha charlie', {
        exact: 'bravo',
        prefix: '',
        suffix: '',
        start: 6,
      }),
    ).toEqual([]);
  });
});
