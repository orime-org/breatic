// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import { describe, it, expect } from 'vitest';

import type { NodeHistoryEntry } from '@web/data/api/canvas';
import {
  currentEntryId,
  entryCredits,
  entryFilename,
  entryModel,
  isRestorable,
} from '@web/spaces/canvas/history/history-format';

/**
 * Builds a history-entry fixture.
 * @param over - Field overrides merged onto a successful-generation default.
 * @returns A {@link NodeHistoryEntry}.
 */
function entry(over: Partial<NodeHistoryEntry> = {}): NodeHistoryEntry {
  return {
    id: 'h-1',
    operatorName: null,
    entryType: 'generation',
    status: 'success',
    content: 'a.png',
    thumbnailUrl: null,
    errorMessage: null,
    metadata: {},
    createdAt: '2026-07-21T00:00:00.000Z',
    ...over,
  };
}

describe('history-format (#1619 pure derivations)', () => {
  describe('isRestorable', () => {
    it('true for a successful entry with content', () => {
      expect(isRestorable(entry())).toBe(true);
    });
    it('false for a failed entry', () => {
      expect(isRestorable(entry({ status: 'failed', content: null }))).toBe(
        false,
      );
    });
    it('false for a success entry with null content', () => {
      expect(isRestorable(entry({ content: null }))).toBe(false);
    });
  });

  describe('currentEntryId', () => {
    it('returns the first (newest) matching entry id', () => {
      const list = [
        entry({ id: 'new', content: 'x.png' }),
        entry({ id: 'old', content: 'y.png' }),
      ];
      expect(currentEntryId(list, 'x.png')).toBe('new');
    });
    it('returns null when nothing matches', () => {
      expect(currentEntryId([entry({ content: 'x.png' })], 'z.png')).toBeNull();
    });
    it('returns null when currentContent is null (failed-only node never mis-marks a failed row)', () => {
      const list = [entry({ id: 'f', status: 'failed', content: null })];
      expect(currentEntryId(list, null)).toBeNull();
    });
    it('dedup-safe: marks only the newest of two same-URL rows', () => {
      const list = [
        entry({ id: 'newer', content: 'dup.png' }),
        entry({ id: 'older', content: 'dup.png' }),
      ];
      expect(currentEntryId(list, 'dup.png')).toBe('newer');
    });
  });

  describe('entryModel', () => {
    it('returns the model string', () => {
      expect(entryModel(entry({ metadata: { model: 'Nano Banana' } }))).toBe(
        'Nano Banana',
      );
    });
    it('undefined when absent or empty', () => {
      expect(entryModel(entry({ metadata: {} }))).toBeUndefined();
      expect(entryModel(entry({ metadata: { model: '' } }))).toBeUndefined();
    });
  });

  describe('entryCredits', () => {
    it('returns a finite cost, including 0', () => {
      expect(entryCredits(entry({ metadata: { cost: 58 } }))).toBe(58);
      expect(entryCredits(entry({ metadata: { cost: 0 } }))).toBe(0);
    });
    it('undefined when absent or non-finite (no NaN chip)', () => {
      expect(entryCredits(entry({ metadata: {} }))).toBeUndefined();
      expect(
        entryCredits(entry({ metadata: { cost: Number.NaN } })),
      ).toBeUndefined();
    });
  });

  describe('entryFilename', () => {
    it('returns the filename', () => {
      expect(
        entryFilename(entry({ metadata: { filename: 'cover.png' } })),
      ).toBe('cover.png');
    });
    it('undefined when absent', () => {
      expect(entryFilename(entry({ metadata: {} }))).toBeUndefined();
    });
  });
});
