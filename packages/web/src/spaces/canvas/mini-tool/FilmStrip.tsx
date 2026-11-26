// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-Breatic-Source-Available-2.0

import * as React from 'react';
import { useCanvasContext } from '@web/spaces/canvas/canvas-context';
import { presentGridFrames } from '@web/spaces/canvas/mini-tool/video/use-video-frame-thumbnails';
import { frameIndexOfMediaTime } from '@web/spaces/canvas/video-presentation/frame-grid-time';
import type { VideoPresentationSource } from '@web/spaces/canvas/video-presentation/types';
import { useResolvedVideoPresentation } from '@web/spaces/canvas/video-presentation/use-resolved-video-presentation';

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
 * Draw the frame a video or a renderer surface shows into a canvas, filling it the way `object-fit: cover` does.
 * @param image - The video parked on the frame, or the renderer's composited canvas.
 * @param canvas - The tile.
 */
function drawCover(image: HTMLVideoElement | HTMLCanvasElement, canvas: HTMLCanvasElement): void {
  const context = canvas.getContext('2d');
  const width = image instanceof HTMLVideoElement ? image.videoWidth : image.width;
  const height = image instanceof HTMLVideoElement ? image.videoHeight : image.height;
  if (context === null || width === 0 || height === 0) return;
  const scale = Math.max(canvas.width / width, canvas.height / height);
  const w = width * scale;
  const h = height * scale;
  context.drawImage(image, (canvas.width - w) / 2, (canvas.height - h) / 2, w, h);
}

interface FilmStripProps {
  /** The registered original, decoded for display only while no version is selected. */
  src: string;
  /** The selected version, whose playback file the strip decodes through the playback renderer (frames-split §7.8). */
  source?: VideoPresentationSource | null;
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
 * strip needs no CORS from the storage it plays from. With a selected version
 * the tiles come from its playback file through the renderer playback uses,
 * so an alpha-packed version shows its composited picture.
 * @param root0 - Props.
 * @param root0.src - The registered original.
 * @param root0.source - The selected version, if any.
 * @param root0.duration - The strip's length in seconds.
 * @param root0.aspect - The source's width over its height.
 * @returns The strip.
 */
export const FilmStrip = React.memo(function FilmStrip({ src, source = null, duration, aspect }: FilmStripProps): React.JSX.Element {
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
    // A strip that cannot load stays as its empty tiles; the cut itself does not depend on it.
    if (source !== null) {
      const controller = new AbortController();
      const grid = source.presentation.display;
      const frames = filmstripTimes(duration, count).map((time) => Math.min(grid.frameCount - 1, frameIndexOfMediaTime(time, grid)));
      let tile = 0;
      void presentGridFrames(source, frames, controller.signal, (_frame, image) => {
        const target = tilesRef.current[tile];
        tile += 1;
        if (target) drawCover(image, target);
      }).catch(() => undefined);
      return () => controller.abort();
    }
    let cancelled = false;
    const video = document.createElement('video');
    video.muted = true;
    video.playsInline = true;
    video.preload = 'auto';
    video.src = src;
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
  }, [src, source, duration, count, box.width]);

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

/**
 * A filmstrip of a registered video in the canvas's Project: it decodes the selected version's playback file once there is
 * one and the original for display until then (frames-split §7.8, the older tools' range bar).
 * @param props - The strip's props without the version, which this reads through the presentation query.
 * @returns The strip.
 * @throws {never} Read failures leave the strip on the original.
 */
export function PresentedFilmStrip(props: Omit<FilmStripProps, 'source'>): React.JSX.Element {
  const { projectId } = useCanvasContext();
  const { source } = useResolvedVideoPresentation(projectId, props.src, projectId !== '');
  return <FilmStrip {...props} source={source} />;
}
