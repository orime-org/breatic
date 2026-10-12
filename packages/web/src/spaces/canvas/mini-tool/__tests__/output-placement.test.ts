// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { describe, expect, it } from 'vitest';

import type { MiniToolSpec } from '@breatic/shared/mini-tools';

import { NODE_STEP } from '@web/spaces/canvas/drop-layout';
import { outputPlacementOf } from '@web/spaces/canvas/mini-tool/output-placement';

const base = {
  source: 'image',
  labelKey: 'x',
  guide: 'x',
  icon: 'Crop',
  slots: [],
  sourceParam: 'image',
  sourceMany: false,
} as const;

const SEPARATE: MiniToolSpec = {
  ...base,
  id: 'audio.fixed',
  run: { kind: 'browser' },
  params: [],
  outputs: [
    { modality: 'audio', namePrefix: 'VOCALS' },
    { modality: 'audio', namePrefix: 'BACKING' },
  ],
};

const SPLIT: MiniToolSpec = {
  ...base,
  id: 'video.split',
  source: 'video',
  run: { kind: 'container', op: 'cut' },
  params: [{ kind: 'list', key: 'cuts', item: { min: 0, max: 600, step: 0.1 }, maxItems: 4 }],
  output: { modality: 'video', namePrefix: 'PART' },
  outputCount: { kind: 'listLength', param: 'cuts', plus: 1 },
};

const GRID: MiniToolSpec = {
  ...base,
  id: 'image.grid',
  run: { kind: 'browser' },
  params: [
    { kind: 'number', key: 'rows', default: 3, min: 1, max: 8, step: 1 },
    { kind: 'number', key: 'cols', default: 3, min: 1, max: 8, step: 1 },
  ],
  output: { modality: 'image', namePrefix: 'GRID' },
  outputCount: { kind: 'product', params: ['rows', 'cols'] },
  outputLayout: 'grid',
  groupOutputs: true,
};

/** The gap the layout leaves between two nodes, room for the name row above the lower one. */
const GAP = 24;

/**
 * Tile sizes for cutting a picture into a grid, remainders on the last row and column.
 * @param w - Picture width.
 * @param h - Picture height.
 * @param rows - Rows.
 * @param cols - Columns.
 * @returns One size per tile, row by row.
 */
function tiles(w: number, h: number, rows: number, cols: number): { width: number; height: number }[] {
  const tw = Math.floor(w / cols);
  const th = Math.floor(h / rows);
  return Array.from({ length: rows * cols }, (_, i) => ({
    width: i % cols === cols - 1 ? w - tw * (cols - 1) : tw,
    height: Math.floor(i / cols) === rows - 1 ? h - th * (rows - 1) : th,
  }));
}

describe('outputPlacementOf', () => {
  it('keeps a fixed tool named and stacked as before', () => {
    const placed = outputPlacementOf(SEPARATE, {}, [], 'song');
    expect(placed.map((p) => p.name)).toEqual(['VOCALS-song', 'BACKING-song']);
    expect(placed.map((p) => [p.x, p.y])).toEqual([
      [0, 0],
      [0, NODE_STEP.y],
    ]);
  });

  it('numbers a variable tool without a layout and stacks it', () => {
    const placed = outputPlacementOf(SPLIT, { cuts: [5, 12] }, [], 'clip');
    expect(placed.map((p) => p.name)).toEqual(['PART-1-clip', 'PART-2-clip', 'PART-3-clip']);
    expect(placed.map((p) => p.x)).toEqual([0, 0, 0]);
    expect(placed.map((p) => p.y)).toEqual([0, NODE_STEP.y, 2 * NODE_STEP.y]);
  });

  it('falls back to the modality label when the source has no name', () => {
    expect(outputPlacementOf(SEPARATE, {}, [], undefined).map((p) => p.name)).toEqual([
      'VOCALS-Audio',
      'BACKING-Audio',
    ]);
  });

  it('names grid tiles by row and column and steps columns evenly', () => {
    const placed = outputPlacementOf(GRID, { rows: 2, cols: 3 }, tiles(600, 400, 2, 3), 'cat');
    expect(placed.map((p) => p.name)).toEqual([
      'GRID-r1c1-cat',
      'GRID-r1c2-cat',
      'GRID-r1c3-cat',
      'GRID-r2c1-cat',
      'GRID-r2c2-cat',
      'GRID-r2c3-cat',
    ]);
    expect(placed.slice(0, 3).map((p) => p.x)).toEqual([0, NODE_STEP.x, 2 * NODE_STEP.x]);
  });

  it('puts every tile of one row at the same y on an uneven cut', () => {
    const placed = outputPlacementOf(GRID, { rows: 8, cols: 8 }, tiles(500, 500, 8, 8), 'sq');
    for (let row = 0; row < 8; row++) {
      const ys = new Set(placed.slice(row * 8, row * 8 + 8).map((p) => p.y));
      expect(ys.size).toBe(1);
    }
  });

  it.each([
    ['square', 900, 900],
    ['portrait', 600, 1200],
    ['wide, one column', 1920, 1080],
  ])('leaves the gap between rows of a %s picture', (_label, w, h) => {
    const rows = w === 1920 ? 8 : 3;
    const cols = w === 1920 ? 1 : 3;
    const placed = outputPlacementOf(GRID, { rows, cols }, tiles(w, h, rows, cols), 'p');
    for (let row = 0; row < rows - 1; row++) {
      const here = placed.slice(row * cols, row * cols + cols);
      const next = placed[(row + 1) * cols]!;
      const bottom = Math.max(...here.map((p) => p.y + p.height));
      expect(next.y - bottom).toBe(GAP);
    }
  });

  it('measures a tile node as tall as its picture draws at the node width', () => {
    // 288 wide, 1px border each side, 4px inset each side: the picture is 278 wide.
    const [tile] = outputPlacementOf(GRID, { rows: 1, cols: 2 }, [{ width: 278, height: 139 }, { width: 278, height: 139 }], 'p');
    expect(tile!.width).toBe(288);
    expect(tile!.height).toBe(139 + 10);
  });
});
