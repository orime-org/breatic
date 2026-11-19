// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import type { PresentedMediaFrame } from '@web/spaces/canvas/video-presentation/types';

/** Per-instance presented-frame clock, shared by native and alpha adapters. */
export interface PresentedFrameClock {
  getFrame: () => PresentedMediaFrame | null;
  getSeekEpoch: () => number;
  invalidate: () => number;
  commit: (mediaTime: number, seekEpoch: number) => PresentedMediaFrame | null;
  dispose: () => void;
}

/**
 * Keeps only actual draws for the newest source and seek identity.
 * @param element - The actual element driven by transport controls.
 * @param surface - Its native picture or alpha compositor.
 * @param sourceKey - Canonical identity, never the packed URL.
 * @param sourceEpoch - Effect-owned resource identity.
 * @param onLateFrame - Told of a frame that becomes current at `seeked` rather than at its own callback.
 * @returns A frame clock that can be invalidated before a seek command.
 * @throws {never} Invalid frame notifications are ignored.
 */
export function createPresentedFrameClock(
  element: HTMLVideoElement,
  surface: HTMLVideoElement | HTMLCanvasElement,
  sourceKey: string,
  sourceEpoch: number,
  onLateFrame?: (frame: PresentedMediaFrame) => void,
): PresentedFrameClock {
  let live = true;
  let seekEpoch = 0;
  let frame: PresentedMediaFrame | null = null;
  // A paused seek's only frame is called back while `seeking` is still true (Chromium); it becomes current at `seeked`.
  let held: PresentedMediaFrame | null = null;
  /**
   * Invalidates the previous draw before a seek can expose it as current.
   * @returns The newly accepted seek identity.
   * @throws {never} Never.
   */
  function invalidate(): number {
    if (live) { seekEpoch++; frame = null; held = null; }
    return seekEpoch;
  }
  /**
   * Makes the frame held through this seek current once the seek has ended.
   * @throws {never} Never.
   */
  function seeked(): void {
    if (!live || held === null || held.seekEpoch !== seekEpoch || element.seeking) return;
    frame = held;
    held = null;
    onLateFrame?.(frame);
  }
  element.addEventListener('seeking', invalidate);
  element.addEventListener('seeked', seeked);
  return {
    getFrame: () => frame,
    getSeekEpoch: () => seekEpoch,
    invalidate,
    commit: (mediaTime, acceptedSeekEpoch) => {
      if (!live || acceptedSeekEpoch !== seekEpoch || !Number.isFinite(mediaTime) || mediaTime < 0) return null;
      const drawn = Object.freeze({ sourceKey, sourceEpoch, seekEpoch, mediaTime, surface });
      if (element.seeking) { held = drawn; return null; }
      frame = drawn;
      return frame;
    },
    dispose: () => {
      live = false;
      frame = null;
      held = null;
      element.removeEventListener('seeking', invalidate);
      element.removeEventListener('seeked', seeked);
    },
  };
}
