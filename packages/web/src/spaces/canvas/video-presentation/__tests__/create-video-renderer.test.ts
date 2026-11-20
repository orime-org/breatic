// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createVideoRenderer } from '../create-video-renderer';
import type { VideoPresentationSource, VideoRendererCallbacks } from '../types';
import { PRESENTED, presentedBundle, presentedDisplay } from '@web/test-utils/video-presentation';

const vap = vi.hoisted(() => vi.fn());
vi.mock('video-animation-player', () => ({ default: vap }));
// §97 D10-2 (design §3.5 alpha manifest row 「VAP adapter只把自有字段映射为暂态配置」, §7.8): the source carries the selected
// bundle and, for alpha-packed, its manifest; VAP plays `manifest.packed.url` with the manifest's two logical rectangles as
// rgbFrame and aFrame. The earlier descriptor (`state`, `alpha.manifestURL`) and manifest (`packedURL`) are gone (4.4.5).
const H = PRESENTED.fingerprint;
const CANONICAL = 'https://assets.test.invalid/video/fixture/original.webm';
const packed = { storageKey: 'video/fixture/original.webm.packed.mp4', url: 'https://assets.test.invalid/video/fixture/original.webm.packed.mp4', etag: '"packed"', size: 8192, sha256: '9'.repeat(64), contentType: 'video/mp4' };
const display = presentedDisplay(96, 64, 25);
const alphaBundle = presentedBundle(CANONICAL, { display, playback: { kind: 'alpha-packed', carrier: packed,
  manifest: { ...packed, storageKey: 'video/fixture/original.webm.manifest.json', url: 'https://assets.test.invalid/video/fixture/original.webm.manifest.json', contentType: 'application/json' } } });
const manifest = { schemaVersion: 1 as const,
  packed, packedWidth: 192, packedHeight: 64, colorRect: { x: 0, y: 0, width: 96, height: 64 }, alphaRect: { x: 96, y: 0, width: 96, height: 64 } };
const source = { canonicalURL: CANONICAL, sourceFingerprint: H, presentation: alphaBundle, manifest } as unknown as VideoPresentationSource;
const carrierURL = 'https://assets.test.invalid/video/fixture/original.webm.carrier.mp4';
const nativeSource = { canonicalURL: CANONICAL, sourceFingerprint: H, manifest: null,
  presentation: presentedBundle(CANONICAL, { display, playback: { kind: 'native', carrier: { ...packed, url: carrierURL }, displayRect: null } }) } as unknown as VideoPresentationSource;
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
    expect(player.options?.src).toBe(manifest.packed.url);
    expect(player.options?.config).toMatchObject({ info: { w: 96, h: 64, videoW: 192, videoH: 64, rgbFrame: [0, 0, 96, 64], aFrame: [96, 0, 96, 64] } });
    expect(source.canonicalURL).toBe(CANONICAL);
    player.drawFrame(0, { mediaTime: 0.125 });
    expect(player.draws).toBe(1);
    expect(callbacks.ready).toHaveBeenCalledWith(player.video, player.canvas);
    expect(callbacks.frame).toHaveBeenCalledWith(0.125, 0);
    resource.dispose();
    expect(player.destroyed).toBe(1);
    expect(host.querySelectorAll('canvas,video')).toHaveLength(0);
    expect(document.body.querySelectorAll('video')).toHaveLength(0);
  });

  it('maps exactly the manifest fields into the VAP config, from no other field', async () => {
    const moved = { ...manifest, packed: { ...packed, url: 'https://assets.test.invalid/video/fixture/moved.packed.mp4' }, packedWidth: 192, colorRect: { x: 0, y: 0, width: 96, height: 64 }, alphaRect: { x: 96, y: 0, width: 96, height: 64 } };
    const resource = createVideoRenderer(host, { ...source, presentation: { ...alphaBundle, playback: { ...alphaBundle.playback, carrier: moved.packed } }, manifest: moved } as unknown as VideoPresentationSource, callbacks);
    await settle();
    expect(player.options?.src).toBe(moved.packed.url);
    expect(player.options?.config).toMatchObject({ info: { videoW: moved.packedWidth, videoH: moved.packedHeight, rgbFrame: [0, 0, 96, 64], aFrame: [96, 0, 96, 64] } });
    resource.dispose();
  });

  it('releases initialization that finishes after disposal without publishing a binding', async () => {
    const resource = createVideoRenderer(host, source, callbacks);
    resource.dispose();
    await settle();
    expect(callbacks.ready).toHaveBeenCalledTimes(0);
    expect(host.querySelectorAll('canvas,video')).toHaveLength(0);
    expect(document.body.querySelectorAll('video')).toHaveLength(0);
  });

  it('refuses a manifest of another packed object or of the wrong size without mounting VAP', async () => {
    for (const other of [{ ...manifest, packed: { ...packed, sha256: 'b'.repeat(64) } }, { ...manifest, colorRect: { x: 0, y: 0, width: 48, height: 32 }, alphaRect: { x: 96, y: 0, width: 48, height: 32 } }]) {
      const resource = createVideoRenderer(host, { ...source, manifest: other } as unknown as VideoPresentationSource, callbacks);
      await settle();
      resource.dispose();
    }
    expect(vap).toHaveBeenCalledTimes(0);
    expect(callbacks.error).toHaveBeenCalledTimes(2);
  });

  it('binds native from the selected native bundle and plays its carrier', () => {
    const resource = createVideoRenderer(host, nativeSource, callbacks);
    const element = host.querySelector('video')!;
    expect(element.src).toBe(carrierURL);
    expect(element.controls).toBe(false);
    element.dispatchEvent(new Event('loadeddata'));
    expect(callbacks.ready).toHaveBeenCalledWith(element, element);
    expect(vap).toHaveBeenCalledTimes(0);
    resource.dispose();
    expect(element.hasAttribute('src')).toBe(false);
    expect(host.querySelector('video')).toBeNull();
  });
});
