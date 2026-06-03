// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import type { InpaintStroke } from '@web/spaces/canvas/inpaint/types';

interface ExportMaskInput {
  width: number;
  height: number;
  strokes: ReadonlyArray<InpaintStroke>;
}

/**
 * Renders the supplied strokes into an off-screen canvas at image-pixel
 * size and returns the resulting mask PNG as a data URL. The mask is a
 * single-channel (alpha) image; strokes are painted white on a fully
 * transparent background, matching what most inpaint providers expect.
 *
 * Returns null in a non-DOM environment (lets callers gracefully degrade
 * in SSR / node test runners that lack OffscreenCanvas).
 * @param root0 - Mask export input.
 * @param root0.width - Mask width in image pixels.
 * @param root0.height - Mask height in image pixels.
 * @param root0.strokes - Strokes to rasterize, in image-pixel coordinates.
 * @returns The mask PNG as a data URL, or null when no DOM / 2D context is available.
 */
export function exportMask({
  width,
  height,
  strokes,
}: ExportMaskInput): string | null {
  if (typeof document === 'undefined') return null;
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.floor(width));
  canvas.height = Math.max(1, Math.floor(height));
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;

  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.strokeStyle = '#ffffff';

  for (const stroke of strokes) {
    if (stroke.points.length === 0) continue;
    ctx.globalAlpha = clamp01(stroke.alpha);
    ctx.lineWidth = Math.max(1, stroke.radius * 2);
    ctx.beginPath();
    const first = stroke.points[0];
    ctx.moveTo(first.x, first.y);
    if (stroke.points.length === 1) {
      ctx.lineTo(first.x + 0.01, first.y + 0.01);
    } else {
      for (let i = 1; i < stroke.points.length; i++) {
        ctx.lineTo(stroke.points[i].x, stroke.points[i].y);
      }
    }
    ctx.stroke();
  }

  return canvas.toDataURL('image/png');
}

/**
 * Clamps a number into the [0, 1] range, mapping NaN to 0.
 * @param n - The value to clamp.
 * @returns The value constrained to [0, 1].
 */
function clamp01(n: number): number {
  if (Number.isNaN(n)) return 0;
  if (n < 0) return 0;
  if (n > 1) return 1;
  return n;
}
