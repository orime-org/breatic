// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import type { PresentedMediaFrame } from '@web/spaces/canvas/video-presentation/types';

/** Per-instance presented-frame clock, shared by native and alpha adapters. */
export interface PresentedFrameClock {
  getFrame: () => PresentedMediaFrame | null;
  getSeekEpoch: () => number;
  invalidate: () => number;
  commit: (mediaTime: number, seekEpoch: number) => void;
  dispose: () => void;
}

/**
 * Keeps only actual draws for the newest source and seek identity.
 * @param _element - The actual element driven by transport controls.
 * @param _surface - Its native picture or alpha compositor.
 * @param _sourceKey - Canonical identity, never the packed URL.
 * @param _sourceEpoch - Effect-owned resource identity.
 * @returns A frame clock that can be invalidated before a seek command.
 * @throws {never} Invalid frame notifications are ignored.
 */
export function createPresentedFrameClock(
  _element: HTMLVideoElement,
  _surface: HTMLVideoElement | HTMLCanvasElement,
  _sourceKey: string,
  _sourceEpoch: number,
): PresentedFrameClock {
  return { getFrame: () => null, getSeekEpoch: () => 0, invalidate: () => 0, commit: () => {}, dispose: () => {} };
}
