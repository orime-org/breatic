// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { miniToolById, type MiniToolSnapshot } from '@breatic/shared/mini-tools';

const exporter = vi.hoisted(() => ({
  exportCropBlob: vi.fn(() => Promise.resolve(new Blob(['c'], { type: 'image/png' }))),
  exportOrientedBlob: vi.fn(() => Promise.resolve(new Blob(['o'], { type: 'image/png' }))),
}));
vi.mock('@web/spaces/canvas/focus/crop-export', async (original) => ({
  ...(await original<object>()),
  ...exporter,
}));

const grid = vi.hoisted(() => ({
  exportGridTiles: vi.fn(() =>
    Promise.resolve([
      { blob: new Blob(['a'], { type: 'image/png' }), width: 50, height: 40 },
      { blob: new Blob(['b'], { type: 'image/png' }), width: 51, height: 40 },
    ]),
  ),
}));
const adjust = vi.hoisted(() => ({
  exportAdjustedBlob: vi.fn(() => Promise.resolve(new Blob(['j'], { type: 'image/png' }))),
}));
vi.mock('@web/spaces/canvas/mini-tool/adjust-export', () => adjust);
const mark = vi.hoisted(() => ({
  exportMarkBlob: vi.fn(() => Promise.resolve(new Blob(['m'], { type: 'image/png' }))),
}));
vi.mock('@web/spaces/canvas/mini-tool/mark-export', () => mark);
vi.mock('@web/spaces/canvas/mini-tool/grid-export', async (original) => ({
  ...(await original<object>()),
  ...grid,
}));

import { orientedSize } from '@web/spaces/canvas/focus/crop-export';
import { exportMiniToolFile } from '@web/spaces/canvas/mini-tool/export-mini-tool-file';

/**
 * A snapshot of an image source with these params.
 * @param params - The tool's params.
 * @returns The snapshot.
 */
function snapshot(params: Record<string, unknown>): MiniToolSnapshot {
  return { params, prompt: '', source: { url: 'https://cdn/a.jpg' }, slots: {} };
}

beforeEach(() => vi.clearAllMocks());

describe('exportMiniToolFile', () => {
  it('crops to the rectangle in source pixels', async () => {
    const [made, ...rest] = await exportMiniToolFile(
      miniToolById('image.crop')!,
      snapshot({ aspect: 'free', rect: { x: 10, y: 20, w: 300, h: 200 } }),
    );
    const file = made!.file;
    expect(rest).toEqual([]);
    expect(exporter.exportCropBlob).toHaveBeenCalledWith(
      { url: 'https://cdn/a.jpg', timeSeconds: null },
      { x: 10, y: 20, width: 300, height: 200 },
    );
    expect(file.type).toBe('image/png');
    expect(file.name).toMatch(/\.png$/);
  });

  it('keeps the whole picture when no rectangle was set', async () => {
    await exportMiniToolFile(miniToolById('image.crop')!, snapshot({ aspect: 'free', rect: null }));
    expect(exporter.exportOrientedBlob).toHaveBeenCalledWith(
      { url: 'https://cdn/a.jpg', timeSeconds: null },
      { turns: 0, flipX: false, flipY: false },
    );
  });

  it('draws the turns and flips', async () => {
    const orient = { turns: 1, flipX: true, flipY: false };
    await exportMiniToolFile(miniToolById('image.rotate')!, snapshot({ orient }));
    expect(exporter.exportOrientedBlob).toHaveBeenCalledWith({ url: 'https://cdn/a.jpg', timeSeconds: null }, orient);
  });
});

describe('exportMiniToolFile for a grid', () => {
  it('exports one PNG per tile, cut by the rows and columns asked', async () => {
    const made = await exportMiniToolFile(miniToolById('image.grid')!, snapshot({ rows: 1, cols: 2 }));

    expect(grid.exportGridTiles).toHaveBeenCalledWith({ url: 'https://cdn/a.jpg', timeSeconds: null }, 1, 2, [0, 1]);
    expect(made.map((tile) => tile.file.type)).toEqual(['image/png', 'image/png']);
  });

  it('cuts by the default rows and columns when the draft left them out', async () => {
    await exportMiniToolFile(miniToolById('image.grid')!, snapshot({}));

    expect(grid.exportGridTiles).toHaveBeenCalledWith(
      { url: 'https://cdn/a.jpg', timeSeconds: null },
      3,
      3,
      [0, 1, 2, 3, 4, 5, 6, 7, 8],
    );
  });

  it('cuts only the picked tiles, row by row', async () => {
    await exportMiniToolFile(miniToolById('image.grid')!, snapshot({ rows: 3, cols: 3, skip: [0, 2, 3, 4, 7, 8] }));

    expect(grid.exportGridTiles).toHaveBeenCalledWith({ url: 'https://cdn/a.jpg', timeSeconds: null }, 3, 3, [1, 5, 6]);
  });
});

describe('exportMiniToolFile for a picture adjust', () => {
  it('exports the picture through the adjust at its own resolution', async () => {
    const made = await exportMiniToolFile(miniToolById('image.adjust')!, snapshot({ value: { exposure: 30 } }));

    expect(adjust.exportAdjustedBlob).toHaveBeenCalledWith(
      { url: 'https://cdn/a.jpg', timeSeconds: null },
      expect.objectContaining({ exposure: 30, contrast: 0 }),
    );
    expect(made.map((tile) => tile.file.name)).toEqual(['ADJUST.png']);
  });
});

describe('exportMiniToolFile for markup', () => {
  const objects = [{ id: 'r', kind: 'rect', color: '#FF3B30', size: 5, x: 0.1, y: 0.1, w: 0.2, h: 0.2 }] as const;

  it('draws the objects copied out at the press onto the picture at its own resolution', async () => {
    const made = await exportMiniToolFile(miniToolById('image.mark')!, snapshot({}), { kind: 'mark', objects });

    expect(mark.exportMarkBlob).toHaveBeenCalledWith({ url: 'https://cdn/a.jpg', timeSeconds: null }, objects);
    expect(made.map((file) => file.file.name)).toEqual(['MARK.png']);
  });

  it('refuses without the objects copied out at the press', async () => {
    await expect(exportMiniToolFile(miniToolById('image.mark')!, snapshot({}))).rejects.toThrow();
    expect(mark.exportMarkBlob).not.toHaveBeenCalled();
  });
});

describe('orientedSize', () => {
  it('swaps the sides on a quarter turn, not on a half', () => {
    expect(orientedSize(1600, 1000, 1)).toEqual({ width: 1000, height: 1600 });
    expect(orientedSize(1600, 1000, 2)).toEqual({ width: 1600, height: 1000 });
    expect(orientedSize(1600, 1000, 3)).toEqual({ width: 1000, height: 1600 });
  });
});
