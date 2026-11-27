// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-Breatic-Source-Available-2.0

/**
 * Part picture sizes read from file headers (inner#1693 design 3.5), for the eager appearance panel and its uploads and
 * for the lazy viewport alike; it loads no three.js, so opening a Project does not pull it in.
 */

import jpegFormat from 'probe-image-size/lib/formats/jpeg.js';
import pngFormat from 'probe-image-size/lib/formats/png.js';
import webpFormat from 'probe-image-size/lib/formats/webp.js';

import { httpRequest } from '@breatic/shared';

/** A picture's size and type as its file header declares them. */
export interface LookPictureSize {
  width: number;
  height: number;
  type: string;
}

/** The picture formats a part takes, each read by probe-image-size's push parser (inner#1693 design 3.5). */
const PICTURE_PARSERS = [['jpeg', jpegFormat.Parser], ['png', pngFormat.Parser], ['webp', webpFormat.Parser]] as const;


/**
 * A picture's size and type read from the start of its bytes, stopping as soon as they are known; the rest of the
 * stream is cancelled. A JPEG's segments before its frame header are skipped by length, never held, as libjpeg, Go and
 * Blink read headers, so the parsers hold a few bytes whatever the header's size; bytes other than 0xFF and 0xFF fill
 * bytes between segments are skipped, and a stuffed FF 00 there fails the JPEG parser. Bytes that are no picture's start
 * fail every parser at once; reading also ends after `maxBytes`.
 * @param stream - The file's or the response's bytes.
 * @param maxBytes - The most bytes read for one size (config/scene.yaml `import.max_picture_header_bytes`).
 * @returns The size and type, or null when the bytes are not a PNG, JPEG or WebP header within `maxBytes`.
 */
export async function readPictureSize(stream: ReadableStream<Uint8Array>, maxBytes: number): Promise<LookPictureSize | null> {
  const parsers = PICTURE_PARSERS.map(([type, Parser]) => ({ type, parser: new Parser() }));
  const reader = stream.getReader();
  let read = 0;
  try {
    while (read < maxBytes) {
      const { done, value } = await reader.read();
      if (done) return null;
      const chunk = value.subarray(0, maxBytes - read);
      read += chunk.length;
      let open = false;
      for (const { type, parser } of parsers) {
        if (parser.getStatus() !== 0) continue;
        parser.push(chunk);
        // A WebP parser keeps reading after the size for EXIF; the size is final once set.
        const size = parser.result;
        if (size) return size.width > 0 && size.height > 0 ? { width: size.width, height: size.height, type } : null;
        if (parser.getStatus() === 0) open = true;
      }
      if (!open) return null;
    }
    return null;
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

/** How picture sizes are reached: a picture's bytes as a stream. */
export interface LookPictureSizeDeps {
  /** The response body, read until the header is known. */
  open: (url: string) => Promise<ReadableStream<Uint8Array>>;
}

/** Header sizes of part pictures, cached per address for the page (a part stores its picture's address, inner#2171). */
export class LookPictureSizes {
  private readonly deps: LookPictureSizeDeps;
  private readonly sizes = new Map<string, Promise<LookPictureSize | null>>();

  /**
   * Take the transport.
   * @param deps - How pictures are reached.
   */
  constructor(deps: LookPictureSizeDeps) {
    this.deps = deps;
  }

  /**
   * A picture's size from its file header, stopping the download there.
   * @param url - The picture's address.
   * @param maxBytes - The most bytes read for the size.
   * @returns The size and type, or null when the bytes are not a picture header or the read failed.
   */
  size(url: string, maxBytes: number): Promise<LookPictureSize | null> {
    return this.read(url, maxBytes).catch(() => null);
  }

  /**
   * A picture's size from its file header, telling a read that failed apart from bytes that are not a picture.
   * @param url - The picture's address.
   * @param maxBytes - The most bytes read for the size.
   * @returns The size and type, or null when the bytes are not a picture header; a stored file never changes, so the
   * answer is kept.
   * @throws {Error} When the picture could not be reached or read; the failure is not kept, so a later read tries again.
   */
  read(url: string, maxBytes: number): Promise<LookPictureSize | null> {
    let pending = this.sizes.get(url);
    if (!pending) {
      const started = this.deps.open(url).then((stream) => readPictureSize(stream, maxBytes));
      pending = started;
      started.catch(() => { if (this.sizes.get(url) === started) this.sizes.delete(url); });
      this.sizes.set(url, pending);
    }
    return pending;
  }
}

/**
 * Fetch a picture.
 * @param url - Its URL.
 * @returns The response.
 * @throws {Error} When the request fails or answers an error.
 */
async function fetchLookPicture(url: string): Promise<Response> {
  const response = await httpRequest(url, { method: 'GET' }, { replaySafe: true });
  if (!response.ok) throw new Error(`Look picture request failed (${response.status})`);
  return response;
}

/** What the lazy viewport needs from the page to load part pictures. */
export interface LookPictureAccess {
  /** The page's picture sizes. */
  sizes: LookPictureSizes;
  /** A picture's whole file. */
  download: (url: string) => Promise<Blob>;
}

let pageAccess: LookPictureAccess | null = null;

/**
 * The page's way to part pictures, shared by every 3D Space and handed to the lazy viewport by the editor: a picture is
 * read by its address alone, so one page reads each address once.
 * @returns The sizes and the download.
 */
export function pageLookPictureAccess(): LookPictureAccess {
  pageAccess ??= {
    sizes: new LookPictureSizes({
      open: async (url) => {
        const body = (await fetchLookPicture(url)).body;
        if (!body) throw new Error('Look picture response has no body');
        return body;
      },
    }),
    download: async (url) => (await fetchLookPicture(url)).blob(),
  };
  return pageAccess;
}

/**
 * The page's picture sizes, the same instance the lazy viewport gets from `pageLookPictureAccess`.
 * @returns The sizes.
 */
export function pageLookPictureSizes(): LookPictureSizes {
  return pageLookPictureAccess().sizes;
}
