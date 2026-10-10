// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { describe, expect, it, vi } from 'vitest';

import { hasInk, inkShows, isInk, paintDrawing } from '@web/spaces/canvas/mini-tool/paint-drawing';
import type { DrawOp } from '@web/stores/drawing-draft';

/**
 * A 2D context that records what is drawn, since jsdom has no rasteriser.
 * @returns The context and the calls made on it.
 */
function recordingContext(): { ctx: CanvasRenderingContext2D; calls: string[] } {
  const calls: string[] = [];
  const state: Record<string, unknown> = {};
  const ctx = new Proxy(state, {
    get(target, key: string) {
      if (key in target) return target[key];
      return (...args: unknown[]) => {
        const shown = args.map((arg) => (typeof arg === 'number' ? Math.round(arg * 100) / 100 : arg));
        calls.push(`${key}(${shown.join(',')})`);
      };
    },
    set(target, key: string, value: unknown) {
      target[key] = value;
      calls.push(`${key}=${String(value)}`);
      return true;
    },
  }) as unknown as CanvasRenderingContext2D;
  return { ctx, calls };
}

const SIZE = { width: 400, height: 200 };
const PINK = '#ff00aa';

describe('paintDrawing', () => {
  it('strokes a brush line as wide as its size in percent of the shorter side', () => {
    const { ctx, calls } = recordingContext();
    const op: DrawOp = { kind: 'stroke', erase: false, size: 10, color: '#FF3B30', points: [[0, 0], [0.5, 0.5]] };
    paintDrawing(ctx, [op], SIZE, 'mask', PINK);
    expect(calls).toContain('lineWidth=20');
    expect(calls).toContain(`strokeStyle=${PINK}`);
    expect(calls).toContain('globalCompositeOperation=source-over');
    expect(calls).toContain('moveTo(0,0)');
    expect(calls).toContain('lineTo(200,100)');
    expect(calls).toContain('stroke()');
  });

  it('paints a sketch stroke in its own ink', () => {
    const { ctx, calls } = recordingContext();
    const op: DrawOp = { kind: 'stroke', erase: false, size: 10, color: '#0A84FF', points: [[0, 0], [1, 1]] };
    paintDrawing(ctx, [op], SIZE, 'sketch', PINK);
    expect(calls).toContain('strokeStyle=#0A84FF');
  });

  it('paints a single-point stroke as a dot', () => {
    const { ctx, calls } = recordingContext();
    const op: DrawOp = { kind: 'stroke', erase: false, size: 10, color: '#FF3B30', points: [[0.5, 0.5]] };
    paintDrawing(ctx, [op], SIZE, 'mask', PINK);
    expect(calls).toContain(`arc(200,100,10,0,${Math.round(Math.PI * 2 * 100) / 100})`);
    expect(calls).toContain('fill()');
  });

  it('erases with destination-out', () => {
    const { ctx, calls } = recordingContext();
    const op: DrawOp = { kind: 'stroke', erase: true, size: 10, color: '#FF3B30', points: [[0, 0], [1, 1]] };
    paintDrawing(ctx, [op], SIZE, 'mask', PINK);
    expect(calls).toContain('globalCompositeOperation=destination-out');
  });

  it('fills a mask rectangle and outlines a sketch one', () => {
    const op: DrawOp = { kind: 'rect', size: 5, color: '#FF3B30', x: 0.25, y: 0.5, w: 0.5, h: 0.25 };
    const mask = recordingContext();
    paintDrawing(mask.ctx, [op], SIZE, 'mask', PINK);
    expect(mask.calls).toContain('rect(100,100,200,50)');
    expect(mask.calls).toContain('fill()');
    expect(mask.calls).not.toContain('stroke()');
    const sketch = recordingContext();
    paintDrawing(sketch.ctx, [op], SIZE, 'sketch', PINK);
    expect(sketch.calls).toContain('lineWidth=10');
    expect(sketch.calls).toContain('stroke()');
    expect(sketch.calls).not.toContain('fill()');
  });

  it('draws an ellipse dragged up and left from its centre with positive radii', () => {
    const { ctx, calls } = recordingContext();
    const op: DrawOp = { kind: 'ellipse', size: 5, color: '#FF3B30', x: 0.75, y: 1, w: -0.5, h: -0.5 };
    paintDrawing(ctx, [op], SIZE, 'mask', PINK);
    expect(calls).toContain(`ellipse(200,150,100,50,0,0,${Math.round(Math.PI * 2 * 100) / 100})`);
  });
});

describe('hasInk', () => {
  it('is false with nothing drawn, without rasterising', () => {
    const raster = vi.fn(() => true);
    expect(hasInk([], 'mask', 1, raster)).toBe(false);
    expect(raster).not.toHaveBeenCalled();
  });

  it('rasterises on a 512px long side and answers what the raster finds', () => {
    const op: DrawOp = { kind: 'rect', size: 5, color: '#FF3B30', x: 0, y: 0, w: 1, h: 1 };
    const raster = vi.fn(() => false);
    expect(hasInk([op], 'sketch', 2, raster)).toBe(false);
    expect(raster).toHaveBeenCalledWith([op], { width: 512, height: 256 }, 'sketch');
    raster.mockReturnValue(true);
    expect(hasInk([op], 'mask', 0.5, raster)).toBe(true);
    expect(raster).toHaveBeenLastCalledWith([op], { width: 256, height: 512 }, 'mask');
  });
});

describe('inkShows', () => {
  /**
   * RGBA pixels with the given alphas.
   * @param alphas - One alpha per pixel.
   * @returns The pixel data.
   */
  const pixels = (...alphas: number[]): Uint8ClampedArray =>
    new Uint8ClampedArray(alphas.flatMap((alpha) => [255, 255, 255, alpha]));

  // An eraser run along a stroke leaves its anti-aliased rim at alpha 1–127;
  // the mask export reads that as black, so it is no ink.
  it('counts only pixels at least half covered', () => {
    expect(inkShows(pixels(0, 1, 64, 127))).toBe(false);
    expect(inkShows(pixels(0, 128))).toBe(true);
    expect(inkShows(pixels(255))).toBe(true);
  });
});

describe('isInk', () => {
  // The one line the panel's check and the mask's black and white both draw.
  it('reads a pixel at least half covered as ink', () => {
    expect(isInk(127)).toBe(false);
    expect(isInk(128)).toBe(true);
  });
});
