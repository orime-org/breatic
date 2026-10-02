// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

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
    // A node's history holds each content once (#2186), so the row holding
    // what the node holds is the current one wherever it sits in the list —
    // an older row the reader restored included.
    it('names the older row once the node holds what that row holds', () => {
      const list = [
        entry({ id: 'newer', content: 'b' }),
        entry({ id: 'older', content: 'a' }),
      ];
      expect(currentEntryId(list, 'a')).toBe('older');
    });

    // Exactly one row is current; every other successful row stays a row the
    // reader can restore.
    it('marks exactly one of several successful rows', () => {
      const list = [
        entry({ id: 'c', content: 'third' }),
        entry({ id: 'b', content: 'second' }),
        entry({ id: 'f', status: 'failed', content: null }),
        entry({ id: 'a', content: 'first' }),
      ];
      const current = currentEntryId(list, 'second');
      expect(current).toBe('b');
      const restorable = list.filter((e) => isRestorable(e) && e.id !== current);
      expect(restorable.map((e) => e.id)).toEqual(['c', 'a']);
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
    it('returns a finite credit figure, including 0', () => {
      expect(entryCredits(entry({ metadata: { credits: 58 } }))).toBe(58);
      expect(entryCredits(entry({ metadata: { credits: 0 } }))).toBe(0);
    });
    // The chip is labelled in credits, and `cost` is what the service
    // charged us in dollars. Reading it here printed a figure a hundred
    // times too small beside a word that said credits.
    it('ignores the dollar figure the row also carries', () => {
      expect(entryCredits(entry({ metadata: { cost: 0.58 } }))).toBeUndefined();
    });
    it('undefined when absent or non-finite (no NaN chip)', () => {
      expect(entryCredits(entry({ metadata: {} }))).toBeUndefined();
      expect(
        entryCredits(entry({ metadata: { credits: Number.NaN } })),
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
