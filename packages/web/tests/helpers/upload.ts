// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Uploading through the real path from a smoke spec, and reading back what was
 * stored.
 */
import { randomBytes } from 'node:crypto';
import { crc32 } from 'node:zlib';

import { expect, type Page } from 'playwright/test';

import { readImageOrientation } from '../../../ingest/src/image-orientation';
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
 * A picture made unique to this run, so no earlier run's upload dedups it. The
 * noise goes where every reader skips it and the EXIF stays where it was: a
 * JPEG comment segment in front of the scan, a PNG `tEXt` chunk after IHDR, a
 * WebP chunk of an unknown name at the end.
 * @param picture - A JPEG, PNG or WebP.
 * @returns The same picture with different bytes.
 */
export function uniquePicture(picture: Buffer): Buffer {
  const noise = randomBytes(16);
  if (picture[0] === 0xff && picture[1] === 0xd8) {
    let at = 2;
    while (at + 4 <= picture.length && picture[at] === 0xff && picture[at + 1] !== 0xda) {
      at += 2 + picture.readUInt16BE(at + 2);
    }
    const comment = Buffer.concat([Buffer.from([0xff, 0xfe, 0, noise.length + 2]), noise]);
    return Buffer.concat([picture.subarray(0, at), comment, picture.subarray(at)]);
  }
  if (picture.subarray(1, 4).toString('latin1') === 'PNG') {
    // Signature (8) and IHDR (25).
    const at = 33;
    const body = Buffer.concat([Buffer.from('tEXt', 'latin1'), Buffer.from('noise\0', 'latin1'), Buffer.from(noise.toString('hex'), 'latin1')]);
    const chunk = Buffer.alloc(body.length + 8);
    chunk.writeUInt32BE(body.length - 4, 0);
    body.copy(chunk, 4);
    chunk.writeUInt32BE(crc32(body), body.length + 4);
    return Buffer.concat([picture.subarray(0, at), chunk, picture.subarray(at)]);
  }
  if (picture.subarray(8, 12).toString('latin1') === 'WEBP') {
    const chunk = Buffer.concat([Buffer.from('XNOI', 'latin1'), Buffer.alloc(4), noise]);
    chunk.writeUInt32LE(noise.length, 4);
    const out = Buffer.concat([picture, chunk]);
    out.writeUInt32LE(out.length - 8, 4);
    return out;
  }
  throw new Error('uniquePicture takes a JPEG, PNG or WebP');
}

/** One pixel's red, green and blue. */
export type Rgb = [number, number, number];

/** What a stored picture holds. */
export interface StoredPicture {
  /** Its EXIF orientation, read from the bytes; 1 when it carries none. */
  orientation: number;
  /** Its size as shown, which is its stored size when `orientation` is 1. */
  width: number;
  height: number;
  /** Near the middle of each edge, as shown. */
  top: Rgb;
  bottom: Rgb;
  left: Rgb;
  right: Rgb;
}

/**
 * Read a stored picture. The orientation is read from the bytes here, not by a
 * browser: Chromium and WebKit apply it even when told not to. The pixels are
 * decoded as a browser shows them, so with orientation 1 they are the stored
 * pixels themselves. A preview URL is read as the original beside it.
 * @param target - A page to decode in.
 * @param url - The stored picture, or its preview.
 * @returns Its orientation, its size and the colour near the middle of each edge.
 */
export async function storedPicture(target: Page, url: string): Promise<StoredPicture> {
  const original = url.replace(/\.preview\.webp$/, '');
  const fetched = await target.request.get(original);
  if (!fetched.ok()) throw new Error(`GET ${original} answered ${fetched.status()}`);
  const bytes = await fetched.body();
  const contentType = fetched.headers()['content-type'] ?? '';
  const header = await readImageOrientation(
    async (offset, length) => bytes.subarray(offset, offset + length),
    contentType,
    bytes.length,
  );
  const shown = await target.evaluate(async (data: string) => {
    const binary = atob(data);
    const buffer = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) buffer[i] = binary.charCodeAt(i);
    const bitmap = await createImageBitmap(new Blob([buffer]));
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
  }, bytes.toString('base64'));
  return { orientation: header.orientation, ...shown };
}

/** What a finished upload registered as, as the status query delivers it. */
export interface DeliveredUpload {
  fileUrl: string;
  width: number | null;
  height: number | null;
}

/**
 * Watch the next upload's finish: it is queued with 202, and the status query
 * later delivers what it registered as (inner#1367 §4.2a). Start watching
 * before the upload begins.
 * @param target - The page.
 * @returns The finish's status code and the delivered result.
 */
export async function watchQueuedFinish(target: Page): Promise<{ queued: number; delivered: DeliveredUpload }> {
  const finished = await target.waitForResponse(
    (r) => /\/assets\/uploads\/[^/]+\/complete$/.test(new URL(r.url()).pathname) && r.request().method() === 'POST',
    { timeout: 60_000 },
  );
  const { storageKey } = ((await finished.json()) as { data: { storageKey: string } }).data;
  let delivered: DeliveredUpload | null = null;
  await target.waitForResponse(
    async (r) => {
      if (!r.url().includes('/assets/upload-status')) return false;
      const items = ((await r.json()) as { data: { items: { key: string; state: string; result?: DeliveredUpload }[] } }).data.items;
      const mine = items.find((item) => item.key === storageKey && item.state === 'completed');
      if (mine?.result !== undefined) delivered = mine.result;
      return delivered !== null;
    },
    { timeout: 120_000 },
  );
  return { queued: finished.status(), delivered: delivered! };
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

/** One request the page sent. */
export interface SentRequest {
  method: string;
  url: string;
}

/**
 * Record every request the page sends from now on.
 * @param target - The page.
 * @returns The list the requests are appended to, in the order sent.
 */
export function recordRequests(target: Page): SentRequest[] {
  const sent: SentRequest[] = [];
  target.on('request', (request) => {
    sent.push({ method: request.method(), url: request.url() });
  });
  return sent;
}

/** A part sent to the ingest Worker: `PUT …/uploads/<uploadId>/parts/<n>`. */
export const PART_PATH = /\/uploads\/[^/]+\/parts\/\d+$/;

/**
 * Assert a ticket answer is an upload our server already opened (inner#1595):
 * it names the upload id and first token, and carries no ticket.
 * @param answer - One opened upload from the ticket endpoint.
 */
export function expectOpenedUpload(answer: Record<string, unknown>): void {
  expect(typeof answer.uploadId).toBe('string');
  expect(typeof answer.token).toBe('string');
  expect(answer).not.toHaveProperty('ticket');
}

/**
 * Assert the page sent the ingest Worker nothing but parts (inner#1595): our
 * server opens every upload, so a page never posts to `/uploads`.
 * @param sent - What the page sent.
 * @param uploadUrl - The Worker's base address, as the ticket answer named it.
 * @returns How many parts were sent.
 */
export function expectOnlyPartsTo(sent: SentRequest[], uploadUrl: string): number {
  const toIngest = sent.filter((request) => request.url.startsWith(uploadUrl));
  for (const request of toIngest) {
    expect(request.method).toBe('PUT');
    expect(new URL(request.url).pathname).toMatch(PART_PATH);
  }
  return toIngest.length;
}
