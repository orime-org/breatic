// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  extractVideoFirstFrame,
  videoCoverFileName,
} from '@web/spaces/canvas/video-cover-extract';

/**
 * A hand-driven fake `<video>` — jsdom has no video decode, so the tests
 * install this and manually fire the loadeddata / seeked / error handlers the
 * extractor wires, exercising the control flow (the real raster is smoke).
 */
interface FakeVideo {
  muted: boolean;
  preload: string;
  playsInline: boolean;
  currentTime: number;
  videoWidth: number;
  videoHeight: number;
  src: string;
  onerror: (() => void) | null;
  onloadeddata: (() => void) | null;
  onseeked: (() => void) | null;
  removeAttribute: (name: string) => void;
}

/** A hand-driven fake `<canvas>` whose `toBlob` yields a preset result. */
interface FakeCanvas {
  width: number;
  height: number;
  getContext: (id: string) => { drawImage: (...args: unknown[]) => void } | null;
  toBlob: (cb: (b: Blob | null) => void, type?: string, q?: number) => void;
}

/**
 * Install `URL` object-url spies + a `document.createElement` mock returning
 * the given fake video / canvas. Returns the spies for assertions.
 * @param video - The fake video element to hand back for `createElement('video')`.
 * @param canvas - The fake canvas for `createElement('canvas')`.
 * @returns The createObjectURL / revokeObjectURL spies.
 */
function installDom(
  video: FakeVideo,
  canvas: FakeCanvas,
): { create: ReturnType<typeof vi.fn>; revoke: ReturnType<typeof vi.fn> } {
  const create = vi.fn().mockReturnValue('blob:mock-url');
  const revoke = vi.fn();
  vi.stubGlobal('URL', {
    ...URL,
    createObjectURL: create,
    revokeObjectURL: revoke,
  });
  vi.spyOn(document, 'createElement').mockImplementation((tag: string) => {
    if (tag === 'video') return video as unknown as HTMLElement;
    if (tag === 'canvas') return canvas as unknown as HTMLElement;
    throw new Error(`unexpected createElement(${tag})`);
  });
  return { create, revoke };
}

/**
 * Build a fake video with sane frame dimensions.
 * @returns A fresh fake video element.
 */
function makeVideo(): FakeVideo {
  return {
    muted: false,
    preload: '',
    playsInline: false,
    currentTime: 0,
    videoWidth: 640,
    videoHeight: 360,
    src: '',
    onerror: null,
    onloadeddata: null,
    onseeked: null,
    removeAttribute: vi.fn(),
  };
}

/**
 * Build a fake canvas whose `toBlob` yields the given blob (or null).
 * @param blob - The blob `toBlob` hands its callback.
 * @returns A fresh fake canvas element.
 */
function makeCanvas(blob: Blob | null): FakeCanvas {
  return {
    width: 0,
    height: 0,
    getContext: () => ({ drawImage: vi.fn() }),
    toBlob: (cb) => cb(blob),
  };
}

const FILE = new File(['x'], 'clip.mp4', { type: 'video/mp4' });

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('extractVideoFirstFrame — first-frame JPEG cover off a local video File', () => {
  it('draws the first frame after loadeddata → seek → seeked and resolves the blob', async () => {
    const cover = new Blob(['cover'], { type: 'image/jpeg' });
    const video = makeVideo();
    const canvas = makeCanvas(cover);
    const { create, revoke } = installDom(video, canvas);

    const p = extractVideoFirstFrame(FILE);
    // Handlers are wired synchronously; drive the decode by hand.
    expect(create).toHaveBeenCalledWith(FILE);
    expect(video.src).toBe('blob:mock-url');
    video.onloadeddata?.();
    // loadeddata nudges a seek to force a paintable decode.
    expect(video.currentTime).toBeGreaterThan(0);
    video.onseeked?.();

    await expect(p).resolves.toBe(cover);
    // The canvas is sized to the frame before drawing.
    expect(canvas.width).toBe(640);
    expect(canvas.height).toBe(360);
    // Object URL always revoked.
    expect(revoke).toHaveBeenCalledWith('blob:mock-url');
  });

  it('resolves null (never throws) when the video errors — an undecodable codec', async () => {
    const video = makeVideo();
    const canvas = makeCanvas(null);
    const { revoke } = installDom(video, canvas);

    const p = extractVideoFirstFrame(FILE);
    video.onerror?.();

    await expect(p).resolves.toBeNull();
    expect(revoke).toHaveBeenCalledWith('blob:mock-url');
  });

  it('resolves null on a zero-sized frame (nothing to draw)', async () => {
    const video = makeVideo();
    video.videoWidth = 0;
    video.videoHeight = 0;
    const canvas = makeCanvas(new Blob(['x']));
    installDom(video, canvas);

    const p = extractVideoFirstFrame(FILE);
    video.onloadeddata?.();
    video.onseeked?.();

    await expect(p).resolves.toBeNull();
  });

  it('resolves null when toBlob yields no blob', async () => {
    const video = makeVideo();
    const canvas = makeCanvas(null);
    installDom(video, canvas);

    const p = extractVideoFirstFrame(FILE);
    video.onloadeddata?.();
    video.onseeked?.();

    await expect(p).resolves.toBeNull();
  });

  it('resolves null on timeout when no frame ever loads (decode hang guard)', async () => {
    const video = makeVideo();
    const canvas = makeCanvas(new Blob(['x']));
    const { revoke } = installDom(video, canvas);

    // Drive nothing — the timeout must fire and revoke the URL.
    await expect(
      extractVideoFirstFrame(FILE, { timeoutMs: 5 }),
    ).resolves.toBeNull();
    expect(revoke).toHaveBeenCalledWith('blob:mock-url');
  });

  it('ignores a late second event after it already settled (resolve-once)', async () => {
    const cover = new Blob(['cover'], { type: 'image/jpeg' });
    const video = makeVideo();
    const canvas = makeCanvas(cover);
    installDom(video, canvas);

    const p = extractVideoFirstFrame(FILE);
    video.onloadeddata?.();
    video.onseeked?.();
    // A stray later error must not flip the already-resolved blob to null.
    video.onerror?.();

    await expect(p).resolves.toBe(cover);
  });
});

describe('videoCoverFileName — cover name derived from the video name', () => {
  it('swaps the extension for -cover.jpg', () => {
    expect(videoCoverFileName('clip.mp4')).toBe('clip-cover.jpg');
    expect(videoCoverFileName('a.b.mov')).toBe('a.b-cover.jpg');
  });

  it('appends -cover.jpg when there is no extension', () => {
    expect(videoCoverFileName('movie')).toBe('movie-cover.jpg');
  });
});
