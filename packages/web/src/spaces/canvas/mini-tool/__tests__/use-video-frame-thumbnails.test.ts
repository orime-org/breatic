// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import { createElement } from 'react';
import { cleanup, render, renderHook, screen, waitFor } from '@testing-library/react';
import { VideoToolControls } from '../video/VideoToolControls';
import { createVideoToolDraft } from '../video/video-tool-edit';
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import type { VideoPresentationSource } from '@web/spaces/canvas/video-presentation/types';
import * as thumbnails from '../video/use-video-frame-thumbnails';
import { presentedBundle, presentedDisplay } from '@web/test-utils/video-presentation';

// No hook, createVideoRenderer or VAP mock: only native media/canvas/WebGL, with a platform frame clock that presents the
// sought frame after each seek as Chromium does (mediaTime is the presented grid frame's start).
type Hook = (source: VideoPresentationSource, frames: readonly number[], retry?: number) => thumbnails.VideoThumbnailState;
const useThumbnails = thumbnails.useVideoFrameThumbnails as unknown as Hook;
// §97 (D10-1, D10-2; design §3.3, §3.5, §7.8): the source carries the selected bundle and, for alpha-packed, its manifest,
// whose packed receipt is the playable carrier (fixtures migrated from `state`/`packedURL`, 4.4.5). The native bundle's
// carrier is the source URL itself, so its playback URL stays the canonical URL.
const hash = 'a'.repeat(64);
// A 12 s grid at 25 fps.
const display = presentedDisplay(96, 64, 300);
const FPS = 25;
/**
 * A native source on its own carrier.
 * @param canonicalURL - The source URL, also the carrier.
 * @returns The source.
 */
const nativeAt = (canonicalURL: string): VideoPresentationSource => ({ canonicalURL, sourceFingerprint: hash, presentation: presentedBundle(canonicalURL, { display }), manifest: null });
const native: VideoPresentationSource = nativeAt('https://assets.example.test/flattened.mp4');
const packed = { storageKey: 'packed.mp4', url: 'https://assets.example.test/packed.mp4', etag: '"packed"', size: 8192, sha256: '9'.repeat(64), contentType: 'video/mp4' };
const alpha: VideoPresentationSource = { canonicalURL: 'https://assets.example.test/original.webm', sourceFingerprint: hash,
  presentation: presentedBundle('https://assets.example.test/original.webm', { display, playback: { kind: 'alpha-packed', carrier: packed,
    manifest: { ...packed, storageKey: 'alpha.json', url: 'https://assets.example.test/alpha.json', contentType: 'application/json' } } }),
  manifest: { schemaVersion: 1, packed,
    packedWidth: 196, packedHeight: 64, colorRect: { x: 0, y: 0, width: 96, height: 64 }, alphaRect: { x: 100, y: 0, width: 96, height: 64 } } };
const selected = [7, 0];
/**
 * Presents one frame on an element: runs every pending frame callback once with its mediaTime.
 * @param video - The element.
 * @param mediaTime - The presented frame's start.
 */
function presentFrame(video: HTMLVideoElement, mediaTime: number): void {
  const pending = frameCallbacks.get(video);
  if (pending === undefined) return;
  const callbacks = [...pending.values()];
  pending.clear();
  for (const callback of callbacks) callback(performance.now(), { mediaTime } as VideoFrameCallbackMetadata);
}
let seeks: number[];
let sources: string[];
let drawn: CanvasImageSource[];
let glDraw: ReturnType<typeof vi.fn>;
let times: WeakMap<HTMLMediaElement, number>;
let currentTimeDescriptor: PropertyDescriptor | undefined;
let srcDescriptor: PropertyDescriptor | undefined;
let frameCallbacks: WeakMap<HTMLVideoElement, Map<number, VideoFrameRequestCallback>>;
let nextFrameCallback: number;

beforeEach(() => {
  seeks = []; sources = []; drawn = []; times = new WeakMap(); frameCallbacks = new WeakMap(); nextFrameCallback = 0;
  currentTimeDescriptor = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, 'currentTime');
  srcDescriptor = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, 'src');
  Object.defineProperty(HTMLMediaElement.prototype, 'currentTime', { configurable: true, get() { return times.get(this as HTMLMediaElement) ?? 0; }, set(value: number) { const video = this as HTMLMediaElement; seeks.push(value); times.set(video, value); video.dispatchEvent(new Event('seeking')); queueMicrotask(() => { video.dispatchEvent(new Event('seeked')); video.dispatchEvent(new Event('loadeddata')); presentFrame(video as HTMLVideoElement, Math.floor(value * FPS) / FPS); }); } });
  Object.defineProperty(HTMLVideoElement.prototype, 'requestVideoFrameCallback', { configurable: true, writable: true, value(this: HTMLVideoElement, callback: VideoFrameRequestCallback): number { const pending = frameCallbacks.get(this) ?? new Map(); frameCallbacks.set(this, pending); nextFrameCallback += 1; pending.set(nextFrameCallback, callback); return nextFrameCallback; } });
  Object.defineProperty(HTMLVideoElement.prototype, 'cancelVideoFrameCallback', { configurable: true, writable: true, value(this: HTMLVideoElement, handle: number): void { frameCallbacks.get(this)?.delete(handle); } });
  Object.defineProperty(HTMLMediaElement.prototype, 'src', { configurable: true, get() { return (this as HTMLElement).getAttribute('src') ?? ''; }, set(value: string) { sources.push(value); (this as HTMLElement).setAttribute('src', value); } });
  vi.spyOn(HTMLMediaElement.prototype, 'readyState', 'get').mockReturnValue(4);
  vi.spyOn(HTMLVideoElement.prototype, 'videoWidth', 'get').mockReturnValue(96);
  vi.spyOn(HTMLVideoElement.prototype, 'videoHeight', 'get').mockReturnValue(64);
  // The resource fetch and first decode finish in a later task (HTML "queue a media element task" for loadedmetadata and
  // loadeddata), so script that runs on in microtasks after load(), as VAP's parser chain does before it asks for a frame
  // callback, still sees the first frame presented.
  vi.spyOn(HTMLMediaElement.prototype, 'load').mockImplementation(function (this: HTMLMediaElement): void { setTimeout(() => { this.dispatchEvent(new Event('loadedmetadata')); this.dispatchEvent(new Event('loadeddata')); presentFrame(this as HTMLVideoElement, 0); }, 0); });
  vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => undefined);
  // A play presents the frame at the current time, as playback does in Chromium; VAP plays its element to start drawing.
  vi.spyOn(HTMLMediaElement.prototype, 'play').mockImplementation(function (this: HTMLMediaElement): Promise<void> {
    const video = this as HTMLVideoElement;
    queueMicrotask(() => presentFrame(video, Math.floor((times.get(video) ?? 0) * FPS) / FPS));
    return Promise.resolve();
  });
  vi.stubGlobal('requestAnimationFrame', vi.fn(() => 1)); vi.stubGlobal('cancelAnimationFrame', vi.fn());
  glDraw = vi.fn();
  const functions = new Map<PropertyKey, unknown>();
  // Platform no-op GL: validates adapter/library wiring, not shader pixels.
  const gl = new Proxy({}, { get(_target, key) {
    if (key === 'drawArrays') return glDraw;
    if (typeof key === 'string' && key === key.toUpperCase()) return 1;
    if (!functions.has(key)) functions.set(key, vi.fn(() => key === 'getShaderParameter' || key === 'getProgramParameter' ? true : key === 'getAttribLocation' ? 0 : {}));
    return functions.get(key);
  } });
  (vi.spyOn(HTMLCanvasElement.prototype, 'getContext') as unknown as MockInstance<(contextId: string) => unknown>).mockImplementation((kind: string) => (kind === '2d' ? { drawImage: (surface: CanvasImageSource) => drawn.push(surface), clearRect: vi.fn() } : gl));
  vi.spyOn(HTMLCanvasElement.prototype, 'toDataURL').mockImplementation(() => `data:image/png;base64,capture-${drawn.length}`);
});
afterEach(() => {
  cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals();
  if (currentTimeDescriptor) Object.defineProperty(HTMLMediaElement.prototype, 'currentTime', currentTimeDescriptor); else Reflect.deleteProperty(HTMLMediaElement.prototype, 'currentTime');
  if (srcDescriptor) Object.defineProperty(HTMLMediaElement.prototype, 'src', srcDescriptor); else Reflect.deleteProperty(HTMLMediaElement.prototype, 'src');
  Reflect.deleteProperty(HTMLVideoElement.prototype, 'requestVideoFrameCallback');
  Reflect.deleteProperty(HTMLVideoElement.prototype, 'cancelVideoFrameCallback');
});

describe('S4 frame preview cards use the panel presentation clock', () => {
  it('T02 uses packed playback and captures the real alpha renderer canvas, never the opaque packed video', async () => {
    const { result } = renderHook(() => useThumbnails(alpha, selected));
    await waitFor(() => expect(result.current.status).toBe('ready'));
    expect(sources).toEqual([alpha.manifest!.packed.url]); expect(seeks).toEqual([7.5 / FPS, 0.5 / FPS]);
    expect(glDraw).toHaveBeenCalled(); expect(drawn).toHaveLength(2);
    expect(drawn.every((surface) => surface instanceof HTMLCanvasElement)).toBe(true);
    expect(result.current.frames.map((frame) => frame.frameIndex)).toEqual([7, 0]);
  });
  it('T04 real extract controls pass the current grid frame and panel packed presentation to preview cards', async () => {
    const draft = createVideoToolDraft('video.extract-frames', { nodeId: '10000000-0000-4000-8000-000000000001', canonicalURL: alpha.canonicalURL, mediaInfo: { width: 96, height: 64, duration: 12, mimeType: 'video/webm' } });
    const props = { toolId: 'video.extract-frames' as const, draft, onChange: vi.fn(), analyses: [], grid: { fps: display.fps, frameCount: display.frameCount }, presentedTime: 2, disabled: false, pickingSlot: null, inputNames: new Map<string, string>(), onPick: vi.fn(), onAnalyse: vi.fn(), analysing: false, onEditTimeline: vi.fn(), previewSource: alpha };
    render(createElement(VideoToolControls, props));
    await waitFor(() => expect(screen.getByTestId('video-frame-previews').querySelectorAll('img')).toHaveLength(1));
    // The presented mediaTime 2 s is grid frame 50, sought at its midpoint (§4.3).
    expect(seeks).toEqual([50.5 / FPS]); expect(sources).toEqual([alpha.manifest!.packed.url]);
    expect(drawn).toHaveLength(1); expect(drawn[0]).toBeInstanceOf(HTMLCanvasElement);
  });
  it('T03 replaces source ownership with no old thumbnail visible and disposes native resources', async () => {
    const { result, rerender, unmount } = renderHook(({ source }) => useThumbnails(source, selected), { initialProps: { source: native } });
    await waitFor(() => expect(result.current.status).toBe('ready'));
    rerender({ source: nativeAt('https://assets.example.test/new.mp4') });
    expect(result.current.frames).toEqual([]);
    await waitFor(() => expect(result.current.status).toBe('ready'));
    unmount(); expect(document.querySelectorAll('video[src],canvas')).toHaveLength(0);
    expect(drawn.filter((surface) => surface instanceof HTMLVideoElement).map((surface) => surface.getAttribute('src'))).toEqual([null, null, null, null]);
    expect(sources).toEqual([native.canonicalURL, 'https://assets.example.test/new.mp4']);
  });
});
