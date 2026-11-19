// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Part pictures (inner#1693 design 5.3): sizes read from file headers and cached per asset,
 * decoded only once usable, one clone per part, released by reference count.
 */

import { Texture } from 'three';
import { describe, expect, it, vi } from 'vitest';

import * as cacheModule from '@web/spaces/three-d/viewport/look-texture-cache';

const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

/** A PNG header for a picture of this size: signature, IHDR length, type, width, height. */
function pngHeader(width: number, height: number): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(33);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
  new DataView(bytes.buffer).setUint32(16, width);
  new DataView(bytes.buffer).setUint32(20, height);
  return bytes;
}

interface Deps {
  resolve: ReturnType<typeof vi.fn>;
  open: ReturnType<typeof vi.fn>;
  download: ReturnType<typeof vi.fn>;
  decode: ReturnType<typeof vi.fn>;
}

/** Dependencies whose stream serves a PNG header and records whether it was cancelled. */
function deps(width = 512, height = 256): Deps & { cancelled: () => boolean } {
  let cancelled = false;
  const stream = (): ReadableStream<Uint8Array> => new ReadableStream({
    pull(controller) { controller.enqueue(pngHeader(width, height)); },
    cancel() { cancelled = true; },
  });
  return {
    resolve: vi.fn(async () => 'https://assets.example.test/a.png'),
    open: vi.fn(async () => stream()),
    download: vi.fn(async () => new Blob([pngHeader(width, height)], { type: 'image/png' })),
    decode: vi.fn(async () => ({ width, height, close: vi.fn() })),
    cancelled: () => cancelled,
  };
}

type Cache = {
  size: (assetId: string) => Promise<{ width: number; height: number; type: string } | null>;
  read: (assetId: string) => Promise<{ width: number; height: number; type: string } | null>;
  acquire: (assetId: string, maxEdge?: number) => Promise<Texture>;
  release: (assetId: string, clone: Texture) => void;
};

/**
 * A cache over these dependencies.
 * @param d - The dependencies.
 * @returns The cache.
 * @throws {AssertionError} When LookTextureCache is not exported.
 */
function create(d: Deps): Cache {
  const Ctor = (cacheModule as Record<string, unknown>).LookTextureCache as (new (deps: Deps) => Cache) | undefined;
  expect(Ctor, 'LookTextureCache must be exported').toBeTypeOf('function');
  return new Ctor!(d);
}

describe('LookTextureCache', () => {
  it('reads a size from the file header, stops the download there and caches it per asset', async () => {
    const d = deps(512, 256);
    const cache = create(d);
    expect(await cache.size(A)).toEqual({ width: 512, height: 256, type: 'png' });
    expect(d.cancelled()).toBe(true);
    expect(await cache.size(A)).toEqual({ width: 512, height: 256, type: 'png' });
    expect(d.open).toHaveBeenCalledTimes(1);
    expect(d.download).not.toHaveBeenCalled();
    expect(d.decode).not.toHaveBeenCalled();
  });

  it('answers null for a header it cannot read', async () => {
    const d = deps();
    d.open.mockResolvedValue(new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array([1, 2, 3])); controller.close(); } }));
    expect(await create(d).size(A)).toBeNull();
  });

  it('rejects a read that failed and reads again next time', async () => {
    const d = deps(512, 256);
    d.open.mockRejectedValueOnce(new Error('network'));
    const cache = create(d);
    await expect(cache.read(A)).rejects.toThrow('network');
    expect(await cache.read(A)).toEqual({ width: 512, height: 256, type: 'png' });
    expect(d.open).toHaveBeenCalledTimes(2);
  });

  it('decodes with premultiplied alpha off and the file orientation, once per asset', async () => {
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

describe('readPictureSize', () => {
  /**
   * A stream handing out the given chunks, counting the bytes pulled.
   * @param chunks - What it hands out, in order; a function makes an endless stream.
   * @returns The stream and the count.
   */
  function streamOf(chunks: Uint8Array[] | (() => Uint8Array)): { stream: ReadableStream<Uint8Array>; pulled: () => number } {
    let pulled = 0; let index = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        const next = typeof chunks === 'function' ? chunks() : chunks[index++];
        if (!next) { controller.close(); return; }
        pulled += next.length;
        controller.enqueue(next);
      },
    });
    return { stream, pulled: () => pulled };
  }
  const read = (): ((stream: ReadableStream<Uint8Array>) => Promise<{ width: number; height: number; type: string } | null>) => {
    const candidate = (cacheModule as Record<string, unknown>).readPictureSize;
    expect(candidate, 'readPictureSize must be exported').toBeTypeOf('function');
    return candidate as never;
  };

  it('reads a JPEG whose metadata before its size runs past half a megabyte', async () => {
    const segment = (length: number): number[] => [0xff, 0xe2, (length + 2) >> 8, (length + 2) & 0xff, ...new Array<number>(length).fill(0)];
    const bytes = [0xff, 0xd8];
    for (let i = 0; i < 10; i++) bytes.push(...segment(60_000));
    bytes.push(0xff, 0xc0, 0x00, 0x11, 0x08, 0x02, 0x58, 0x03, 0x20, 0x03, 0x01, 0x22, 0x00, 0x02, 0x11, 0x01, 0x03, 0x11, 0x01);
    const all = new Uint8Array(bytes);
    const chunks = Array.from({ length: Math.ceil(all.length / 65_536) }, (_, i) => all.subarray(i * 65_536, (i + 1) * 65_536));
    expect(await read()(streamOf(chunks).stream)).toMatchObject({ width: 800, height: 600, type: 'jpeg' });
  });

  it('reads a JPEG whose metadata before its size runs past the header budget', async () => {
    const segment = (length: number): number[] => [0xff, 0xe1, (length + 2) >> 8, (length + 2) & 0xff, ...new Array<number>(length).fill(0)];
    const bytes = [0xff, 0xd8];
    // About 6 MiB of metadata segments, as an editor's history can leave in front of the frame header.
    for (let i = 0; i < 105; i++) bytes.push(...segment(60_000));
    bytes.push(0xff, 0xc0, 0x00, 0x11, 0x08, 0x02, 0x58, 0x03, 0x20, 0x03, 0x01, 0x22, 0x00, 0x02, 0x11, 0x01, 0x03, 0x11, 0x01);
    const all = new Uint8Array(bytes);
    const chunks = Array.from({ length: Math.ceil(all.length / 100_000) }, (_, i) => all.subarray(i * 100_000, (i + 1) * 100_000));
    expect(await read()(streamOf(chunks).stream)).toMatchObject({ width: 800, height: 600, type: 'jpeg' });
  });

  it('stops reading a stream that is not a picture after a bounded amount', async () => {
    const endless = streamOf(() => new Uint8Array(65_536).fill(7));
    expect(await read()(endless.stream)).toBeNull();
    expect(endless.pulled()).toBeLessThanOrEqual(8 * 1024 * 1024);
  });
});
