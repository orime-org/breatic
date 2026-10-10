// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Uploading through the real path from a smoke spec, and reading back what was
 * stored.
 */
import { randomBytes } from 'node:crypto';

import type { Page } from 'playwright/test';

import { VISIBLE_SPACE } from './space';

/**
 * Drop a file onto the visible canvas, the way a reader drags one in.
 * @param target - The page.
 * @param name - The file's name.
 * @param type - Its MIME type.
 * @param bytes - Its bytes.
 */
export async function dropFile(target: Page, name: string, type: string, bytes: Buffer): Promise<void> {
  await target.evaluate(
    async ([fileName, mime, encoded, space]: [string, string, string, string]) => {
      const binary = atob(encoded);
      const buffer = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i += 1) buffer[i] = binary.charCodeAt(i);
      const file = new File([buffer], fileName, { type: mime });
      const transfer = new DataTransfer();
      transfer.items.add(file);
      const pane = document.querySelector(`${space} .react-flow__pane`);
      if (pane === null) throw new Error('no canvas pane to drop onto');
      const rect = pane.getBoundingClientRect();
      const at = {
        clientX: rect.left + rect.width / 2,
        clientY: rect.top + rect.height / 2,
        bubbles: true,
        cancelable: true,
      };
      pane.dispatchEvent(new DragEvent('dragover', { ...at, dataTransfer: transfer }));
      pane.dispatchEvent(new DragEvent('drop', { ...at, dataTransfer: transfer }));
    },
    [name, type, bytes.toString('base64'), VISIBLE_SPACE] as [string, string, string, string],
  );
}

/**
 * A JPEG made unique to this run: a comment segment of random bytes is put in
 * front of its scan, so no earlier run's upload dedups it and its EXIF stays
 * where it was.
 * @param jpeg - The JPEG.
 * @returns The same picture with different bytes.
 */
export function uniqueJpeg(jpeg: Buffer): Buffer {
  let at = 2;
  while (at + 4 <= jpeg.length && jpeg[at] === 0xff && jpeg[at + 1] !== 0xda) {
    at += 2 + jpeg.readUInt16BE(at + 2);
  }
  const noise = randomBytes(16);
  const comment = Buffer.concat([Buffer.from([0xff, 0xfe, 0, noise.length + 2]), noise]);
  return Buffer.concat([jpeg.subarray(0, at), comment, jpeg.subarray(at)]);
}

/** One pixel's red, green and blue. */
export type Rgb = [number, number, number];

/** What a stored picture holds, read without applying any EXIF orientation. */
export interface StoredPicture {
  width: number;
  height: number;
  /** Near the middle of each edge. */
  top: Rgb;
  bottom: Rgb;
  left: Rgb;
  right: Rgb;
}

/**
 * Read a stored picture's own pixels, as a model reading the file would. A
 * preview URL is read as the original beside it.
 * @param target - A page to decode in.
 * @param url - The stored picture, or its preview.
 * @returns Its size and the colour near the middle of each edge.
 */
export async function storedPicture(target: Page, url: string): Promise<StoredPicture> {
  const original = url.replace(/\.preview\.webp$/, '');
  const fetched = await target.request.get(original);
  if (!fetched.ok()) throw new Error(`GET ${original} answered ${fetched.status()}`);
  const encoded = (await fetched.body()).toString('base64');
  return target.evaluate(async (data: string) => {
    const binary = atob(data);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
    const bitmap = await createImageBitmap(new Blob([bytes]), { imageOrientation: 'none' });
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    const ctx = canvas.getContext('2d')!;
    ctx.drawImage(bitmap, 0, 0);
    const at = (x: number, y: number): [number, number, number] => {
      const p = ctx.getImageData(Math.floor(x), Math.floor(y), 1, 1).data;
      return [p[0]!, p[1]!, p[2]!];
    };
    const { width, height } = bitmap;
    return {
      width,
      height,
      top: at(width / 2, 4),
      bottom: at(width / 2, height - 5),
      left: at(4, height / 2),
      right: at(width - 5, height / 2),
    };
  }, encoded);
}

/**
 * Whether a colour is the red or the blue of the two-colour samples.
 * @param rgb - The colour.
 * @returns `red`, `blue`, or `other`.
 */
export function hueOf([r, g, b]: Rgb): 'red' | 'blue' | 'other' {
  if (r > 180 && g < 80 && b < 80) return 'red';
  if (b > 180 && r < 80 && g < 80) return 'blue';
  return 'other';
}
