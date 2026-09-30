// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { describe, expect, it } from 'vitest';
import { TASK_FAILURE_REASONS } from '@breatic/shared';

import { LOCALE_CATALOGS, readPath } from '@web/test-utils/locale-catalogs';

// The sentence a task row shows for a failure it can name. The code is stored
// and the sentence is made where the reader is, so every code needs a line in
// all five catalogs — miss English and the reader gets the bare identifier,
// miss one of the other four and that language shows an English sentence.
//
// Neither is caught by anything else: `i18n-no-missing-keys` only sees keys
// written as a whole literal argument to `t()`, and these are built as
// `t(\`canvas.task.failure.${reason}\`)`.
//
// Walked off the list rather than copied beside it. A copy is a list that
// drifts, and the day it drifts is the day someone adds a code without
// adding the five sentences that make it readable.
const FAILURE_KEYS = TASK_FAILURE_REASONS.map(
  (reason) => `canvas.task.failure.${reason}`,
);

describe('every failure cause has a sentence in all five locales', () => {
  it('has causes to check', () => {
    // The walk above is only an assertion if the list has entries. A lower
    // bound says there is something to test without pinning the count —
    // pinning it would turn every added cause into a red line here, which is
    // not what this guards.
    expect(FAILURE_KEYS.length).toBeGreaterThanOrEqual(9);
  });

  describe.each(FAILURE_KEYS)('%s', (key) => {
    it.each(LOCALE_CATALOGS)('%s has a non-empty sentence', (_tag, catalog) => {
      const sentence = readPath(catalog, key);
      expect(typeof sentence).toBe('string');
      expect((sentence as string).trim()).not.toBe('');
    });

    it('is actually translated in the four non-English catalogs', () => {
      const english = readPath(LOCALE_CATALOGS[0][1], key);
      for (const [tag, catalog] of LOCALE_CATALOGS.slice(1)) {
        expect(readPath(catalog, key), tag).not.toBe(english);
      }
    });
  });
});
