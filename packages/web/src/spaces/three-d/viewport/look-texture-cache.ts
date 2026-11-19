// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import jpegFormat from 'probe-image-size/lib/formats/jpeg.js';
import pngFormat from 'probe-image-size/lib/formats/png.js';
import webpFormat from 'probe-image-size/lib/formats/webp.js';
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

/** The picture formats a part takes, each read by probe-image-size's push parser (inner#1693 design 3.5). */
const PICTURE_PARSERS = [['jpeg', jpegFormat.Parser], ['png', pngFormat.Parser], ['webp', webpFormat.Parser]] as const;

/**
 * A picture's size and type read from the start of its bytes, stopping as soon as they are known; the rest of the
 * stream is cancelled. Each format's parser walks its header the way libjpeg, Go and Blink do: a JPEG's segments
 * before its frame header are skipped by length, never held, so the parsers hold a few bytes whatever the header's
 * size. Bytes that are no picture's start fail every parser at once; reading also ends after `maxBytes`.
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
