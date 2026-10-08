// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import * as React from 'react';

/**
 * The moments a filmstrip shows: the middle of each tile.
 * @param duration - The video's length in seconds.
 * @param count - How many tiles the strip has.
 * @returns One time per tile, in seconds.
 */
export function filmstripTimes(duration: number, count: number): number[] {
  return Array.from({ length: count }, (_, index) => ((index + 0.5) / count) * duration);
}

/**
 * How many tiles of the source's shape fill the strip.
 * @param width - The strip's width in pixels.
 * @param height - The strip's height in pixels.
 * @param aspect - The source's width over its height.
 * @returns The tile count, at least one.
 */
export function filmstripCount(width: number, height: number, aspect: number): number {
  return Math.max(1, Math.ceil(width / (height * aspect)));
}

/**
 * Seek a video and wait until its frame at that time is ready.
 * @param video - The video.
 * @param time - Seconds.
 * @returns Resolves once the seek lands.
 * @throws {Error} When the video errors before landing.
 */
function seekTo(video: HTMLVideoElement, time: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const listeners = new AbortController();
    video.addEventListener(
      'seeked',
      () => {
        listeners.abort();
        resolve();
      },
      { signal: listeners.signal },
    );
    video.addEventListener(
      'error',
      () => {
        listeners.abort();
        reject(new Error('video failed while seeking'));
      },
      { signal: listeners.signal },
    );
    video.currentTime = time;
  });
}

/**
 * Wait until a video knows its size and length, which a seek needs first.
 * @param video - The video, its source set.
 * @returns Resolves once the metadata is in.
 * @throws {Error} When the video fails to load.
 */
function metadataOf(video: HTMLVideoElement): Promise<void> {
  if (video.readyState >= HTMLMediaElement.HAVE_METADATA) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const listeners = new AbortController();
    video.addEventListener(
      'loadedmetadata',
      () => {
        listeners.abort();
        resolve();
      },
      { signal: listeners.signal },
    );
    video.addEventListener(
      'error',
      () => {
        listeners.abort();
        reject(new Error('video failed to load'));
      },
      { signal: listeners.signal },
    );
  });
}

/**
 * Draw the video's current frame into a canvas, filling it the way
 * `object-fit: cover` does.
 * @param video - The video, parked on the frame.
 * @param canvas - The tile.
 */
function drawCover(video: HTMLVideoElement, canvas: HTMLCanvasElement): void {
  const context = canvas.getContext('2d');
  if (context === null || video.videoWidth === 0 || video.videoHeight === 0) return;
  const scale = Math.max(canvas.width / video.videoWidth, canvas.height / video.videoHeight);
  const w = video.videoWidth * scale;
  const h = video.videoHeight * scale;
  context.drawImage(video, (canvas.width - w) / 2, (canvas.height - h) / 2, w, h);
}

interface FilmStripProps {
  src: string;
  /** Seconds. */
  duration: number;
  /** The source's width over its height. */
  aspect: number;
}

/**
 * A row of frames taken from a video at even intervals, filling its box.
 *
 * Each frame is drawn straight into its tile: drawing a video from another
 * origin into a canvas is allowed, only reading the pixels back is not, so the
 * strip needs no CORS from the storage it plays from.
 * @param root0 - Props.
 * @param root0.src - The video URL.
 * @param root0.duration - The video's length in seconds.
 * @param root0.aspect - The source's width over its height.
 * @returns The strip.
 */
export const FilmStrip = React.memo(function FilmStrip({ src, duration, aspect }: FilmStripProps): React.JSX.Element {
  const boxRef = React.useRef<HTMLDivElement>(null);
  const tilesRef = React.useRef<(HTMLCanvasElement | null)[]>([]);
  const [box, setBox] = React.useState({ width: 0, height: 0 });

  React.useLayoutEffect(() => {
    const el = boxRef.current;
    if (el === null) return;
    setBox({ width: el.clientWidth, height: el.clientHeight });
    const observer = new ResizeObserver(() => setBox({ width: el.clientWidth, height: el.clientHeight }));
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const count = filmstripCount(box.width, box.height, aspect);

  React.useEffect(() => {
    if (box.width === 0 || duration <= 0) return;
    let cancelled = false;
    const video = document.createElement('video');
    video.muted = true;
    video.playsInline = true;
    video.preload = 'auto';
    video.src = src;
    // A strip that cannot load stays as its empty tiles; the cut itself does not depend on it.
    (async () => {
      await metadataOf(video);
      for (const [index, time] of filmstripTimes(duration, count).entries()) {
        await seekTo(video, time);
        if (cancelled) return;
        const tile = tilesRef.current[index];
        if (tile) drawCover(video, tile);
      }
    })().catch(() => undefined);
    return () => {
      cancelled = true;
      video.removeAttribute('src');
      video.load();
    };
  }, [src, duration, count, box.width]);

  const ratio = typeof window === 'undefined' ? 1 : window.devicePixelRatio;
  const tileWidth = box.height * aspect;
  return (
    <div ref={boxRef} data-testid='mini-tool-filmstrip' className='absolute inset-0 flex overflow-hidden'>
      {Array.from({ length: count }, (_, index) => (
        <canvas
          key={index}
          ref={(el) => {
            tilesRef.current[index] = el;
          }}
          width={Math.max(1, Math.round(tileWidth * ratio))}
          height={Math.max(1, Math.round(box.height * ratio))}
          className='h-full shrink-0'
          style={{ width: tileWidth }}
        />
      ))}
    </div>
  );
});
