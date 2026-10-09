// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * How a mask or sketch drawing is painted (inner#1302 §6.2, §6.4). The screen
 * and the export both paint through {@link paintDrawing}, so what the reader
 * sees is what the model is sent.
 */

import type { MiniToolDrawing } from '@breatic/shared/mini-tools';

import type { DrawOp } from '@web/stores/drawing-draft';

/** A target's pixel size. */
export interface PaintSize {
  width: number;
  height: number;
}

/** Which way a drawing is painted. */
export type DrawingKind = MiniToolDrawing['kind'];

/** Paints ops at a size and reports whether any pixel is left opaque. */
export type InkRaster = (ops: readonly DrawOp[], size: PaintSize, kind: DrawingKind) => boolean;

/** The long side `hasInk` paints at; ink this small still shows. */
const INK_PROBE_SIDE = 512;

/**
 * Paints ops onto a context. A mask paints every op in one colour with its
 * shapes filled; a sketch paints each op in its own ink with its shapes
 * outlined. An eraser stroke removes what is under it.
 * @param ctx - The context, sized to `size`.
 * @param ops - The ops, in source fractions.
 * @param size - The target's pixel size.
 * @param kind - Mask or sketch.
 * @param color - The colour a mask is painted in.
 */
export function paintDrawing(
  ctx: CanvasRenderingContext2D,
  ops: readonly DrawOp[],
  size: PaintSize,
  kind: DrawingKind,
  color: string,
): void {
  const { width, height } = size;
  const unit = Math.min(width, height) / 100;
  for (const op of ops) {
    const lineWidth = op.size * unit;
    const ink = kind === 'mask' ? color : op.color;
    ctx.save();
    ctx.globalCompositeOperation = op.kind === 'stroke' && op.erase ? 'destination-out' : 'source-over';
    ctx.strokeStyle = ink;
    ctx.fillStyle = ink;
    ctx.lineWidth = lineWidth;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.beginPath();
    if (op.kind === 'stroke') {
      const [first, ...rest] = op.points;
      if (first !== undefined && rest.length === 0) {
        ctx.arc(first[0] * width, first[1] * height, lineWidth / 2, 0, Math.PI * 2);
        ctx.fill();
      } else if (first !== undefined) {
        ctx.moveTo(first[0] * width, first[1] * height);
        for (const [x, y] of rest) ctx.lineTo(x * width, y * height);
        ctx.stroke();
      }
    } else {
      const x = op.x * width;
      const y = op.y * height;
      const w = op.w * width;
      const h = op.h * height;
      if (op.kind === 'rect') ctx.rect(x, y, w, h);
      else ctx.ellipse(x + w / 2, y + h / 2, Math.abs(w / 2), Math.abs(h / 2), 0, 0, Math.PI * 2);
      if (kind === 'mask') ctx.fill();
      else ctx.stroke();
    }
    ctx.restore();
  }
}

/**
 * Whether painted pixels hold any ink: a pixel at least half covered, the same
 * line the mask export draws between white and black. An eraser run along a
 * stroke leaves its anti-aliased rim below that line.
 * @param data - RGBA pixel data.
 * @returns True when some pixel has alpha of 128 or more.
 */
export function inkShows(data: Uint8ClampedArray): boolean {
  for (let i = 3; i < data.length; i += 4) if ((data[i] ?? 0) >= 128) return true;
  return false;
}

/**
 * Whether a drawing leaves anything on the picture: drawn and then wholly
 * erased counts as empty.
 * @param ops - The visible ops.
 * @param kind - Mask or sketch.
 * @param aspect - The source's width over its height.
 * @param raster - Paints and looks for opaque pixels.
 * @returns True when some ink shows.
 */
export function hasInk(ops: readonly DrawOp[], kind: DrawingKind, aspect: number, raster: InkRaster = canvasRaster): boolean {
  if (ops.length === 0) return false;
  const size =
    aspect >= 1
      ? { width: INK_PROBE_SIDE, height: Math.max(1, Math.round(INK_PROBE_SIDE / aspect)) }
      : { width: Math.max(1, Math.round(INK_PROBE_SIDE * aspect)), height: INK_PROBE_SIDE };
  return raster(ops, size, kind);
}

/**
 * Paints on an off-screen canvas and scans its alpha.
 * @param ops - The ops.
 * @param size - The canvas size.
 * @param kind - Mask or sketch.
 * @returns True when the ink shows.
 */
function canvasRaster(ops: readonly DrawOp[], size: PaintSize, kind: DrawingKind): boolean {
  const canvas = document.createElement('canvas');
  canvas.width = size.width;
  canvas.height = size.height;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  // No 2D context to look with: leave Execute on and let the export's own check decide.
  if (ctx === null) return true;
  paintDrawing(ctx, ops, size, kind, '#fff'); // design-value: allow — probe colour, never shown
  return inkShows(ctx.getImageData(0, 0, size.width, size.height).data);
}
