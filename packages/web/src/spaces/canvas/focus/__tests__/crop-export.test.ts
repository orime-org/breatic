// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * Crop-source preparation tests (#1987): what element the export builds for
 * each kind of source, how it is requested, and where it is seeked to.
 *
 * Everything past this point — decoding, `drawImage`, `toBlob` — is real
 * browser raster work jsdom does not implement, and belongs to the smoke run.
 * What IS testable here is the part that decides whether the canvas comes out
 * readable at all, and which frame lands in it.
 */

import { describe, it, expect } from 'vitest';

import { prepareCropSource } from '@web/spaces/canvas/focus/crop-export';
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
