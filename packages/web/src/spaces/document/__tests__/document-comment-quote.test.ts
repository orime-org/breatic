// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { describe, it, expect } from 'vitest';

import { findQuote } from '@web/spaces/document/document-comment-quote';

describe('findQuote', () => {
  const any = (): boolean => true;

  it('puts first the copy whose surroundings match, over one nearer the old place', () => {
    const text = 'the cat sat. a dog ran. the cat ate.';
    expect(
      findQuote(text, { exact: 'cat', prefix: 'the ', suffix: ' ate.', start: 4 }, any),
    ).toEqual({ start: 28, end: 31 });
  });

  it('breaks a tie in surroundings by where the words were', () => {
    const text = 'x ab y x ab y x ab y';
    expect(
      findQuote(text, { exact: 'ab', prefix: 'x ', suffix: ' y', start: 14 }, any),
    ).toEqual({ start: 16, end: 18 });
  });

  it('finds words changed by a letter when no exact copy is left', () => {
    const text = 'alpha brave charlie';
    const found = findQuote(
      text,
      { exact: 'bravo', prefix: 'alpha ', suffix: ' charlie', start: 6 },
      any,
    );
    expect(text.slice(found!.start, found!.end)).toBe('brave');
  });

  it('finds nothing when the words are gone', () => {
    expect(
      findQuote('alpha charlie', { exact: 'bravo', prefix: '', suffix: '', start: 6 }, any),
    ).toBeNull();
  });

  it('offers the next closest runs once the closest are all turned down', () => {
    // The exact copy elsewhere is not the words; the corrected one is.
    const text = 'alpha brave charlie echo bravo';
    const found = findQuote(
      text,
      { exact: 'bravo', prefix: 'alpha ', suffix: ' charlie', start: 6 },
      (run) => run.start < 20,
    );
    expect(text.slice(found!.start, found!.end)).toBe('brave');
  });

  it('finds nothing once every close run is turned down', () => {
    expect(
      findQuote(
        'bravo brave',
        { exact: 'bravo', prefix: '', suffix: '', start: 0 },
        () => false,
      ),
    ).toBeNull();
  });
});
