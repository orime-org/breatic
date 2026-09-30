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
    // "Current" names WHICH ROW the node is on, not which rows happen to hold
    // the same thing (user 2026-09-20). A reader who restores a row gets that
    // row, and two rows holding identical words are two rows a reader is
    // allowed to keep — content alone cannot tell them apart.
    it('names the row the reader restored, not the newest one matching it', () => {
      const list = [
        entry({ id: 'newer', content: 'same words' }),
        entry({ id: 'older', content: 'same words' }),
      ];
      expect(currentEntryId(list, 'same words', 'older')).toBe('older');
    });

    // The node moved on: its content is no longer what that row holds, so the
    // row it came from stops being current and the content match takes over.
    it('drops a restored row once the node no longer holds what it held', () => {
      const list = [
        entry({ id: 'newer', content: 'b' }),
        entry({ id: 'older', content: 'a' }),
      ];
      expect(currentEntryId(list, 'b', 'older')).toBe('newer');
    });

    // A node nobody has restored on — every row arrived by a run or an
    // upload — still says which row it is on.
    it('falls back to the content match when no row was restored', () => {
      const list = [entry({ id: 'gen', content: 'x.png' })];
      expect(currentEntryId(list, 'x.png', null)).toBe('gen');
    });

    // Nobody restored on this node — the same picture was uploaded twice and
    // dedup gave both rows one URL. The newest is the one that landed, which
    // is as close as content gets. A reader who then picks either row is
    // answered by the row itself, above.
    it('takes the newest of two same-URL rows when no row was restored', () => {
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
