// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Which filter backend the picture adjust exports through (inner#1303 §4):
 * Fabric's shared WebGL backend draws on a fixed square, so a picture longer
 * than that square gets a backend of its own, up to what the graphics take.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { defaultAdjustValue } from '@breatic/shared';

import {
  ImageTooLargeError,
  assertCanExport,
  backendSides,
  drawAdjusted,
  drawableSide,
  exportBackendSide,
  liveSharedBackend,
  previewSourceOf,
  releaseBackend,
} from '@web/spaces/canvas/mini-tool/adjust-export';
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

/**
 * A WebGL context stub with a drawing buffer of a given side.
 * @param side - The buffer's side.
 * @param lost - Whether the context is lost.
 * @returns The stub.
 */
function liveGl(side: number, lost = false) {
  return { drawingBufferWidth: side, drawingBufferHeight: side, isContextLost: () => lost, deleteTexture: vi.fn() };
}

// The browser may give a WebGL canvas a smaller drawing buffer than asked
// (Chrome on this Mac: 8192 for 16384), and the last pass is cut to it.
describe('drawableSide', () => {
  it('is the drawing buffer when it is smaller than the backend square', () => {
    expect(drawableSide({ tileSize: 16384, gl: liveGl(8192) } as never)).toBe(8192);
  });

  it('is nothing on a lost context, or a WebGL backend that got none', () => {
    expect(drawableSide({ tileSize: 4096, gl: liveGl(4096, true) } as never)).toBe(0);
    expect(drawableSide({ tileSize: 4096 } as never)).toBe(0);
  });

  it('is unbounded without WebGL', () => {
    expect(drawableSide({ applyFilters: vi.fn() } as never)).toBe(Infinity);
  });
});

// A lost context stays lost (Khronos, "HandlingContextLost"); Fabric builds
// its shared backend once and hands the same one back, so a backend whose
// context is gone is made again and registered in its place.
describe('liveSharedBackend', () => {
  /**
   * Fabric's three backend calls over one held backend.
   * @param held - The backend Fabric holds.
   * @param made - What it would make next.
   * @returns The calls and what they did.
   */
  const registry = (held: object, made: object) => {
    let current = held;
    return {
      getFilterBackend: () => current as never,
      initFilterBackend: vi.fn(() => made as never),
      setFilterBackend: vi.fn((next: object) => {
        current = next;
      }),
      current: () => current,
    };
  };

  it('hands back the shared backend while its context is live', () => {
    const held = { tileSize: 4096, gl: liveGl(4096) };
    const fabric = registry(held, {});
    expect(liveSharedBackend(fabric)).toBe(held);
    expect(fabric.initFilterBackend).not.toHaveBeenCalled();
  });

  it('makes a new one, in Fabric’s place too, when the context is lost', () => {
    const made = { tileSize: 4096, gl: liveGl(4096) };
    const fabric = registry({ tileSize: 4096, gl: liveGl(4096, true) }, made);
    expect(liveSharedBackend(fabric)).toBe(made);
    expect(fabric.current()).toBe(made);
  });

  it('hands back a 2D backend as it is', () => {
    const held = { applyFilters: vi.fn() };
    expect(liveSharedBackend(registry(held, {}))).toBe(held);
  });
});

// The graphics' limit is read off the shared backend's own context, which
// answers the same as any other on this GPU.
describe('backendSides', () => {
  it('reads the texture limit off the shared backend', () => {
    const gl = { ...liveGl(4096), MAX_TEXTURE_SIZE: 3379, getParameter: (name: number) => (name === 3379 ? 16384 : 0) };
    expect(backendSides({ tileSize: 4096, gl } as never)).toEqual({ shared: 4096, max: 16384 });
  });

  it('is unbounded without WebGL', () => {
    expect(backendSides({ applyFilters: vi.fn() } as never)).toEqual({ shared: Infinity, max: Infinity });
  });
});

describe('assertCanExport', () => {
  it('says the picture is too large for a drawing buffer shorter than it', () => {
    expect(() => assertCanExport({ tileSize: 16384, gl: liveGl(8192) } as never, 9000)).toThrow(ImageTooLargeError);
  });

  // A lost context says nothing about the picture's size.
  it('does not call a backend with no context to draw with a size problem', () => {
    const lost = (): void => assertCanExport({ tileSize: 4096, gl: liveGl(4096, true) } as never, 100);
    expect(lost).toThrow(Error);
    expect(lost).not.toThrow(ImageTooLargeError);
  });

  it('lets a picture the backend can draw through', () => {
    expect(() => assertCanExport({ tileSize: 4096, gl: liveGl(4096) } as never, 4096)).not.toThrow();
  });
});

describe('releaseBackend', () => {
  it('gives back its WebGL context before letting it go', () => {
    const loseContext = vi.fn();
    const dispose = vi.fn();
    releaseBackend({ gl: { getExtension: () => ({ loseContext }) }, dispose } as never);
    expect(loseContext).toHaveBeenCalledOnce();
    expect(dispose).toHaveBeenCalledOnce();
  });
});

describe('drawAdjusted', () => {
  let context: { mockRestore: () => void } | undefined;
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
    const backend = { tileSize: 4096, gl: liveGl(4096), applyFilters: vi.fn() };
    const value = { ...defaultAdjustValue, sharpness: 50 };
    await drawAdjusted(picture(1000, 500), { width: 250, height: 125 }, value, document.createElement('canvas'), backend as never);
    expect(vi.mocked(adjustFilters)).toHaveBeenCalledWith(value, expect.any(Number), { width: 1000, height: 500 });
  });

  // Fabric keeps the source's texture when it is given no cache key; nothing
  // else deletes it.
  it('deletes the source texture each draw leaves behind', () => {
    const gl = liveGl(4096);
    const backend = { tileSize: 4096, gl, applyFilters: vi.fn(() => ({ originalTexture: 'source-texture' })) };
    const value = { ...defaultAdjustValue, sharpness: 50 };
    return drawAdjusted(picture(100, 50), { width: 100, height: 50 }, value, document.createElement('canvas'), backend as never).then(() => {
      expect(gl.deleteTexture).toHaveBeenCalledWith('source-texture');
    });
  });

  // The backend draws its last pass on a square of its tile size and cuts off
  // what is past it.
  it('draws no longer than the backend square, keeping the shape', async () => {
    const backend = { tileSize: 100, gl: liveGl(100), applyFilters: vi.fn() };
    const target = document.createElement('canvas');
    const value = { ...defaultAdjustValue, sharpness: 50 };
    await drawAdjusted(picture(1000, 500), { width: 400, height: 200 }, value, target, backend as never);
    expect([target.width, target.height]).toEqual([100, 50]);
    expect(backend.applyFilters).toHaveBeenCalledWith(expect.anything(), expect.anything(), 100, 50, target);
  });
});
