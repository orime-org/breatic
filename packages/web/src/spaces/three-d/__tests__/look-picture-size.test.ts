// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-Breatic-Source-Available-2.0

/** Part picture sizes (inner#1693 design 3.5): read from file headers, cached per address, one set per Project. */

import { describe, expect, it, vi } from 'vitest';

import * as sizeModule from '@web/spaces/three-d/look-picture-size';

const CAP = 8 * 1024 * 1024;
const A = 'https://assets.example.test/a.png';

/** A PNG header for a picture of this size: signature, IHDR length, type, width, height. */
function pngHeader(width: number, height: number): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(33);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
  new DataView(bytes.buffer).setUint32(16, width);
  new DataView(bytes.buffer).setUint32(20, height);
  return bytes;
}

/** A stream serving a PNG header, recording whether the stream was cancelled. */
function deps(width = 512, height = 256): { open: ReturnType<typeof vi.fn>; cancelled: () => boolean } {
  let cancelled = false;
  const stream = (): ReadableStream<Uint8Array> => new ReadableStream({
    pull(controller) { controller.enqueue(pngHeader(width, height)); },
    cancel() { cancelled = true; },
  });
  return {
    open: vi.fn(async () => stream()),
    cancelled: () => cancelled,
  };
}

describe('LookPictureSizes', () => {
  it('reads a size from the file header, stops the download there and caches it per address', async () => {
    const d = deps(512, 256);
    const sizes = new sizeModule.LookPictureSizes(d);
    expect(await sizes.size(A, CAP)).toEqual({ width: 512, height: 256, type: 'png' });
    expect(d.cancelled()).toBe(true);
    expect(await sizes.size(A, CAP)).toEqual({ width: 512, height: 256, type: 'png' });
    expect(d.open).toHaveBeenCalledTimes(1);
  });

  it('answers null for a header it cannot read', async () => {
    const d = deps();
    d.open.mockResolvedValue(new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array([1, 2, 3])); controller.close(); } }));
    expect(await new sizeModule.LookPictureSizes(d).size(A, CAP)).toBeNull();
  });

  it('rejects a read that failed and reads again next time', async () => {
    const d = deps(512, 256);
    d.open.mockRejectedValueOnce(new Error('network'));
    const sizes = new sizeModule.LookPictureSizes(d);
    await expect(sizes.read(A, CAP)).rejects.toThrow('network');
    expect(await sizes.read(A, CAP)).toEqual({ width: 512, height: 256, type: 'png' });
    expect(d.open).toHaveBeenCalledTimes(2);
  });
});

describe('page picture access', () => {
  it('hands the panel and the lazy viewport the same sizes, so each address is read once on the page', () => {
    const access = sizeModule.pageLookPictureAccess();
    expect(sizeModule.pageLookPictureAccess()).toBe(access);
    expect(sizeModule.pageLookPictureSizes()).toBe(access.sizes);
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
  const read = (): ((stream: ReadableStream<Uint8Array>, maxBytes: number) => Promise<{ width: number; height: number; type: string } | null>) => {
    const candidate = (sizeModule as Record<string, unknown>).readPictureSize;
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
    expect(await read()(streamOf(chunks).stream, CAP)).toMatchObject({ width: 800, height: 600, type: 'jpeg' });
  });

  it('reads a JPEG whose metadata before its size runs to several MiB', async () => {
    const segment = (length: number): number[] => [0xff, 0xe1, (length + 2) >> 8, (length + 2) & 0xff, ...new Array<number>(length).fill(0)];
    const bytes = [0xff, 0xd8];
    // About 6 MiB of metadata segments, as an editor's history can leave in front of the frame header.
    for (let i = 0; i < 105; i++) bytes.push(...segment(60_000));
    bytes.push(0xff, 0xc0, 0x00, 0x11, 0x08, 0x02, 0x58, 0x03, 0x20, 0x03, 0x01, 0x22, 0x00, 0x02, 0x11, 0x01, 0x03, 0x11, 0x01);
    const all = new Uint8Array(bytes);
    const chunks = Array.from({ length: Math.ceil(all.length / 100_000) }, (_, i) => all.subarray(i * 100_000, (i + 1) * 100_000));
    expect(await read()(streamOf(chunks).stream, CAP)).toMatchObject({ width: 800, height: 600, type: 'jpeg' });
  });

  it.each([
    ['fill bytes', [0xff]],
    ['a stray byte', [0x00]],
    ['a TEM marker', [0xff, 0x01]],
  ])('reads a JPEG past the header budget with %s between its metadata segments', async (_name, between) => {
    const segment = (length: number): number[] => [0xff, 0xe1, (length + 2) >> 8, (length + 2) & 0xff, ...new Array<number>(length).fill(0)];
    const bytes = [0xff, 0xd8];
    for (let i = 0; i < 105; i++) bytes.push(...segment(60_000), ...(i % 10 === 9 ? between : []));
    bytes.push(0xff, 0xc0, 0x00, 0x11, 0x08, 0x01, 0x00, 0x02, 0x00, 0x03, 0x01, 0x22, 0x00, 0x02, 0x11, 0x01, 0x03, 0x11, 0x01);
    const all = new Uint8Array(bytes);
    const chunks = Array.from({ length: Math.ceil(all.length / 65_536) }, (_, i) => all.subarray(i * 65_536, (i + 1) * 65_536));
    expect(await read()(streamOf(chunks).stream, CAP)).toMatchObject({ width: 512, height: 256, type: 'jpeg' });
  });

  it('reads a header that ends at the byte limit and refuses one that ends a byte past it', async () => {
    const bytes = new Uint8Array([0xff, 0xd8, 0xff, 0xe1, 0x00, 0x0a, ...new Array<number>(8).fill(0),
      0xff, 0xc0, 0x00, 0x11, 0x08, 0x01, 0x00, 0x02, 0x00, 0x03, 0x01, 0x22, 0x00, 0x02, 0x11, 0x01, 0x03, 0x11, 0x01]);
    // The frame header's size fields end 7 bytes into the SOF segment.
    const end = 14 + 9;
    expect(await read()(streamOf([bytes]).stream, end)).toMatchObject({ width: 512, height: 256, type: 'jpeg' });
    expect(await read()(streamOf([bytes]).stream, end - 1)).toBeNull();
  });

  it.each([
    // Metadata without an end runs to the cap; a scan before the frame header fails the parser at once.
    ['metadata that never reaches a frame header', [0xff, 0xd8, 0xff, 0xe1, 0x00, 0x10, ...new Array<number>(14).fill(0)], CAP + 65_536],
    ['a scan before any frame header', [0xff, 0xd8, 0xff, 0xda, 0x00, 0x02], 2 * 65_536],
  ] as const)('stops reading a JPEG start with %s after a bounded amount', async (_name, start, most) => {
    let first = true;
    const stream = streamOf(() => {
      if (!first) return new Uint8Array(65_536).fill(7);
      first = false;
      return new Uint8Array(start);
    });
    expect(await read()(stream.stream, CAP)).toBeNull();
    expect(stream.pulled()).toBeLessThanOrEqual(most);
  });

  it('reads a WebP size once its image chunk header arrives, without reading on to the end', async () => {
    const header = new Uint8Array([0x52, 0x49, 0x46, 0x46, 0xff, 0xff, 0xff, 0x0f, 0x57, 0x45, 0x42, 0x50,
      0x56, 0x50, 0x38, 0x4c, 0x05, 0x00, 0x00, 0x00, 0x2f, 0x3f, 0xc0, 0x07, 0x00]);
    let first = true;
    const stream = streamOf(() => {
      if (!first) return new Uint8Array(65_536);
      first = false;
      return header;
    });
    expect(await read()(stream.stream, CAP)).toEqual({ width: 64, height: 32, type: 'webp' });
    expect(stream.pulled()).toBeLessThanOrEqual(header.length + 65_536);
  });

  it('takes a header that declares no pixels as no picture', async () => {
    const header = new Uint8Array(24);
    header.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
    new DataView(header.buffer).setUint32(16, 0);
    new DataView(header.buffer).setUint32(20, 64);
    expect(await read()(streamOf([header]).stream, CAP)).toBeNull();
  });

  it('stops reading a stream that is not a picture after its first chunk', async () => {
    const endless = streamOf(() => new Uint8Array(65_536).fill(7));
    expect(await read()(endless.stream, CAP)).toBeNull();
    // Bytes that are no picture's start fail every parser at once; one more chunk may already be queued.
    expect(endless.pulled()).toBeLessThanOrEqual(2 * 65_536);
  });
});
