// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Browser-side crop export for the focus tool (#1782, video sources #1987) —
 * loads the source CORS-clean and draws the natural-pixel crop to an offscreen
 * canvas. Pure browser API; the raster half is covered by the real-browser
 * smoke (jsdom has no image decode / canvas raster), the source-preparation
 * half by unit tests through the injectable factories.
 */

import { corsUrl } from '@web/lib/cors-url';
import type { CropRect } from '@web/lib/crop-math';
import { intrinsicSize } from '@web/spaces/canvas/focus/crop-source';

/**
 * A hair past 0, still inside frame 0 for any real frame rate (shorter than
 * any frame's duration): seeking to the position an element already sits at
 * may not fire `seeked` in every browser, so nudging by this guarantees the
 * event and a paintable decode while staying on the same frame.
 */
export const FIRST_FRAME_SEEK_S = 0.0001;

/** What to crop: a URL, plus which frame of it for a video source. */
export interface CropSource {
  /** The source asset URL (public). */
  url: string;
  /**
   * The frame to grab, in seconds — `null` for a still image. Videos carry
   * the position the node's own element was parked at when the user
   * confirmed, so the crop is of the frame the user parked the timeline on.
   * Read off the element, which leads the painted picture while a seek is
   * still resolving.
   */
  timeSeconds: number | null;
}

/** Element factories, injectable so source preparation is unit-testable. */
export interface CropSourceFactories {
  /** Build the offscreen <img> for a still source. */
  createImage: () => HTMLImageElement;
  /** Build the offscreen <video> for a frame source. */
  createVideo: () => HTMLVideoElement;
}

/**
 * How long to wait for a VIDEO source to reach a state before giving up.
 *
 * Bounds the two waits the video path makes: metadata, and the seek. The image
 * path has no equivalent bound — it awaits `decode()`, which rejects on a
 * failed load but has no deadline of its own for a connection that stays open.
 * That is pre-existing and out of scope here; do not read this constant as
 * covering both.
 *
 * Deliberately NOT the 10s the local first-frame extract uses: that one runs
 * off bytes the browser already holds, while this is a forced trip to the
 * network for a file that can be large. Provisional — the real-browser smoke
 * measured 237ms, 322ms and 702ms for the source fetch, so the headroom is
 * large; calibrate if that ever stops being true.
 */
export const CROP_SOURCE_TIMEOUT_MS = 20_000;

/**
 * Wait for `event` on `el`, rejecting on `error` or after the timeout.
 * @param el - The media element to watch.
 * @param event - The event that means "ready".
 * @returns Resolves when the event fires.
 * @throws {Error} On the element's `error` event or on timeout.
 */
function once(el: HTMLMediaElement, event: string): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    /** Detach every listener and the timer — every exit funnels through here. */
    const done = (): void => {
      clearTimeout(timer);
      el.removeEventListener(event, onReady);
      el.removeEventListener('error', onError);
    };
    /** The element reached the state we asked for. */
    const onReady = (): void => {
      done();
      resolve();
    };
    /** The element failed to load or decode. */
    const onError = (): void => {
      done();
      reject(new Error(`crop source failed before ${event}`));
    };
    const timer = setTimeout(() => {
      done();
      reject(new Error(`crop source timed out before ${event}`));
    }, CROP_SOURCE_TIMEOUT_MS);
    el.addEventListener(event, onReady);
    el.addEventListener('error', onError);
  });
}

/**
 * Build a drawable source element for one crop: a decoded image, or a video
 * parked on the requested frame.
 *
 * The video path waits for `loadedmetadata` rather than `loadeddata` — with
 * `preload='metadata'` that is the level the element is guaranteed to reach,
 * and it is everything a seek needs. (The local cover extract uses
 * `preload='auto'` + `loadeddata`; taking that event under
 * `preload='metadata'` hangs, because the element may never reach
 * HAVE_CURRENT_DATA.)
 * @param source - The URL and, for a video, the frame to park on.
 * @param factories - Element factories; production uses the DOM.
 * @returns The element, ready to hand to `drawImage`.
 * @throws {Error} When the source cannot be loaded, or — video only — when
 *   its metadata or its seek does not arrive within
 *   {@link CROP_SOURCE_TIMEOUT_MS}.
 */
export async function prepareCropSource(
  source: CropSource,
  factories: Partial<CropSourceFactories> = {},
): Promise<HTMLImageElement | HTMLVideoElement> {
  if (source.timeSeconds === null) {
    const img = factories.createImage?.() ?? new Image();
    img.crossOrigin = 'anonymous';
    img.src = corsUrl(source.url);
    await img.decode();
    return img;
  }
  const video =
    factories.createVideo?.() ?? document.createElement('video');
  video.crossOrigin = 'anonymous';
  video.preload = 'metadata';
  video.muted = true;
  // Keeps iOS from trying to fullscreen an element that is never on screen.
  video.playsInline = true;
  const ready = once(video, 'loadedmetadata');
  video.src = corsUrl(source.url);
  await ready;
  // Seeking to where the element already sits is not guaranteed to fire
  // `seeked`, and a fresh element sits at 0 — which is exactly the frame a
  // never-played video is parked on. Nudge inside the same frame.
  const target =
    source.timeSeconds === video.currentTime
      ? source.timeSeconds + FIRST_FRAME_SEEK_S
      : source.timeSeconds;
  const seeked = once(video, 'seeked');
  video.currentTime = target;
  await seeked;
  return video;
}

/**
 * Export a crop of the source as a PNG blob at natural resolution.
 *
 * PNG keeps the export lossless and alpha-safe regardless of the source
 * format. The crop rect is in the source's own pixels, so the same nine-arg
 * `drawImage` serves an image and a video frame alike.
 * @param source - The source URL plus, for a video, the frame to crop.
 * @param crop - The crop rect in natural (source-resolution) pixels.
 * @returns The cropped PNG blob.
 * @throws {Error} When the source fails to load CORS-clean, when a video's
 *   metadata or its seek does not arrive within {@link CROP_SOURCE_TIMEOUT_MS},
 *   or when the canvas cannot export (tainted / zero-sized crop).
 */
export async function exportCropBlob(
  source: CropSource,
  crop: CropRect,
): Promise<Blob> {
  const el = await prepareCropSource(source);
  const canvas = document.createElement('canvas');
  canvas.width = crop.width;
  canvas.height = crop.height;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('canvas 2d context unavailable');
  ctx.drawImage(
    el,
    crop.x,
    crop.y,
    crop.width,
    crop.height,
    0,
    0,
    crop.width,
    crop.height,
  );
  const blob = await new Promise<Blob | null>((resolve) =>
    canvas.toBlob(resolve, 'image/png'),
  );
  if (!blob) throw new Error('canvas export produced no blob');
  return blob;
}

/** Quarter turns clockwise and flips, as the rotate & flip tool holds them. */
export interface Orientation {
  turns: number;
  flipX: boolean;
  flipY: boolean;
}

/**
 * The size a source takes after an orientation: a quarter or three-quarter
 * turn swaps its sides.
 * @param width - The source's width.
 * @param height - The source's height.
 * @param turns - Quarter turns clockwise.
 * @returns The oriented size.
 */
export function orientedSize(width: number, height: number, turns: number): { width: number; height: number } {
  return ((turns % 4) + 4) % 2 === 1 ? { width: height, height: width } : { width, height };
}

/**
 * Export a source turned and flipped as a PNG blob at natural resolution
 * (inner#888 §7.4). The flips apply to the picture as it stands and the turn
 * after them, which is the order the node's preview transform draws in.
 * @param source - The source URL plus, for a video, the frame to draw.
 * @param orientation - The turns and flips.
 * @returns The oriented PNG blob.
 * @throws {Error} When the source fails to load CORS-clean, or the canvas cannot export.
 */
export async function exportOrientedBlob(source: CropSource, orientation: Orientation): Promise<Blob> {
  const el = await prepareCropSource(source);
  const { width, height } = intrinsicSize(el);
  const size = orientedSize(width, height, orientation.turns);
  const canvas = document.createElement('canvas');
  canvas.width = size.width;
  canvas.height = size.height;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('canvas 2d context unavailable');
  ctx.translate(size.width / 2, size.height / 2);
  ctx.rotate((orientation.turns * Math.PI) / 2);
  ctx.scale(orientation.flipX ? -1 : 1, orientation.flipY ? -1 : 1);
  ctx.drawImage(el, -width / 2, -height / 2);
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'));
  if (!blob) throw new Error('canvas export produced no blob');
  return blob;
}
