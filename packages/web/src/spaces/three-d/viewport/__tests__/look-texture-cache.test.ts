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
  acquire: (assetId: string) => Promise<Texture>;
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
