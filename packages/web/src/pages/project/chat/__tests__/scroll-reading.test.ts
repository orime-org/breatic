// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { describe, it, expect } from 'vitest';

import { AT_END_EPSILON_PX, readScroll } from '@web/pages/project/chat/scroll-reading';

const END = 2000;

const reading = (over: Partial<Parameters<typeof readScroll>[0]>): Parameters<typeof readScroll>[0] => ({
  top: END,
  lastTop: END,
  end: END,
  written: undefined,
  ...over,
});

it('keeps the tolerance at the one pixel the question needs', () => {
  // Everything else here asks about the tolerance by name, so the number
  // itself needs saying once. It answers "is the column flush with the end",
  // and the only reason it is not zero is that scrollTop is fractional while
  // the two heights are whole. A larger one would start answering "is the
  // reader near enough that we may finish the trip for them", which is the
  // question this design took out.
  expect(AT_END_EPSILON_PX).toBe(1);
});

describe('readScroll', () => {
  describe('what we wrote ourselves', () => {
    it('hears its own write back and says nothing', () => {
      expect(readScroll(reading({ top: 1500, lastTop: END, written: 1500 }))).toBeNull();
    });

    it('allows the epsilon between what it asked for and what it got', () => {
      // scrollTop is fractional while scrollHeight and clientHeight are whole,
      // so a write of the end comes back off by a fraction of a pixel.
      expect(readScroll(reading({ top: 1500 - AT_END_EPSILON_PX, lastTop: END, written: 1500 }))).toBeNull();
    });

    it('hears a reader who moved in the same frame we wrote', () => {
      // Measured mid-turn (probe reading 8): the column was written to 5220 and
      // the single scroll event for that frame reported 5000, the wheel having
      // landed after the write.
      expect(readScroll({ top: 5000, lastTop: 5180, end: 5260, written: 5220 })).toBe('readerMovedUp');
    });

    it('hears its own write back when content was lost and regained in one frame', () => {
      // Probe reading 7: the browser clamped to 1800 and the next chunk then
      // put the end at 1900, all before the one scroll event was dispatched.
      // The follow write runs in the resize callback, after the clamp, so the
      // value the event carries is ours.
      expect(readScroll({ top: 1900, lastTop: 2100, end: 1900, written: 1900 })).toBeNull();
    });
  });

  describe('what the browser did on its own', () => {
    it('says nothing about a clamp, which lands the column on the end', () => {
      // Probe readings 3, 9 and 10: losing content or gaining viewport carries
      // a column that no longer fits onto the end exactly. Nothing a reader
      // does comes to rest there while moving up.
      expect(readScroll({ top: END, lastTop: 2060, end: END, written: undefined })).toBeNull();
    });

    it('takes a reader who came up to rest just short of the end', () => {
      expect(readScroll({ top: END - 2, lastTop: 2060, end: END, written: undefined })).toBe('readerMovedUp');
    });
  });

  describe('what the reader did', () => {
    it('reads a move up', () => {
      expect(readScroll(reading({ top: 1200, lastTop: END }))).toBe('readerMovedUp');
    });

    it('reads a move down that stops short of the end', () => {
      expect(readScroll(reading({ top: 1500, lastTop: 1200 }))).toBe('readerMovedDownShort');
    });

    it('reads a move down that reaches the end', () => {
      expect(readScroll(reading({ top: END, lastTop: 1200 }))).toBe('readerMovedDownToEnd');
    });

    it('counts the epsilon as having reached the end', () => {
      expect(readScroll(reading({ top: END - AT_END_EPSILON_PX, lastTop: 1200 }))).toBe('readerMovedDownToEnd');
    });

    it('counts one pixel past the epsilon as short of it', () => {
      expect(readScroll(reading({ top: END - AT_END_EPSILON_PX - 1, lastTop: 1200 }))).toBe(
        'readerMovedDownShort',
      );
    });

    it('says nothing about a scroll that moved nothing', () => {
      expect(readScroll(reading({ top: 1500, lastTop: 1500 }))).toBeNull();
    });
  });
});
