// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import { imageDimensionsFromData } from 'image-dimensions';
import { RepeatWrapping, SRGBColorSpace, Texture } from 'three';

import { httpRequest, isSceneLookImageMediaType } from '@breatic/shared';

import { resolveSceneAsset } from '@web/data/api/scene';
import { fittedLookSize } from '@web/spaces/three-d/look-texture-budget';

/** A picture's size and type as its file header declares them. */
export interface LookPictureSize {
  width: number;
  height: number;
  type: string;
}

/** A decoded picture that can be released. */
interface Decoded {
  width: number;
  height: number;
  close: () => void;
}

/** How the cache reaches a picture: its URL, its bytes as a stream or a blob, and the decoder. */
export interface LookTextureCacheDeps {
  /** The registered URL of a picture asset. */
  resolve: (assetId: string) => Promise<string>;
  /** The response body, read until the header is known. */
  open: (url: string) => Promise<ReadableStream<Uint8Array>>;
  /** The whole file. */
  download: (url: string) => Promise<Blob>;
  /** `createImageBitmap` in the browser: the file, or an already decoded picture to scale. */
  decode: (source: Blob | Decoded, options: ImageBitmapOptions) => Promise<Decoded>;
}

interface Entry {
  refs: number;
  ready: Promise<Texture>;
  /** The shared texture once decoded. */
  base: Texture | null;
}

/**
 * Free a shared texture and its decoded picture.
 * @param base - The shared texture.
 */
function close(base: Texture): void {
  base.dispose();
  (base.image as Decoded).close();
}

/** The decode options three's ImageBitmapLoader uses for glTF textures. */
const DECODE: ImageBitmapOptions = { premultiplyAlpha: 'none', imageOrientation: 'from-image' };

/** The bytes held while a picture's size is read; a JPEG's metadata before its frame header is dropped as it passes. */
const PICTURE_HEADER_BYTES = 4 * 1024 * 1024;

/**
 * Whether a JPEG marker opens its frame header or its scan, where the size is or can no longer be reached.
 * @param marker - The byte after 0xFF.
 * @returns True for SOF0-SOF15 (not DHT, JPG or DAC) and SOS.
 */
const endsJpegHeader = (marker: number): boolean => marker === 0xda || (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc);

/**
 * Drop the segments a JPEG holds before its frame header once they are read in full, keeping its start marker and the
 * rest in place. The walk is image-dimensions' own (`types/jpeg.js`): bytes before a marker and 0xFF fill bytes are
 * skipped (ITU T.81 B.1.1.2), TEM stands alone, and every other marker is followed by its segment's length. The bytes
 * kept start at the next marker after the last whole segment, so they read as the same JPEG; with no whole segment
 * held, nothing is dropped.
 * @param buffer - The bytes held, starting with the JPEG's start marker.
 * @param length - How many are held.
 * @returns How many are held after.
 */
function dropReadJpegSegments(buffer: Uint8Array, length: number): number {
  let offset = 2;
  let read = 2;
  while (offset + 2 <= length) {
    if (buffer[offset] !== 0xff || buffer[offset + 1] === 0xff) {
      offset += 1;
      continue;
    }
    const marker = buffer[offset + 1]!;
    if (marker === 0x01) {
      offset += 2;
      continue;
    }
    if (endsJpegHeader(marker) || offset + 4 > length) break;
    const end = offset + 2 + ((buffer[offset + 2]! << 8) | buffer[offset + 3]!);
    if (end > length) break;
    offset = end;
    read = end;
  }
  const next = buffer.indexOf(0xff, read);
  const from = next === -1 || next >= length ? read : next;
  buffer.copyWithin(2, from, length);
  return length - (from - 2);
}

/**
 * A picture's size and type read from the start of its bytes, stopping as soon as they are known; the rest of the
 * stream is cancelled. At most the header budget is held: a JPEG's segments before its frame header are dropped once
 * read, and any other stream still without a size when the budget is full is not a picture.
 * @param stream - The file's or the response's bytes.
 * @returns The size and type, or null when the bytes are not a picture header.
 */
export async function readPictureSize(stream: ReadableStream<Uint8Array>): Promise<LookPictureSize | null> {
  const buffer = new Uint8Array(PICTURE_HEADER_BYTES);
  let length = 0;
  const reader = stream.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return null;
      let chunk = value;
      while (chunk.length > 0) {
        if (length === buffer.length) {
          const jpeg = buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff;
          const kept = jpeg ? dropReadJpegSegments(buffer, length) : length;
          if (kept === length) return null;
          length = kept;
        }
        const taken = chunk.subarray(0, buffer.length - length);
        buffer.set(taken, length);
        length += taken.length;
        chunk = chunk.subarray(taken.length);
        const size = imageDimensionsFromData(buffer.subarray(0, length));
        if (size) return size;
      }
    }
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

/**
 * Part pictures for the scene (inner#1693 design 5.3): header sizes cached per asset for the page, decoded pictures
 * shared by reference count, each holder given its own clone so its tiling is its own.
 */
export class LookTextureCache {
  private readonly deps: LookTextureCacheDeps;
  private readonly sizes = new Map<string, Promise<LookPictureSize | null>>();
  private readonly entries = new Map<string, Entry>();

  /**
   * Take the transport and the decoder.
   * @param deps - How pictures are reached and decoded.
   */
  constructor(deps: LookTextureCacheDeps) {
    this.deps = deps;
  }

  /**
   * A picture's size from its file header, stopping the download there.
   * @param assetId - The picture asset.
   * @returns The size and type, or null when the bytes are not a picture header or the read failed.
   */
  size(assetId: string): Promise<LookPictureSize | null> {
    return this.read(assetId).catch(() => null);
  }

  /**
   * A picture's size from its file header, telling a read that failed apart from bytes that are not a picture.
   * @param assetId - The picture asset.
   * @returns The size and type, or null when the bytes are not a picture header; an asset's content never changes, so
   * the answer is kept.
   * @throws {Error} When the picture could not be reached or read; the failure is not kept, so a later read tries again.
   */
  read(assetId: string): Promise<LookPictureSize | null> {
    let pending = this.sizes.get(assetId);
    if (!pending) {
      const started = this.deps.resolve(assetId)
        .then((url) => this.deps.open(url))
        .then((stream) => readPictureSize(stream));
      pending = started;
      started.catch(() => { if (this.sizes.get(assetId) === started) this.sizes.delete(assetId); });
      this.sizes.set(assetId, pending);
    }
    return pending;
  }

  /**
   * Hold a picture, decoding it on the first hold.
   * @param assetId - The picture asset.
   * @param maxEdge - The longest edge a picture is shown at; this page's limit is one for every hold.
   * @returns A clone of the shared texture for this holder.
   * @throws {Error} When the picture cannot be downloaded or decoded; the hold is dropped.
   */
  async acquire(assetId: string, maxEdge = Number.POSITIVE_INFINITY): Promise<Texture> {
    let entry = this.entries.get(assetId);
    if (!entry) {
      const created: Entry = { refs: 0, ready: this.load(assetId, maxEdge), base: null };
      created.ready.then((base) => {
        created.base = base;
        // Every hold was released while it decoded.
        if (created.refs === 0) close(base);
      }, () => {
        if (this.entries.get(assetId) === created) this.entries.delete(assetId);
      });
      this.entries.set(assetId, created);
      entry = created;
    }
    entry.refs += 1;
    try {
      return (await entry.ready).clone();
    } catch (error) {
      entry.refs -= 1;
      throw error;
    }
  }

  /**
   * Release one hold: its clone is disposed, and the shared texture and picture after the last hold.
   * @param assetId - The picture asset.
   * @param clone - The clone `acquire` returned.
   */
  release(assetId: string, clone: Texture): void {
    clone.dispose();
    const entry = this.entries.get(assetId);
    if (!entry) return;
    entry.refs -= 1;
    if (entry.refs > 0) return;
    this.entries.delete(assetId);
    if (entry.base) close(entry.base);
  }

  /**
   * Download and decode one picture into the shared texture, then scale it down when its longest edge is over the
   * limit. The scale follows the decoded picture, whose orientation the file's EXIF has already applied (three.js,
   * Figma and PlayCanvas likewise scale the decoded image).
   * @param assetId - The picture asset.
   * @param maxEdge - The longest edge it is shown at.
   * @returns The texture, not flipped, in sRGB, repeating.
   * @throws {Error} When the download, the decode or the scale fails.
   */
  private async load(assetId: string, maxEdge: number): Promise<Texture> {
    const url = await this.deps.resolve(assetId);
    const blob = await this.deps.download(url);
    let bitmap = await this.deps.decode(blob, DECODE);
    const fitted = fittedLookSize(bitmap, maxEdge);
    if (fitted.width !== bitmap.width || fitted.height !== bitmap.height) {
      const decoded = bitmap;
      try {
        bitmap = await this.deps.decode(decoded, { premultiplyAlpha: 'none', resizeWidth: fitted.width, resizeHeight: fitted.height, resizeQuality: 'high' });
      } finally {
        decoded.close();
      }
    }
    const texture = new Texture(bitmap as unknown as ImageBitmap);
    texture.flipY = false;
    texture.colorSpace = SRGBColorSpace;
    texture.wrapS = RepeatWrapping;
    texture.wrapT = RepeatWrapping;
    texture.needsUpdate = true;
    return texture;
  }
}

const pageCaches = new Map<string, LookTextureCache>();

/**
 * The page's picture cache for one Project: header sizes and decoded pictures are shared by every 3D Space of it.
 * @param projectId - The Project whose scene assets are read.
 * @returns The cache.
 */
export function pageLookTextureCache(projectId: string): LookTextureCache {
  let cache = pageCaches.get(projectId);
  if (!cache) {
    /**
     * A picture asset's URL; anything that is not a look picture is refused.
     * @param assetId - The asset.
     * @returns Its registered URL.
     * @throws {Error} When it is not a PNG, JPEG or WebP picture.
     */
    const resolve = async (assetId: string): Promise<string> => {
      const asset = await resolveSceneAsset(projectId, assetId, new AbortController().signal);
      if (!isSceneLookImageMediaType(asset.mimeType)) throw new Error(`Scene asset ${assetId} is not a look picture`);
      return asset.url;
    };
    /**
     * Fetch a picture.
     * @param url - Its URL.
     * @returns The response.
     * @throws {Error} When the request fails or answers an error.
     */
    const fetchPicture = async (url: string): Promise<Response> => {
      const response = await httpRequest(url, { method: 'GET' }, { replaySafe: true });
      if (!response.ok) throw new Error(`Look picture request failed (${response.status})`);
      return response;
    };
    cache = new LookTextureCache({
      resolve,
      open: async (url) => {
        const body = (await fetchPicture(url)).body;
        if (!body) throw new Error('Look picture response has no body');
        return body;
      },
      download: async (url) => (await fetchPicture(url)).blob(),
      decode: (source, options) => createImageBitmap(source as ImageBitmapSource, options),
    });
    pageCaches.set(projectId, cache);
  }
  return cache;
}
