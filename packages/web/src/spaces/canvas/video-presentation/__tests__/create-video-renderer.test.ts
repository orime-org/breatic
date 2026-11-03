// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createVideoRenderer } from '../create-video-renderer';
import type { VideoPresentationSource, VideoRendererCallbacks } from '../types';

const vap = vi.hoisted(() => vi.fn());
vi.mock('video-animation-player', () => ({ default: vap }));
const H = 'a'.repeat(64);
const source: VideoPresentationSource = {
  canonicalURL: 'https://assets.test.invalid/video/fixture/original.webm', sourceFingerprint: H,
  presentation: { schemaVersion: 1, sourceFingerprint: H, original: { width: 96, height: 64, duration: 1 }, state: 'alpha_ready', alpha: { manifestURL: 'https://assets.test.invalid/video/fixture/original.webm.alpha.v1.json' } },
  manifest: { schemaVersion: 1, sourceFingerprint: H, packedURL: 'https://assets.test.invalid/video/fixture/original.webm.alpha.v1.mp4', packedWidth: 192, packedHeight: 64, colorRect: { x: 0, y: 0, width: 96, height: 64 }, alphaRect: { x: 96, y: 0, width: 96, height: 64 } },
};
let host: HTMLDivElement;
let callbacks: VideoRendererCallbacks;
let player: FakeVap;
let nativePlay: ReturnType<typeof vi.spyOn>;

// This fake models only the fixed public VAP API used by the adapter. Pixel and
// actual rVFC behavior are separately checked with the real production module.
class FakeVap {
  video!: HTMLVideoElement;
  options: { container: HTMLElement; src: string; config: unknown } | null = null;
  canvas: HTMLCanvasElement | null = null;
  initialized = false;
  destroyed = 0;
  draws = 0;
  play(options: { container: HTMLElement; src: string; config: unknown }): this {
    this.options = options;
    this.video.src = options.src;
    document.body.append(this.video);
    void Promise.resolve().then(() => {
      this.initWebGL();
      this.initialized = true;
      void this.video.play();
    });
    return this;
  }
  initWebGL(): WebGLRenderingContext {
    this.canvas = document.createElement('canvas');
    this.options!.container.append(this.canvas);
    return {} as WebGLRenderingContext;
  }
  initTexture(): void {}
  initVideoTexture(): void {}
  drawFrame(_now: number, _info: unknown): void { this.draws++; }
  cancelRequestAnimation(): void {}
  destroy(): void { this.destroyed++; this.canvas?.remove(); this.video.remove(); }
}

beforeEach(() => {
  host = document.createElement('div');
  document.body.append(host);
  callbacks = { ready: vi.fn(), frame: vi.fn(), getSeekEpoch: () => 0, error: vi.fn(), contextLost: vi.fn(), contextRestored: vi.fn() };
  vap.mockReset().mockImplementation(() => { player = new FakeVap(); return player; });
  nativePlay = vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue(undefined);
  vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {});
  vi.spyOn(HTMLMediaElement.prototype, 'load').mockImplementation(() => {});
});
afterEach(() => { host.remove(); vi.restoreAllMocks(); });
async function settle(): Promise<void> { for (let i = 0; i < 12; i++) await Promise.resolve(); }

describe('approved native and VAP rendering boundary', () => {
  it('adapts only the owned packed geometry, keeps canonical identity and initializes paused', async () => {
    const resource = createVideoRenderer(host, source, callbacks);
    await settle();
    expect(vap).toHaveBeenCalledTimes(1);
    expect(nativePlay).toHaveBeenCalledTimes(0);
    expect(player.options?.src).toBe(source.manifest!.packedURL);
    expect(player.options?.config).toMatchObject({ info: { w: 96, h: 64, videoW: 192, videoH: 64, rgbFrame: [0, 0, 96, 64], aFrame: [96, 0, 96, 64] } });
    expect(source.canonicalURL).toBe('https://assets.test.invalid/video/fixture/original.webm');
    player.drawFrame(0, { mediaTime: 0.125 });
    expect(player.draws).toBe(1);
    expect(callbacks.ready).toHaveBeenCalledWith(player.video, player.canvas);
    expect(callbacks.frame).toHaveBeenCalledWith(0.125, 0);
    resource.dispose();
    expect(player.destroyed).toBe(1);
    expect(host.querySelectorAll('canvas,video')).toHaveLength(0);
    expect(document.body.querySelectorAll('video')).toHaveLength(0);
  });

  it('releases initialization that finishes after disposal without publishing a binding', async () => {
    const resource = createVideoRenderer(host, source, callbacks);
    resource.dispose();
    await settle();
    expect(callbacks.ready).toHaveBeenCalledTimes(0);
    expect(host.querySelectorAll('canvas,video')).toHaveLength(0);
    expect(document.body.querySelectorAll('video')).toHaveLength(0);
  });

  it('refuses a different-source or wrong-size manifest without mounting VAP', async () => {
    for (const manifest of [{ ...source.manifest!, sourceFingerprint: 'b'.repeat(64) }, { ...source.manifest!, colorRect: { x: 0, y: 0, width: 48, height: 32 }, alphaRect: { x: 96, y: 0, width: 48, height: 32 } }]) {
      const resource = createVideoRenderer(host, { ...source, manifest }, callbacks);
      await settle();
      resource.dispose();
    }
    expect(vap).toHaveBeenCalledTimes(0);
    expect(callbacks.error).toHaveBeenCalledTimes(2);
  });

  it('binds native only from the explicit trusted classification', () => {
    const resource = createVideoRenderer(host, { ...source, presentation: { ...source.presentation, state: 'native', alpha: undefined }, manifest: undefined }, callbacks);
    const element = host.querySelector('video')!;
    expect(element.src).toBe(source.canonicalURL);
    expect(element.controls).toBe(false);
    element.dispatchEvent(new Event('loadeddata'));
    expect(callbacks.ready).toHaveBeenCalledWith(element, element);
    expect(vap).toHaveBeenCalledTimes(0);
    resource.dispose();
    expect(element.hasAttribute('src')).toBe(false);
    expect(host.querySelector('video')).toBeNull();
  });
});
