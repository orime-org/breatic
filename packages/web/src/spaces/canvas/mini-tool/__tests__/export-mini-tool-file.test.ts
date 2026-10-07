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
    const file = await exportMiniToolFile(
      miniToolById('image.crop')!,
      snapshot({ aspect: 'free', rect: { x: 10, y: 20, w: 300, h: 200 } }),
    );
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

describe('orientedSize', () => {
  it('swaps the sides on a quarter turn, not on a half', () => {
    expect(orientedSize(1600, 1000, 1)).toEqual({ width: 1000, height: 1600 });
    expect(orientedSize(1600, 1000, 2)).toEqual({ width: 1600, height: 1000 });
    expect(orientedSize(1600, 1000, 3)).toEqual({ width: 1000, height: 1600 });
  });
});
