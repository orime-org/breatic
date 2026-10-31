// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { describe, expect, it } from 'vitest';

import { miniToolById, type MiniToolSpec } from '@breatic/shared/mini-tools';

import { NODE_STEP } from '@web/spaces/canvas/drop-layout';
import { MEDIA_FRAME_PX, PLANNED_BODY_MIN_PX, mediaNodeHeight } from '@web/spaces/canvas/group-geometry';
import { outputPlacementOf, plannedOutputSizes } from '@web/spaces/canvas/mini-tool/output-placement';

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

describe('outputPlacementOf for picked tiles', () => {
  const PICKING = miniToolById('image.grid')!;
  /**
   * Every cell index of a grid except the ones listed.
   * @param total - Cells in the grid.
   * @param picked - The cells kept.
   * @returns The cells skipped.
   */
  const skipAllBut = (total: number, picked: number[]): number[] =>
    Array.from({ length: total }, (_, i) => i).filter((i) => !picked.includes(i));

  it('gives each picked tile the name, column and row of its own cell', () => {
    const sizes = tiles(900, 900, 3, 3);
    const placed = outputPlacementOf(PICKING, { rows: 3, cols: 3, skip: skipAllBut(9, [1, 5, 6]) }, sizes, 'cat');
    expect(placed.map((p) => p.name)).toEqual(['GRID-r1c2-cat', 'GRID-r2c3-cat', 'GRID-r3c1-cat']);
    expect(placed.map((p) => p.x)).toEqual([NODE_STEP.x, 2 * NODE_STEP.x, 0]);
    const full = outputPlacementOf(PICKING, { rows: 3, cols: 3, skip: [] }, sizes, 'cat');
    expect(placed.map((p) => p.y)).toEqual([full[1]!.y, full[5]!.y, full[6]!.y]);
    expect(placed.map((p) => p.height)).toEqual([full[1]!.height, full[5]!.height, full[6]!.height]);
  });

  it('closes up leading empty rows and columns and keeps an empty row between picked ones', () => {
    // 4 rows by 2 columns; rows 2 and 4 picked in the second column only.
    const sizes = tiles(400, 1600, 4, 2);
    const placed = outputPlacementOf(PICKING, { rows: 4, cols: 2, skip: skipAllBut(8, [3, 7]) }, sizes, 'p');
    const full = outputPlacementOf(PICKING, { rows: 4, cols: 2, skip: [] }, sizes, 'p');
    expect(placed.map((p) => p.name)).toEqual(['GRID-r2c2-p', 'GRID-r4c2-p']);
    expect(placed.map((p) => p.x)).toEqual([0, 0]);
    expect(placed[0]!.y).toBe(0);
    expect(placed[1]!.y).toBe(full[7]!.y - full[3]!.y);
  });

  it('places one picked tile at the batch origin', () => {
    const placed = outputPlacementOf(PICKING, { rows: 3, cols: 3, skip: skipAllBut(9, [4]) }, tiles(900, 900, 3, 3), 'c');
    expect(placed.map((p) => [p.name, p.x, p.y])).toEqual([['GRID-r2c2-c', 0, 0]]);
  });

  it('plans a size for every cell of the grid, picked or not', () => {
    expect(plannedOutputSizes(PICKING, { rows: 3, cols: 3, skip: [0, 1] }, { width: 900, height: 900 })).toHaveLength(9);
  });
});


// §6.7: a tool that redraws the picture over itself at its own size plans its
// result at the source's size, so its node is laid out and framed as tall as
// it will be.
describe('plannedOutputSizes for a result the size of its source', () => {
  const SOURCE = { width: 1600, height: 1000 };

  it.each(['image.adjust', 'image.mark'])('plans %s at the source’s size', (id) => {
    expect(plannedOutputSizes(miniToolById(id)!, {}, SOURCE)).toEqual([SOURCE]);
  });

  it.each(['image.crop', 'image.expand', 'image.upscale', 'video.adjust'])('plans nothing for %s, whose result size is not the source’s', (id) => {
    expect(plannedOutputSizes(miniToolById(id)!, {}, SOURCE)).toEqual([]);
  });

  it('plans nothing while the source’s size is not known', () => {
    expect(plannedOutputSizes(miniToolById('image.adjust')!, {}, {})).toEqual([]);
  });
});

// A planned result too flat for its placeholder is laid out at the height the
// placeholder needs, so the failure line and the peer line are seen (§6.7).
describe('outputPlacementOf for a flat planned result', () => {
  it('lays a result out no shorter than its waiting body needs', () => {
    const [placed] = outputPlacementOf(miniToolById('image.adjust')!, {}, [{ width: 1920, height: 135 }], 'a');
    expect(placed?.height).toBe(PLANNED_BODY_MIN_PX + MEDIA_FRAME_PX);
  });

  it('lays a taller result out at its own height', () => {
    const [placed] = outputPlacementOf(miniToolById('image.adjust')!, {}, [{ width: 400, height: 300 }], 'a');
    expect(placed?.height).toBe(mediaNodeHeight(400, 300));
  });
});
