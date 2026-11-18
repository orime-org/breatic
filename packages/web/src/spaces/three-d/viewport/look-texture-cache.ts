// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import { imageDimensionsFromData } from 'image-dimensions';
import { RepeatWrapping, SRGBColorSpace, Texture } from 'three';

import { httpRequest, isSceneLookImageMediaType } from '@breatic/shared';

import { resolveSceneAsset } from '@web/data/api/scene';

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
  /** `createImageBitmap` in the browser. */
  decode: (blob: Blob, options: ImageBitmapOptions) => Promise<Decoded>;
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

/** Enough of a file to reach a picture's size: a JPEG may put megabytes of metadata before it. */
const PICTURE_HEADER_BYTES = 4 * 1024 * 1024;

/**
 * A picture's size and type read from the start of its bytes, stopping as soon as they are known or once the header
 * budget is read; the rest of the stream is cancelled.
 * @param stream - The file's or the response's bytes.
 * @returns The size and type, or null when the start is not a picture header.
 */
export async function readPictureSize(stream: ReadableStream<Uint8Array>): Promise<LookPictureSize | null> {
  const buffer = new Uint8Array(PICTURE_HEADER_BYTES);
  let length = 0;
  const reader = stream.getReader();
  try {
    while (length < buffer.length) {
      const { done, value } = await reader.read();
      if (done) break;
      const taken = value.subarray(0, buffer.length - length);
      buffer.set(taken, length);
      length += taken.length;
      const size = imageDimensionsFromData(buffer.subarray(0, length));
      if (size) return size;
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
   * A picture's size from its file header, stopping the download there; an asset's content never changes, so it is kept.
   * @param assetId - The picture asset.
   * @returns The size and type, or null when the header cannot be read or the request failed; a failure is not kept.
   */
  size(assetId: string): Promise<LookPictureSize | null> {
    let pending = this.sizes.get(assetId);
    if (!pending) {
      pending = this.deps.resolve(assetId)
        .then((url) => this.deps.open(url))
        .then((stream) => readPictureSize(stream))
        .catch(() => null)
        .then((size) => {
          if (!size) this.sizes.delete(assetId);
          return size;
        });
      this.sizes.set(assetId, pending);
    }
    return pending;
  }

  /**
   * Hold a picture, decoding it on the first hold.
   * @param assetId - The picture asset.
   * @returns A clone of the shared texture for this holder.
   * @throws {Error} When the picture cannot be downloaded or decoded; the hold is dropped.
   */
  async acquire(assetId: string): Promise<Texture> {
    let entry = this.entries.get(assetId);
    if (!entry) {
      const created: Entry = { refs: 0, ready: this.load(assetId), base: null };
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
   * Download and decode one picture into the shared texture.
   * @param assetId - The picture asset.
   * @returns The texture, not flipped, in sRGB, repeating.
   * @throws {Error} When the download or the decode fails.
   */
  private async load(assetId: string): Promise<Texture> {
    const url = await this.deps.resolve(assetId);
    const blob = await this.deps.download(url);
    const bitmap = await this.deps.decode(blob, DECODE);
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
      decode: (blob, options) => createImageBitmap(blob, options),
    });
    pageCaches.set(projectId, cache);
  }
  return cache;
}
