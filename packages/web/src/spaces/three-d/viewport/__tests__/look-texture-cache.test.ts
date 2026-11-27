// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-Breatic-Source-Available-2.0

/**
 * Part pictures (inner#1693 design 5.3): decoded only once usable, one clone per part, released by reference count.
 */

import { Texture } from 'three';
import { describe, expect, it, vi } from 'vitest';

import * as cacheModule from '@web/spaces/three-d/viewport/look-texture-cache';
import * as sizeModule from '@web/spaces/three-d/look-picture-size';

const A = 'https://assets.example.test/a.png';

/** A PNG header for a picture of this size: signature, IHDR length, type, width, height. */
function pngHeader(width: number, height: number): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(33);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
  new DataView(bytes.buffer).setUint32(16, width);
  new DataView(bytes.buffer).setUint32(20, height);
  return bytes;
}

interface Deps {
  open: ReturnType<typeof vi.fn>;
  download: ReturnType<typeof vi.fn>;
  decode: ReturnType<typeof vi.fn>;
}

/** Dependencies whose stream and download serve a PNG header. */
function deps(width = 512, height = 256): Deps {
  const stream = (): ReadableStream<Uint8Array> => new ReadableStream({
    pull(controller) { controller.enqueue(pngHeader(width, height)); },
  });
  return {
    open: vi.fn(async () => stream()),
    download: vi.fn(async () => new Blob([pngHeader(width, height)], { type: 'image/png' })),
    decode: vi.fn(async () => ({ width, height, close: vi.fn() })),
  };
}

type Cache = {
  acquire: (url: string, maxEdge?: number) => Promise<Texture>;
  release: (url: string, clone: Texture) => void;
};

/**
 * A cache over these dependencies.
 * @param d - The dependencies.
 * @returns The cache.
 * @throws {AssertionError} When LookTextureCache is not exported.
 */
function create(d: Deps): Cache {
  const Ctor = (cacheModule as Record<string, unknown>).LookTextureCache as (new (deps: unknown) => Cache) | undefined;
  expect(Ctor, 'LookTextureCache must be exported').toBeTypeOf('function');
  // The page's header sizes come in beside the transport, as the editor hands them to the viewport.
  const sizes = new sizeModule.LookPictureSizes({ open: d.open });
  return new Ctor!({ sizes, download: d.download, decode: d.decode });
}

describe('LookTextureCache', () => {
  it('decodes with premultiplied alpha off and the file orientation, once per picture', async () => {
    const d = deps();
    const cache = create(d);
    const first = await cache.acquire(A);
    const second = await cache.acquire(A);
    expect(d.decode).toHaveBeenCalledTimes(1);
    expect(d.decode.mock.calls[0]?.[1]).toEqual({ premultiplyAlpha: 'none', imageOrientation: 'from-image' });
    expect(first).not.toBe(second);
    expect(first.source).toBe(second.source);
    expect(first.flipY).toBe(false);
    expect(first.wrapS).toBe(1000);
  });

  it('scales a picture whose shown longest edge is over the limit from its decoded, oriented copy', async () => {
    const d = deps(9000, 100);
    const oriented = { width: 100, height: 9000, close: vi.fn() };
    const scaled = { width: 91, height: 8192, close: vi.fn() };
    d.decode.mockResolvedValueOnce(oriented).mockResolvedValueOnce(scaled);
    const texture = await create(d).acquire(A, 8192);
    expect(d.decode).toHaveBeenCalledTimes(2);
    expect(d.decode.mock.calls[0]?.[1]).toEqual({ premultiplyAlpha: 'none', imageOrientation: 'from-image' });
    expect(d.decode.mock.calls[1]?.[0]).toBe(oriented);
    expect(d.decode.mock.calls[1]?.[1]).toEqual({ premultiplyAlpha: 'none', resizeWidth: 91, resizeHeight: 8192, resizeQuality: 'high' });
    expect(oriented.close).toHaveBeenCalledTimes(1);
    expect(texture.image).toBe(scaled);
  });

  it('keeps a picture within the limit as decoded', async () => {
    const d = deps(512, 256);
    await create(d).acquire(A, 8192);
    expect(d.decode).toHaveBeenCalledTimes(1);
  });

  it('closes the oriented copy when scaling it fails', async () => {
    const d = deps(9000, 100);
    const oriented = { width: 9000, height: 100, close: vi.fn() };
    d.decode.mockResolvedValueOnce(oriented).mockRejectedValueOnce(new Error('scale failed'));
    await expect(create(d).acquire(A, 8192)).rejects.toThrow('scale failed');
    expect(oriented.close).toHaveBeenCalledTimes(1);
  });

  it('disposes each part clone on release and closes the picture after the last one', async () => {
    const d = deps();
    const cache = create(d);
    const first = await cache.acquire(A);
    const second = await cache.acquire(A);
    const disposed: Texture[] = [];
    first.addEventListener('dispose', () => disposed.push(first));
    second.addEventListener('dispose', () => disposed.push(second));
    const bitmap = await d.decode.mock.results[0]!.value as { close: ReturnType<typeof vi.fn> };
    cache.release(A, first);
    expect(disposed).toEqual([first]);
    expect(bitmap.close).not.toHaveBeenCalled();
    cache.release(A, second);
    expect(disposed).toEqual([first, second]);
    expect(bitmap.close).toHaveBeenCalledTimes(1);
  });

  it('downloads again for a new acquire after the picture was closed', async () => {
    const d = deps();
    const cache = create(d);
    const clone = await cache.acquire(A);
    cache.release(A, clone);
    await cache.acquire(A);
    expect(d.decode).toHaveBeenCalledTimes(2);
    expect(d.open).toHaveBeenCalledTimes(0);
  });
});

describe('pageLookTextureCache (inner#2171 implementation round 3)', () => {
  it('gives one access one cache, and another access its own', () => {
    const access = (): sizeModule.LookPictureAccess => ({
      sizes: new sizeModule.LookPictureSizes({ open: async () => new ReadableStream() }),
      download: async () => new Blob(),
    });
    const page = access();
    const other = access();
    const cache = cacheModule.pageLookTextureCache(page);
    expect(cacheModule.pageLookTextureCache(page)).toBe(cache);
    expect(cacheModule.pageLookTextureCache(other)).not.toBe(cache);
  });
});
