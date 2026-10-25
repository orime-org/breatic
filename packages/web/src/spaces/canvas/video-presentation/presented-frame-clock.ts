// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

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
 * @returns A frame clock that can be invalidated before a seek command.
 * @throws {never} Invalid frame notifications are ignored.
 */
export function createPresentedFrameClock(
  element: HTMLVideoElement,
  surface: HTMLVideoElement | HTMLCanvasElement,
  sourceKey: string,
  sourceEpoch: number,
): PresentedFrameClock {
  let live = true;
  let seekEpoch = 0;
  let frame: PresentedMediaFrame | null = null;
  /**
   * Invalidates the previous draw before a seek can expose it as current.
   * @returns The newly accepted seek identity.
   * @throws {never} Never.
   */
  function invalidate(): number {
    if (live) { seekEpoch++; frame = null; }
    return seekEpoch;
  }
  element.addEventListener('seeking', invalidate);
  return {
    getFrame: () => frame,
    getSeekEpoch: () => seekEpoch,
    invalidate,
    commit: (mediaTime, acceptedSeekEpoch) => {
      if (live && acceptedSeekEpoch === seekEpoch && !element.seeking && Number.isFinite(mediaTime) && mediaTime >= 0) {
        frame = Object.freeze({ sourceKey, sourceEpoch, seekEpoch, mediaTime, surface });
        return frame;
      }
      return null;
    },
    dispose: () => {
      live = false;
      frame = null;
      element.removeEventListener('seeking', invalidate);
    },
  };
}
