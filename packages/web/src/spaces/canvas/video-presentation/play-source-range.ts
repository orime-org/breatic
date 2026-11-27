// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-Breatic-Source-Available-2.0

import type { MediaSurfaceBinding } from '@web/spaces/canvas/video-presentation/types';

/** One range playing in the node's player. */
export interface SourceRangePlayback {
  /** Pauses the player where it is and ends the playback. */
  stop: () => void;
  /** Settles when the playback ends (its end reached, stopped, or paused by the user); rejects when the player refuses to play. */
  done: Promise<void>;
}

/**
 * Plays exactly one source range in the node's player (canvas design §4 split row preview; demo video-controls.tsx
 * CutEditor previewSegment): seeks to the start, plays, and on reaching the end pauses there. The end is checked on every
 * animation frame as well as on the player's own time events, which come too seldom to stop on the boundary. A seek the
 * playback did not make itself (the user moving the player) ends it where the user put the player. Such a seek is told by
 * where it goes: a seek sets `seeking` and `currentTime` at once (HTML seek algorithm), so a seek in flight to anywhere but
 * the range start is the user's, before its `currentTime` can be mistaken for the range end. The range start is the value
 * the player reads back after the start seek, not the one asked for: Chromium stores a seek target in whole microseconds,
 * so a start such as 31/30 reads back as 1.033333 while that seek is in flight. The start seek of an earlier
 * playback of the same player also lands on this one's events, so seek events are not counted.
 * @param binding - The node's media binding.
 * @param start - The range start in seconds; a frame range passes its first frame's midpoint (frames-split §4.3).
 * @param end - The seconds the playback stops at and rests on; a frame range passes its last frame's midpoint.
 * @returns The playback.
 * @throws {never} A refused play rejects `done`.
 */
export function playSourceRange(binding: Pick<MediaSurfaceBinding, 'element' | 'seek' | 'play' | 'pause'>, start: number, end: number): SourceRangePlayback {
  const { element } = binding;
  let over = false;
  let frame = 0;
  let settle: (() => void) | undefined;
  binding.seek(start);
  const startRead = element.currentTime;
  /**
   * Ends the playback once, pausing on the end when it was reached.
   * @param reachedEnd - Whether the clock reached the range end.
   * @throws {never} Never.
   */
  const finish = (reachedEnd: boolean): void => {
    if (over) return;
    over = true;
    cancelAnimationFrame(frame);
    element.removeEventListener('timeupdate', reached);
    element.removeEventListener('ended', reached);
    element.removeEventListener('pause', interrupted);
    element.removeEventListener('seeking', seeking);
    if (reachedEnd) { binding.pause(); binding.seek(end); }
    settle?.();
  };
  /**
   * Ends the playback where the user put the player when a seek in flight goes anywhere but the range start.
   * @returns Whether it ended.
   * @throws {never} Never.
   */
  function moved(): boolean {
    if (!over && element.seeking && element.currentTime !== startRead) finish(false);
    return over;
  }
  /**
   * Ends the playback when the clock has reached the range end, unless the user moved the player there.
   * @returns Whether it ended.
   * @throws {never} Never.
   */
  function reached(): boolean {
    if (!moved() && (element.currentTime >= end || element.ended)) finish(true);
    return over;
  }
  /**
   * A seek event, the playback's own start seek's or a later one, ends it only when it goes elsewhere.
   * @throws {never} Never.
   */
  function seeking(): void { moved(); }
  /**
   * The one per-frame look at the clock, rescheduled until the playback ends.
   * @throws {never} Never.
   */
  function tick(): void { if (!reached()) frame = requestAnimationFrame(tick); }
  /**
   * The user paused the player: the playback ends where it is.
   * @throws {never} Never.
   */
  function interrupted(): void { finish(false); }
  const done = new Promise<void>((resolve, reject) => {
    settle = resolve;
    element.addEventListener('seeking', seeking);
    element.addEventListener('timeupdate', reached);
    element.addEventListener('ended', reached);
    binding.play().then(() => {
      if (moved()) return;
      // Listened to only once playing, so a pause the start's own seek caused does not end the playback.
      element.addEventListener('pause', interrupted);
      frame = requestAnimationFrame(tick);
    }, (error: unknown) => {
      // A later pause or load interrupted the play: the playback ended, it was not refused.
      if (error instanceof DOMException && error.name === 'AbortError') { finish(false); return; }
      // Rejected first, so the settle inside finish is a no-op.
      reject(error instanceof Error ? error : new Error(String(error)));
      finish(false);
    });
  });
  return { stop: () => { if (over) return; binding.pause(); finish(false); }, done };
}
