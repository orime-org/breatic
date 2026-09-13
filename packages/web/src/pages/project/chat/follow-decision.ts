// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * How close to the end still counts as being at it, in pixels.
 *
 * The library's own reading, and the one the way-back button is drawn from:
 * `STICK_TO_BOTTOM_OFFSET_PX` in `use-stick-to-bottom`, which is not exported.
 * Inside it the hook reports the reader as at the end whatever the lock says,
 * so a second line here would have the two disagree about the same reader.
 */
export const AT_END_SLACK_PX = 70;

/** What a scroll leaves the column owing. */
export type FollowAction = 'follow' | 'leave' | 'nothing';

/**
 * What a column should do about where it now sits.
 *
 * The whole judgement, in one place and off two numbers, because the library's
 * own runs in a timer a millisecond out and is skipped entirely for any event
 * raised while a resize is marked -- which mid-turn is every frame a chunk
 * lands in. That gate shuts on both halves: a reader leaving the end is not
 * heard, and a reader coming back to it does not get the lock back. Reading
 * the geometry as the event arrives makes the answer the same whichever frame
 * the reader moved in, and the same whichever way they moved it -- wheel,
 * scrollbar, keys, or a drag of the selection past the edge.
 * @param distanceFromEnd - Pixels between where the column sits and its end.
 * @param following - Whether the column is currently keeping up on its own.
 * @returns The change owed, or "nothing" when the two already agree.
 */
export function decideFollow(distanceFromEnd: number, following: boolean): FollowAction {
  const atEnd = distanceFromEnd <= AT_END_SLACK_PX;
  if (atEnd && !following) return 'follow';
  if (!atEnd && following) return 'leave';
  return 'nothing';
}
