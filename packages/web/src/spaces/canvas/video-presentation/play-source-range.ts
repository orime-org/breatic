// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

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
 * playback did not make itself (the user moving the player) ends it where the user put the player; it is told by the
 * binding's seek epoch, which a seek moves at once, before its `currentTime` can be mistaken for the range end.
 * @param binding - The node's media binding.
 * @param start - The range start in seconds.
 * @param end - The range end in seconds.
 * @returns The playback.
 * @throws {never} A refused play rejects `done`.
 */
export function playSourceRange(binding: Pick<MediaSurfaceBinding, 'element' | 'getSeekEpoch' | 'seek' | 'play' | 'pause'>, start: number, end: number): SourceRangePlayback {
  const { element } = binding;
  let over = false;
  let frame = 0;
  let settle: (() => void) | undefined;
  let seekEpoch = 0;
  let ownSeekEchoed = false;
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
   * Ends the playback where the user put the player when anyone but the playback itself has seeked.
   * @returns Whether it ended.
   * @throws {never} Never.
   */
  function moved(): boolean {
    if (!over && binding.getSeekEpoch() !== seekEpoch) finish(false);
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
   * The frame clock moves the seek epoch on every `seeking` event too; the first one after the start seek is that seek's own.
   * @throws {never} Never.
   */
  function seeking(): void {
    if (!ownSeekEchoed) { ownSeekEchoed = true; seekEpoch += 1; }
    moved();
  }
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
    binding.seek(start);
    seekEpoch = binding.getSeekEpoch();
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
