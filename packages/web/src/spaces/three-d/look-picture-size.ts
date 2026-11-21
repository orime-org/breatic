// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Part picture sizes read from file headers (inner#1693 design 3.5), for the eager appearance panel and its uploads and
 * for the lazy viewport alike; it loads no three.js, so opening a Project does not pull it in.
 */

import jpegFormat from 'probe-image-size/lib/formats/jpeg.js';
import pngFormat from 'probe-image-size/lib/formats/png.js';
import webpFormat from 'probe-image-size/lib/formats/webp.js';

import { httpRequest, isSceneLookImageMediaType } from '@breatic/shared';

import { resolveSceneAsset } from '@web/data/api/scene';

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

/** How picture sizes are reached: the asset's URL and its bytes as a stream. */
export interface LookPictureSizeDeps {
  /** The registered URL of a picture asset. */
  resolve: (assetId: string) => Promise<string>;
  /** The response body, read until the header is known. */
  open: (url: string) => Promise<ReadableStream<Uint8Array>>;
}

/** Header sizes of part pictures, cached per asset for the page. */
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
   * @param assetId - The picture asset.
   * @param maxBytes - The most bytes read for the size.
   * @returns The size and type, or null when the bytes are not a picture header or the read failed.
   */
  size(assetId: string, maxBytes: number): Promise<LookPictureSize | null> {
    return this.read(assetId, maxBytes).catch(() => null);
  }

  /**
   * A picture's size from its file header, telling a read that failed apart from bytes that are not a picture.
   * @param assetId - The picture asset.
   * @param maxBytes - The most bytes read for the size.
   * @returns The size and type, or null when the bytes are not a picture header; an asset's content never changes, so
   * the answer is kept.
   * @throws {Error} When the picture could not be reached or read; the failure is not kept, so a later read tries again.
   */
  read(assetId: string, maxBytes: number): Promise<LookPictureSize | null> {
    let pending = this.sizes.get(assetId);
    if (!pending) {
      const started = this.deps.resolve(assetId)
        .then((url) => this.deps.open(url))
        .then((stream) => readPictureSize(stream, maxBytes));
      pending = started;
      started.catch(() => { if (this.sizes.get(assetId) === started) this.sizes.delete(assetId); });
      this.sizes.set(assetId, pending);
    }
    return pending;
  }
}

/**
 * A picture asset's URL; anything that is not a look picture is refused.
 * @param projectId - The Project whose scene assets are read.
 * @param assetId - The asset.
 * @returns Its registered URL.
 * @throws {Error} When it is not a PNG, JPEG or WebP picture.
 */
async function resolveLookPicture(projectId: string, assetId: string): Promise<string> {
  const asset = await resolveSceneAsset(projectId, assetId, new AbortController().signal);
  if (!isSceneLookImageMediaType(asset.mimeType)) throw new Error(`Scene asset ${assetId} is not a look picture`);
  return asset.url;
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

const pageSizes = new Map<string, LookPictureSizes>();

/**
 * The page's picture sizes for one Project, shared by every 3D Space of it.
 * @param projectId - The Project whose scene assets are read.
 * @returns The sizes.
 */
export function pageLookPictureSizes(projectId: string): LookPictureSizes {
  let sizes = pageSizes.get(projectId);
  if (!sizes) {
    sizes = new LookPictureSizes({
      resolve: (assetId) => resolveLookPicture(projectId, assetId),
      open: async (url) => {
        const body = (await fetchLookPicture(url)).body;
        if (!body) throw new Error('Look picture response has no body');
        return body;
      },
    });
    pageSizes.set(projectId, sizes);
  }
  return sizes;
}

/** What the lazy viewport needs from the page to load part pictures. */
export interface LookPictureAccess {
  /** The page's picture sizes for the Project. */
  sizes: LookPictureSizes;
  /** A picture asset's registered URL. */
  resolve: (assetId: string) => Promise<string>;
  /** A picture's whole file. */
  download: (url: string) => Promise<Blob>;
}

const pageAccess = new Map<string, LookPictureAccess>();

/**
 * The page's way to part pictures for one Project, handed to the lazy viewport by the editor.
 * @param projectId - The Project whose scene assets are read.
 * @returns The sizes, the resolver and the download.
 */
export function pageLookPictureAccess(projectId: string): LookPictureAccess {
  let access = pageAccess.get(projectId);
  if (!access) {
    access = {
      sizes: pageLookPictureSizes(projectId),
      resolve: (assetId) => resolveLookPicture(projectId, assetId),
      download: async (url) => (await fetchLookPicture(url)).blob(),
    };
    pageAccess.set(projectId, access);
  }
  return access;
}
