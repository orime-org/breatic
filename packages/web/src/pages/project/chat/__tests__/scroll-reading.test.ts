// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { describe, it, expect } from 'vitest';

import {
  AT_END_EPSILON_PX,
  OWN_WRITE_EPSILON_PX,
  readScroll,
} from '@web/pages/project/chat/scroll-reading';

const END = 2000;

const reading = (over: Partial<Parameters<typeof readScroll>[0]>): Parameters<typeof readScroll>[0] => ({
  top: END,
  lastTop: END,
  end: END,
  lastEnd: END,
  written: undefined,
  ...over,
});

// Everything else here asks about the tolerances by name, so the numbers
// themselves need saying once. The two answer different questions and so take
// different values; a single shared one cannot serve both.
describe('the two tolerances', () => {
  it('gives the end the room a column under browser zoom needs', () => {
    // "Is the column flush with its end." The sweep behind this number lives
    // in scroll-reading.ts, next to the constant. A reader who scrolls back
    // down to the end has to be recognised as having done so, or the column
    // stays theirs forever and the way back never goes away.
    expect(AT_END_EPSILON_PX).toBe(4);
  });

  it('keeps the write tolerance at the fraction of a pixel it exists for', () => {
    // "Was this position ours." Only the fraction a write comes back off by,
    // and it has to stay well under the smallest move a reader can make: a
    // two-pixel turn of the wheel, measured on a real turn, has to read as the
    // reader rather than as our own write coming home.
    expect(OWN_WRITE_EPSILON_PX).toBe(1);
  });
});

describe('readScroll', () => {
  describe('what we wrote ourselves', () => {
    it('hears its own write back and says nothing', () => {
      expect(readScroll(reading({ top: 1500, lastTop: END, written: 1500 }))).toBeNull();
    });

    it('allows the epsilon between what it asked for and what it got', () => {
      // scrollTop is fractional while scrollHeight and clientHeight are whole,
      // so a write of the end comes back off by a fraction of a pixel.
      expect(
        readScroll(reading({ top: 1500 - OWN_WRITE_EPSILON_PX, lastTop: END, written: 1500 })),
      ).toBeNull();
    });

    it('hears a reader whose nudge is smaller than the room the end gets', () => {
      // The end's tolerance is several pixels wide, and a wheel's smallest
      // nudge fits inside it. Reading a position by that tolerance would take
      // this reader's three pixels for our own write coming home and leave the
      // column following while they meant to stop it.
      //
      expect(readScroll(reading({ top: 1497, lastTop: 1500, written: 1500 }))).toBe('readerMovedUp');
    });

    it('hears a reader who moved in the same frame we wrote', () => {
      // Measured mid-turn (probe reading 8): the column was written to 5220 and
      // the single scroll event for that frame reported 5000, the wheel having
      // landed after the write.
      expect(
        readScroll({ top: 5000, lastTop: 5180, end: 5260, lastEnd: 5220, written: 5220 }),
      ).toBe('readerMovedUp');
    });

    it('says nothing about probe reading 7, where a clamp came to rest far from the end', () => {
      // Measured: at the end, 300px is lost, the browser clamps to 1800, and
      // the next chunk puts the end at 1900 -- all before the single scroll
      // event for that frame. The column did not come to rest on the end, so
      // only the net shrink of the end identifies this as the browser's doing.
      expect(
        readScroll({ top: 1800, lastTop: 2100, end: 1900, lastEnd: 2100, written: undefined }),
      ).toBeNull();
    });

    it('hears its own write back when content was lost and regained in one frame', () => {
      // Probe reading 7: the browser clamped to 1800 and the next chunk then
      // put the end at 1900, all before the one scroll event was dispatched.
      // The follow write runs in the resize callback, after the clamp, so the
      // value the event carries is ours.
      expect(
        readScroll({ top: 1900, lastTop: 2100, end: 1900, lastEnd: 2100, written: 1900 }),
      ).toBeNull();
    });
  });

  describe('what the browser did on its own', () => {
    it('says nothing when the end moved up to meet the column', () => {
      // Probe readings 3, 9 and 10: losing content or gaining viewport leaves a
      // column that no longer fits, and the browser pulls it back. Both are
      // the end getting closer, which is the only thing that obliges the
      // browser to move a column upward at all.
      expect(readScroll({ top: END, lastTop: 2060, end: END, lastEnd: 2300, written: undefined })).toBeNull();
    });

    it('says nothing about an anchored column when content above it got shorter', () => {
      // Scroll anchoring holds the row a reader is looking at still while
      // heights change above it, which moves the column without anyone
      // touching it. Unlike a clamp it does not come to rest on the end, so a
      // reading that asked where it landed took this for the reader and ended
      // the journey to the newest message half way.
      expect(
        readScroll({ top: 1200, lastTop: 1500, end: 1700, lastEnd: 2000, written: undefined }),
      ).toBeNull();
    });

    it('takes the smallest nudge a reader can make while the end holds still', () => {
      // Measured on a running turn: two-pixel wheel turns, fifteen of them,
      // moved the column not at all while the reply was arriving. A trackpad
      // opens a slow two-finger scroll at about this size, and the sixth
      // complaint is this exact gesture doing nothing.
      //
      // Nothing here obliges the browser to move the column: the end is where
      // it was. So this is the reader, however small the move.
      expect(
        readScroll({ top: END - 2, lastTop: END, end: END, lastEnd: END, written: undefined }),
      ).toBe('readerMovedUp');
    });

    it('takes a reader who moved up while the end was growing under them', () => {
      // Content arriving below pushes the end further away, which can never
      // move a column upward. So this one was moved by the reader.
      expect(
        readScroll({ top: 1800, lastTop: 2060, end: END, lastEnd: 1900, written: undefined }),
      ).toBe('readerMovedUp');
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
      expect(readScroll(reading({ top: END - AT_END_EPSILON_PX, lastTop: 1200 }))).toBe(
        'readerMovedDownToEnd',
      );
    });

    it('takes a reader who reached the physical end under zoom as having reached it', () => {
      // Two pixels is the worst a real Chromium left between a column's own
      // end and the furthest it would scroll. The reader here did everything
      // they could: the column will not go down another pixel.
      expect(readScroll(reading({ top: END - 2, lastTop: 1200 }))).toBe('readerMovedDownToEnd');
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
