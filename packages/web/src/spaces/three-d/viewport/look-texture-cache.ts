// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-Breatic-Source-Available-2.0

import { RepeatWrapping, SRGBColorSpace, Texture } from 'three';

import { fittedLookSize } from '@web/spaces/three-d/look-texture-budget';
import type { LookPictureAccess, LookPictureSize, LookPictureSizes } from '@web/spaces/three-d/look-picture-size';

/** A decoded picture that can be released. */
interface Decoded {
  width: number;
  height: number;
  close: () => void;
}

/** How the cache reaches a picture by its address: the page's header sizes, its bytes as a blob, and the decoder. */
export interface LookTextureCacheDeps {
  /** The page's picture sizes, by address. */
  sizes: Pick<LookPictureSizes, 'size'>;
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

/**
 * Part pictures for the scene (inner#1693 design 5.3): decoded pictures shared by reference count, each holder given
 * its own clone so its tiling is its own; header sizes come from the page's picture sizes.
 */
export class LookTextureCache {
  private readonly deps: LookTextureCacheDeps;
  private readonly entries = new Map<string, Entry>();

  /**
   * Take the transport and the decoder.
   * @param deps - How pictures are reached and decoded.
   */
  constructor(deps: LookTextureCacheDeps) {
    this.deps = deps;
  }

  /**
   * A picture's size from its file header.
   * @param url - The picture's address.
   * @param maxBytes - The most bytes read for the size.
   * @returns The size and type, or null when the bytes are not a picture header or the read failed.
   */
  size(url: string, maxBytes: number): Promise<LookPictureSize | null> {
    return this.deps.sizes.size(url, maxBytes);
  }

  /**
   * Hold a picture, decoding it on the first hold.
   * @param url - The picture's address.
   * @param maxEdge - The longest edge a picture is shown at; this page's limit is one for every hold.
   * @returns A clone of the shared texture for this holder.
   * @throws {Error} When the picture cannot be downloaded or decoded; the hold is dropped.
   */
  async acquire(url: string, maxEdge = Number.POSITIVE_INFINITY): Promise<Texture> {
    let entry = this.entries.get(url);
    if (!entry) {
      const created: Entry = { refs: 0, ready: this.load(url, maxEdge), base: null };
      created.ready.then((base) => {
        created.base = base;
        // Every hold was released while it decoded.
        if (created.refs === 0) close(base);
      }, () => {
        if (this.entries.get(url) === created) this.entries.delete(url);
      });
      this.entries.set(url, created);
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
   * @param url - The picture's address.
   * @param clone - The clone `acquire` returned.
   */
  release(url: string, clone: Texture): void {
    clone.dispose();
    const entry = this.entries.get(url);
    if (!entry) return;
    entry.refs -= 1;
    if (entry.refs > 0) return;
    this.entries.delete(url);
    if (entry.base) close(entry.base);
  }

  /**
   * Download and decode one picture into the shared texture, then scale it down when its longest edge is over the
   * limit. The scale follows the decoded picture, whose orientation the file's EXIF has already applied (three.js,
   * Figma and PlayCanvas likewise scale the decoded image).
   * @param url - The picture's address.
   * @param maxEdge - The longest edge it is shown at.
   * @returns The texture, not flipped, in sRGB, repeating.
   * @throws {Error} When the download, the decode or the scale fails.
   */
  private async load(url: string, maxEdge: number): Promise<Texture> {
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

const caches = new WeakMap<LookPictureAccess, LookTextureCache>();

/**
 * The picture cache of one way to the pictures, so the page's single access gives every 3D Space on the page one
 * cache. It lives in the lazy viewport, which loads three.js and may import nothing the eager page holds, so the editor
 * hands the access over.
 * @param access - The picture sizes and download the editor hands over.
 * @returns The cache.
 */
export function pageLookTextureCache(access: LookPictureAccess): LookTextureCache {
  let cache = caches.get(access);
  if (!cache) {
    cache = new LookTextureCache({ ...access, decode: (source, options) => createImageBitmap(source as ImageBitmapSource, options) });
    caches.set(access, cache);
  }
  return cache;
}
