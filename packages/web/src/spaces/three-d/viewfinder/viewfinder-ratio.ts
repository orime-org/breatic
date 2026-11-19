// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import type { ViewfinderRatio } from '@breatic/shared';

/**
 * The width/height a ratio holds the frame to.
 * @param ratio - The menu value.
 * @returns The ratio, or null for Free.
 */
export function viewfinderRatioValue(ratio: ViewfinderRatio): number | null {
  if (ratio === 'Free') return null;
  const [w, h] = ratio.split(':').map(Number);
  return (w ?? 1) / (h ?? 1);
}

/**
 * A camera record's frame ratio, width over height.
 * @param camera - The record's frame and free ratio.
 * @param camera.frame - Its frame.
 * @param camera.freeRatio - Its ratio when the frame is Free.
 * @returns The ratio.
 */
export function cameraFrameRatio(camera: { frame: ViewfinderRatio; freeRatio: number }): number {
  return viewfinderRatioValue(camera.frame) ?? camera.freeRatio;
}
