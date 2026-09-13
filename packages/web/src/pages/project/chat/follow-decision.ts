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

/** Which way a scroll took the column. */
export type ScrollDirection = 'up' | 'down' | 'still';

/**
 * What a column should do about the scroll that just happened.
 *
 * The whole judgement, in one place, because the library's own runs in a timer
 * a millisecond out and is skipped entirely for any event raised while a
 * resize is marked -- which mid-turn is every frame a chunk lands in. That
 * gate shuts on both halves: a reader leaving the end is not heard, and a
 * reader coming back to it does not get the lock back. Reading the scroll as
 * it arrives makes the answer the same whichever frame the reader moved in,
 * and the same whichever way they moved it -- wheel, scrollbar, keys, or a
 * drag of the selection past the edge.
 *
 * Which way it went decides as much as where it landed, and the two directions
 * answer to different lines.
 *
 * Letting go answers to the end itself: a column above it at all is a column
 * the reader put there, whatever the distance. The slack would leave the first
 * seventy pixels to the library, and the library only hears a wheel turned
 * over the content -- the scrollbar, the keys and a selection dragged past the
 * edge all move the column without one, and mid-turn its other judgement is
 * shut as often as not. Nothing else comes up to rest above the end: a browser
 * clamping the column lands it exactly at the end, and everything the library
 * writes it writes at its own target.
 *
 * Coming back answers to the slack, because that is the line the way-back
 * button is drawn from and the library's own reading of being at the end: a
 * reader who brings the column within it has come back as far as there is to
 * come.
 * @param distanceFromEnd - Pixels between where the column sits and its end.
 * @param following - Whether the column is currently keeping up on its own.
 * @param direction - Which way this scroll took it.
 * @returns The change owed, or "nothing" when there is none.
 */
export function decideFollow(
  distanceFromEnd: number,
  following: boolean,
  direction: ScrollDirection,
): FollowAction {
  if (direction === 'up' && following && distanceFromEnd > 0) return 'leave';
  if (direction === 'down' && !following && distanceFromEnd <= AT_END_SLACK_PX) return 'follow';
  return 'nothing';
}
