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
      expect(readScroll(reading({ top: 1497, lastTop: 1500, end: END, written: 1500 }))).toBe(
        'readerMovedUp',
      );
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

    it('takes the smallest nudge a reader can make away from a column that fits', () => {
      // Measured on a running turn: two-pixel wheel turns, fifteen of them,
      // moved the column not at all while the reply was arriving. A trackpad
      // opens a slow two-finger scroll at about this size, and the sixth
      // complaint is this exact gesture doing nothing.
      //
      // Nothing here obliges the browser to move the column: the position we
      // last saw still fits inside the end. So this is the reader, however
      // small it is.
      expect(readScroll({ top: END - 2, lastTop: END, end: END, written: undefined })).toBe(
        'readerMovedUp',
      );
    });

    it('takes a reader who came up to rest short of the end', () => {
      // Here the position last seen no longer fits, so the browser was going
      // to move this column whatever the reader did -- but it came to rest
      // past the end's tolerance, further up than a clamp would leave it, so
      // somebody took it there.
      expect(
        readScroll({ top: END - AT_END_EPSILON_PX - 1, lastTop: 2060, end: END, written: undefined }),
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
