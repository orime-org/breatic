// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Crop-source preparation tests (#1987): what element the export builds for
 * each kind of source, how it is requested, and where it is seeked to.
 *
 * Everything past this point — decoding, `drawImage`, `toBlob` — is real
 * browser raster work jsdom does not implement, and belongs to the smoke run.
 * What IS testable here is the part that decides whether the canvas comes out
 * readable at all, and which frame lands in it.
 */

import { describe, it, expect, vi } from 'vitest';

import {
  prepareCropSource,
  exportCropBlob,
} from '@web/spaces/canvas/focus/crop-export';
import { FIRST_FRAME_SEEK_S } from '@web/spaces/canvas/video-cover-extract';

/**
 * An <img> that decodes instantly. jsdom implements neither `decode()` nor
 * image loading.
 * @returns The stubbed element.
 */
function fakeImage(): HTMLImageElement {
  const el = document.createElement('img');
  Object.defineProperty(el, 'decode', {
    configurable: true,
    value: () => Promise.resolve(),
  });
  return el;
}

/**
 * A <video> that reports metadata once a src is set and reports a completed
 * seek once `currentTime` is written. Both are announced on a microtask, so
 * the test does not decide whether the implementation subscribes before or
 * after it acts — only that it subscribes at all.
 * @returns The stubbed element.
 */
function fakeVideo(): HTMLVideoElement {
  const el = document.createElement('video');
  let src = '';
  let time = 0;
  Object.defineProperty(el, 'src', {
    configurable: true,
    get: () => src,
    set: (value: string) => {
      src = value;
      queueMicrotask(() => el.dispatchEvent(new Event('loadedmetadata')));
    },
  });
  Object.defineProperty(el, 'currentTime', {
    configurable: true,
    get: () => time,
    set: (value: number) => {
      time = value;
      queueMicrotask(() => el.dispatchEvent(new Event('seeked')));
    },
  });
  Object.defineProperty(el, 'videoWidth', { configurable: true, get: () => 1920 });
  Object.defineProperty(el, 'videoHeight', { configurable: true, get: () => 1080 });
  return el;
}

describe('exportCropBlob', () => {
  it('把时间点交给取源那一步，而不是把视频当静态图取（A9 的最后一跳）', async () => {
    // This is the one link in confirm → seek that nothing else pins: passing
    // `{ url, timeSeconds: null }` here sends every video down the still-image
    // path, where decoding an mp4 inside an <img> rejects and the whole crop
    // fails. The web package's other 4357 tests stayed green through that
    // mutation (round 2).
    // jsdom has no canvas raster, so the export throws AFTER the source has
    // been built and seeked — which is exactly the half worth pinning.
    const seeks: number[] = [];
    const video = document.createElement('video');
    let time = 0;
    Object.defineProperty(video, 'src', {
      configurable: true,
      set: () => queueMicrotask(() => video.dispatchEvent(new Event('loadedmetadata'))),
      get: () => '',
    });
    Object.defineProperty(video, 'currentTime', {
      configurable: true,
      get: () => time,
      set: (value: number) => {
        time = value;
        seeks.push(value);
        queueMicrotask(() => video.dispatchEvent(new Event('seeked')));
      },
    });
    const created = vi
      .spyOn(document, 'createElement')
      .mockImplementation(((tag: string) =>
        tag === 'video'
          ? video
          : Object.getPrototypeOf(document).createElement.call(
            document,
            tag,
          )) as typeof document.createElement);
    try {
      await expect(
        exportCropBlob(
          { url: 'https://cdn/clip.mp4', timeSeconds: 4.375 },
          { x: 0, y: 0, width: 10, height: 10 },
        ),
      ).rejects.toThrow();
    } finally {
      created.mockRestore();
    }
    expect(seeks).toEqual([4.375]);
  });
});

describe('prepareCropSource', () => {
  it('图片源：重新用跨域模式取一份，网址带缓存破坏参数', async () => {
    const img = fakeImage();
    const el = await prepareCropSource(
      { url: 'https://cdn/original.png', timeSeconds: null },
      { createImage: () => img },
    );
    expect(el).toBe(img);
    // The node's own <img> loaded WITHOUT crossOrigin; serving that cached
    // no-cors response to a CORS request is what taints the canvas. Both
    // halves are needed — the attribute asks for CORS, the param makes sure
    // the request is not answered from that cache.
    expect(img.crossOrigin).toBe('anonymous');
    expect(new URL(img.src).searchParams.get('focus-crop')).toBe('1');
  });

  it('视频源：同样跨域取一份，并且只要元数据', async () => {
    const video = fakeVideo();
    const el = await prepareCropSource(
      { url: 'https://cdn/clip.mp4', timeSeconds: 4.375 },
      { createVideo: () => video },
    );
    expect(el).toBe(video);
    expect(video.crossOrigin).toBe('anonymous');
    expect(new URL(video.src).searchParams.get('focus-crop')).toBe('1');
    // metadata + a seek is all a single frame needs; 'auto' would pull the
    // whole file over the network for one frame.
    expect(video.preload).toBe('metadata');
    expect(video.muted).toBe(true);
    expect(video.playsInline).toBe(true);
  });

  it('视频源：seek 到交下来的那个时间点', async () => {
    const video = fakeVideo();
    await prepareCropSource(
      { url: 'https://cdn/clip.mp4', timeSeconds: 4.375 },
      { createVideo: () => video },
    );
    expect(video.currentTime).toBe(4.375);
  });

  it('视频源：目标时间跟元素当前位置相同时，seek 目标带一点偏移', async () => {
    const video = fakeVideo();
    await prepareCropSource(
      // Frame 0 of a video that was never played is the common case, and a
      // fresh element already sits at 0: seeking to where you already are is
      // not guaranteed to fire `seeked`, so this would hang until the timeout.
      { url: 'https://cdn/clip.mp4', timeSeconds: 0 },
      { createVideo: () => video },
    );
    expect(video.currentTime).toBe(FIRST_FRAME_SEEK_S);
    // Still inside frame 0 at any real frame rate — the offset must not be
    // large enough to land on the next frame.
    expect(FIRST_FRAME_SEEK_S).toBeLessThan(1 / 120);
  });
});
