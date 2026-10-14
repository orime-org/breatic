// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Which filter backend the picture adjust exports through (inner#1303 §4):
 * Fabric's shared WebGL backend draws on a fixed square, so a picture longer
 * than that square gets a backend of its own, up to what the graphics take.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { defaultAdjustValue } from '@breatic/shared';

import { drawAdjusted, exportBackendSide, previewSourceOf } from '@web/spaces/canvas/mini-tool/adjust-export';
import { adjustFilters } from '@web/spaces/canvas/mini-tool/adjust-filters';

vi.mock('@web/spaces/canvas/mini-tool/adjust-filters', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@web/spaces/canvas/mini-tool/adjust-filters')>();
  return { ...actual, adjustFilters: vi.fn(actual.adjustFilters) };
});

describe('exportBackendSide', () => {
  it('uses the shared backend for a picture that fits its square', () => {
    expect(exportBackendSide(4096, { shared: 4096, max: 16384 })).toBe('shared');
  });

  it('asks for a backend as long as a picture past the shared square', () => {
    expect(exportBackendSide(6000, { shared: 4096, max: 16384 })).toBe(6000);
  });

  it('refuses a picture past what the graphics take', () => {
    expect(exportBackendSide(16385, { shared: 4096, max: 16384 })).toBe('tooLarge');
  });

  it('uses the shared backend whatever the size when it filters without WebGL', () => {
    expect(exportBackendSide(20000, { shared: Infinity, max: Infinity })).toBe('shared');
  });
});

/**
 * A loaded picture of a given size.
 * @param width - Its natural width.
 * @param height - Its natural height.
 * @returns The element.
 */
function picture(width: number, height: number): HTMLImageElement {
  const el = new Image();
  Object.defineProperty(el, 'naturalWidth', { value: width });
  Object.defineProperty(el, 'naturalHeight', { value: height });
  return el;
}

// The preview filters a copy at its own size, scaled with smoothing: the
// filters sample by nearest neighbour, so a full-size source drawn into a
// small viewport keeps every Nth pixel and loses the rest (round 2, R5).
describe('previewSourceOf', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('scales a picture larger than the preview down to the preview size, smoothly', () => {
    const drawImage = vi.fn();
    const context = { drawImage, imageSmoothingEnabled: false, imageSmoothingQuality: 'low' };
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(context as never);
    const el = picture(2048, 64);
    const copy = previewSourceOf(el, { width: 512, height: 16 }) as HTMLCanvasElement;
    expect([copy.width, copy.height]).toEqual([512, 16]);
    expect(drawImage).toHaveBeenCalledWith(el, 0, 0, 512, 16);
    expect(context).toMatchObject({ imageSmoothingEnabled: true, imageSmoothingQuality: 'high' });
  });

  it('scales a picture once per preview size', () => {
    const drawImage = vi.fn();
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({ drawImage } as never);
    const el = picture(2048, 64);
    const first = previewSourceOf(el, { width: 512, height: 16 });
    expect(previewSourceOf(el, { width: 512, height: 16 })).toBe(first);
    expect(previewSourceOf(el, { width: 256, height: 8 })).not.toBe(first);
    expect(drawImage).toHaveBeenCalledTimes(2);
  });

  it('uses a picture no larger than the preview as it is', () => {
    const el = picture(400, 300);
    expect(previewSourceOf(el, { width: 400, height: 300 })).toBe(el);
  });
});

describe('drawAdjusted', () => {
  let context: ReturnType<typeof vi.spyOn> | undefined;
  beforeEach(() => {
    context = vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({ drawImage: vi.fn() } as never);
  });
  afterEach(() => {
    context?.mockRestore();
    vi.mocked(adjustFilters).mockClear();
  });

  // A smaller draw shows the source's effect scaled, so the filters are set
  // for the source's own pixels, not the draw's.
  it('sets the filters for the source picture at any draw size', async () => {
    const backend = { tileSize: 4096, applyFilters: vi.fn() };
    const value = { ...defaultAdjustValue, sharpness: 50 };
    await drawAdjusted(picture(1000, 500), { width: 250, height: 125 }, value, document.createElement('canvas'), backend as never);
    expect(vi.mocked(adjustFilters)).toHaveBeenCalledWith(value, expect.any(Number), { width: 1000, height: 500 });
  });

  // The backend draws its last pass on a square of its tile size and cuts off
  // what is past it.
  it('draws no longer than the backend square, keeping the shape', async () => {
    const backend = { tileSize: 100, applyFilters: vi.fn() };
    const target = document.createElement('canvas');
    const value = { ...defaultAdjustValue, sharpness: 50 };
    await drawAdjusted(picture(1000, 500), { width: 400, height: 200 }, value, target, backend as never);
    expect([target.width, target.height]).toEqual([100, 50]);
    expect(backend.applyFilters).toHaveBeenCalledWith(expect.anything(), expect.anything(), 100, 50, target);
  });
});
