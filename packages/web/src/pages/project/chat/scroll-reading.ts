// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import type { FollowEvent } from '@web/pages/project/chat/follow-machine';

/**
 * How close to its end still counts as a column being on it.
 *
 * `scrollHeight` and `clientHeight` are whole while the furthest `scrollTop`
 * is aligned to device pixels, so the three do not cancel on a column that has
 * gone as far down as it physically goes. At 100% zoom the residue is zero,
 * but a real Chromium sweeping 240 geometries left up to 1.25 of a pixel at
 * 80%, 90%, 110% and 125%. This has to clear that, because the reader who
 * scrolls back down to the end is how a column stops being theirs -- read as
 * short of the end, their arrival never counts and the way back never goes
 * away. Four is where the libraries that ask this question precisely sit.
 */
export const AT_END_EPSILON_PX = 4;

/**
 * How far off a written position may come back and still be our own write.
 *
 * Only the fraction a write is rounded by, which is why it is not the
 * tolerance above: a reader's smallest wheel nudge is about three pixels and
 * fits inside that one, and taking such a nudge for our own write would leave
 * the column following while the reader meant to stop it.
 */
export const OWN_WRITE_EPSILON_PX = 1;

/** What one scroll event carries, with what we knew going into it. */
export interface ScrollReading {
  /** Where the column sits now. */
  top: number;
  /** Where it sat when the last event was read. */
  lastTop: number;
  /** `scrollHeight - clientHeight` as of now. */
  end: number;
  /** The position we wrote ourselves since the last event, if we wrote one. */
  written: number | undefined;
}

/**
 * Which reader move, if any, a scroll event stands for.
 *
 * A scroll event carries no trace of who caused it: CSSOM View puts a
 * programmatic write and a reader's gesture in the same queue, and `isTrusted`
 * is true for both. So this reads by exclusion.
 *
 * Our own write is known by the value it asked for. A clamp -- the browser
 * pulling a column that no longer fits back into range -- always comes to rest
 * on the end while moving up, which nothing a reader does can do: coming up
 * from the end lands above it, and a column cannot be pushed past the end to
 * begin with. Everything left is the reader, whatever they used to do it, so
 * the middle wheel, the browser's own find-in-page, a tab into something
 * offscreen, Home and End, and a wheel turned over the scrollbar all count
 * without being named.
 * @param reading - The event and what we knew going into it.
 * @returns The reader's move, or null when it was not the reader.
 */
export function readScroll(reading: ScrollReading): FollowEvent | null {
  const { top, lastTop, end, written } = reading;
  if (written !== undefined && Math.abs(top - written) <= OWN_WRITE_EPSILON_PX) return null;

  const atEnd = Math.abs(end - top) <= AT_END_EPSILON_PX;
  if (top < lastTop) return atEnd ? null : 'readerMovedUp';
  if (top > lastTop) return atEnd ? 'readerMovedDownToEnd' : 'readerMovedDownShort';
  return null;
}
