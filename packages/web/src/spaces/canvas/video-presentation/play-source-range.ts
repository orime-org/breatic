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
 * animation frame as well as on the player's own time events, which come too seldom to stop on the boundary.
 * @param binding - The node's media binding.
 * @param start - The range start in seconds.
 * @param end - The range end in seconds.
 * @returns The playback.
 * @throws {never} A refused play rejects `done`.
 */
export function playSourceRange(binding: Pick<MediaSurfaceBinding, 'element' | 'seek' | 'play' | 'pause'>, start: number, end: number): SourceRangePlayback {
  const { element } = binding;
  let over = false;
  let frame = 0;
  let settle: (() => void) | undefined;
  /**
   * Ends the playback once, pausing on the end when it was reached.
   * @param reachedEnd - Whether the clock reached the range end.
   * @throws {never} Never.
   */
  const finish = (reachedEnd: boolean): void => {
    if (over) return;
    over = true;
    cancelAnimationFrame(frame);
    element.removeEventListener('timeupdate', check);
    element.removeEventListener('ended', check);
    element.removeEventListener('pause', paused);
    if (reachedEnd) { binding.pause(); binding.seek(end); }
    settle?.();
  };
  /**
   * Ends the playback when the clock has reached the range end, otherwise looks again on the next frame.
   * @throws {never} Never.
   */
  function check(): void {
    if (over) return;
    if (element.currentTime >= end || element.ended) finish(true);
    else frame = requestAnimationFrame(check);
  }
  /**
   * The user paused the player: the playback ends where it is.
   * @throws {never} Never.
   */
  function paused(): void { finish(false); }
  const done = new Promise<void>((resolve, reject) => {
    settle = resolve;
    binding.seek(start);
    element.addEventListener('timeupdate', check);
    element.addEventListener('ended', check);
    binding.play().then(() => {
      if (over) return;
      // Listened to only once playing, so a pause the start itself caused does not end the playback.
      element.addEventListener('pause', paused);
      frame = requestAnimationFrame(check);
    }, (error: unknown) => {
      // Rejected first, so the settle inside finish is a no-op.
      reject(error instanceof Error ? error : new Error(String(error)));
      finish(false);
    });
  });
  return { stop: () => { if (over) return; binding.pause(); finish(false); }, done };
}
