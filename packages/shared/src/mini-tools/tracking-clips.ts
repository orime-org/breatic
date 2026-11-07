// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/** A range of presentation frame ordinals, [start, end). */
export interface FrameRange { start: number; end: number }

/** A range of presentation seconds, [start, end). */
export interface TrackingTimeRange { start: number; end: number }

/** An anchor frame: its presentation ordinal and time. */
export interface TrackingAnchor { frameIndex: number; pts: number }

/** The one or two clips a range is tracked on: forward from the anchor, and the frames up to the anchor reversed. */
export interface TrackingClips { forward: FrameRange | null; reverse: FrameRange | null }

/**
 * The clips a range anchored at `anchor` is tracked on (execution design §10.2): the hosted tracker takes its prompt on frame
 * 0 only, so it tracks [anchor, end) forward, and, when the anchor is past the start, [start, anchor] played backwards.
 * @param range - The range, [start, end).
 * @param anchor - The anchor's ordinal inside the range.
 * @returns The clips; the reversed one lists its frames in source order.
 * @throws {RangeError} When the anchor lies outside the range.
 */
export function trackingClips(range: FrameRange, anchor: number): TrackingClips {
  if (!Number.isInteger(anchor) || anchor < range.start || anchor >= range.end) throw new RangeError("The anchor lies outside the tracking range");
  const forward = anchor < range.end - 1 || anchor === range.start ? { start: anchor, end: range.end } : null;
  const reverse = anchor > range.start ? { start: range.start, end: anchor + 1 } : null;
  return { forward, reverse };
}

/**
 * Joins the clips' per-frame results into one entry per range frame in source order; the anchor frame comes from the forward
 * clip when there is one.
 * @param clips - The clips the results belong to.
 * @param forward - The forward clip's results in its own order, or null when there is none.
 * @param reverse - The reversed clip's results in its own (backwards) order, or null when there is none.
 * @returns The range's results.
 * @throws {RangeError} When a result list does not match its clip.
 */
export function joinTrackingClips<T>(clips: TrackingClips, forward: readonly T[] | null, reverse: readonly T[] | null): T[] {
  /**
   * A clip's frame count.
   * @param clip - The clip, or null.
   * @returns Its frames, 0 for none.
   * @throws {never} Never.
   */
  const length = (clip: FrameRange | null): number => (clip === null ? 0 : clip.end - clip.start);
  if ((forward?.length ?? 0) !== length(clips.forward) || (reverse?.length ?? 0) !== length(clips.reverse) || (clips.forward === null) !== (forward === null) || (clips.reverse === null) !== (reverse === null)) {
    throw new RangeError("A tracking clip's results do not match its frames");
  }
  const before = reverse === null ? [] : [...reverse].reverse();
  return forward === null ? before : [...before.slice(0, clips.forward === null ? before.length : before.length - 1), ...forward];
}

/**
 * Whether an erase anchor lies inside its tracking range (execution design §10.2): range.start ≤ anchor.pts < range.end.
 * @param range - The range in presentation seconds.
 * @param anchor - The anchor; its presentation time decides.
 * @returns True inside.
 * @throws {never} Never.
 */
export function anchorInTrackingRange(range: TrackingTimeRange, anchor: TrackingAnchor): boolean {
  return anchor.pts >= range.start && anchor.pts < range.end;
}
