// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { createElement } from 'react';
import { cleanup, render, renderHook, screen, waitFor } from '@testing-library/react';
import { VideoToolControls } from '../video/VideoToolControls';
import { createVideoToolDraft } from '../video/video-tool-edit';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { VideoPresentationSource } from '@web/spaces/canvas/video-presentation/types';
import * as thumbnails from '../video/use-video-frame-thumbnails';

// No hook, createVideoRenderer or VAP mock: only native media/canvas/WebGL.
interface Frame { frameIndex: number; pts: number; displayEnd: number }
type Hook = (source: VideoPresentationSource, frames: readonly Frame[], retry?: number) => thumbnails.VideoThumbnailState;
const useThumbnails = thumbnails.useVideoFrameThumbnails as unknown as Hook;
const hash = 'a'.repeat(64);
const native: VideoPresentationSource = { canonicalURL: 'https://assets.example.test/flattened.mp4', sourceFingerprint: hash, presentation: { schemaVersion: 1, state: 'native', sourceFingerprint: hash, original: { width: 96, height: 64, duration: 12 } } };
const alpha: VideoPresentationSource = { ...native, canonicalURL: 'https://assets.example.test/original.webm', presentation: { ...native.presentation, state: 'alpha_ready', alpha: { manifestURL: 'https://assets.example.test/alpha.json' } }, manifest: { schemaVersion: 1, sourceFingerprint: hash, packedURL: 'https://assets.example.test/packed.mp4', packedWidth: 192, packedHeight: 64, colorRect: { x: 0, y: 0, width: 96, height: 64 }, alphaRect: { x: 96, y: 0, width: 96, height: 64 } } };
const selected = [{ frameIndex: 7, pts: 9, displayEnd: 9.4 }, { frameIndex: 0, pts: 2, displayEnd: 2.2 }];
let seeks: number[];
let sources: string[];
let drawn: CanvasImageSource[];
let glDraw: ReturnType<typeof vi.fn>;
let times: WeakMap<HTMLMediaElement, number>;
let currentTimeDescriptor: PropertyDescriptor | undefined;
let srcDescriptor: PropertyDescriptor | undefined;

beforeEach(() => {
  seeks = []; sources = []; drawn = []; times = new WeakMap();
  currentTimeDescriptor = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, 'currentTime');
  srcDescriptor = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, 'src');
  Object.defineProperty(HTMLMediaElement.prototype, 'currentTime', { configurable: true, get() { return times.get(this as HTMLMediaElement) ?? 0; }, set(value: number) { const video = this as HTMLMediaElement; seeks.push(value); times.set(video, value); video.dispatchEvent(new Event('seeking')); queueMicrotask(() => { video.dispatchEvent(new Event('seeked')); video.dispatchEvent(new Event('loadeddata')); }); } });
  Object.defineProperty(HTMLMediaElement.prototype, 'src', { configurable: true, get() { return (this as HTMLElement).getAttribute('src') ?? ''; }, set(value: string) { sources.push(value); (this as HTMLElement).setAttribute('src', value); } });
  vi.spyOn(HTMLMediaElement.prototype, 'readyState', 'get').mockReturnValue(4);
  vi.spyOn(HTMLVideoElement.prototype, 'videoWidth', 'get').mockReturnValue(96);
  vi.spyOn(HTMLVideoElement.prototype, 'videoHeight', 'get').mockReturnValue(64);
  vi.spyOn(HTMLMediaElement.prototype, 'load').mockImplementation(function (this: HTMLMediaElement): void { queueMicrotask(() => { this.dispatchEvent(new Event('loadedmetadata')); this.dispatchEvent(new Event('loadeddata')); }); });
  vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => undefined);
  vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue(undefined);
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
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation((kind: string) => (kind === '2d' ? { drawImage: (surface: CanvasImageSource) => drawn.push(surface), clearRect: vi.fn() } : gl) as unknown as CanvasRenderingContext2D);
  vi.spyOn(HTMLCanvasElement.prototype, 'toDataURL').mockImplementation(() => `data:image/png;base64,capture-${drawn.length}`);
});
afterEach(() => {
  cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals();
  if (currentTimeDescriptor) Object.defineProperty(HTMLMediaElement.prototype, 'currentTime', currentTimeDescriptor); else Reflect.deleteProperty(HTMLMediaElement.prototype, 'currentTime');
  if (srcDescriptor) Object.defineProperty(HTMLMediaElement.prototype, 'src', srcDescriptor); else Reflect.deleteProperty(HTMLMediaElement.prototype, 'src');
});

describe('S4 frame preview cards use the panel presentation clock', () => {
  it('T01 seeks nonzero/gapped display intervals at their midpoint, in requested plan order', async () => {
    const { result } = renderHook(() => useThumbnails(native, selected));
    await waitFor(() => expect(result.current.status).toBe('ready'));
    expect(seeks).toEqual([9.2, 2.1]);
    expect(sources).toEqual([native.canonicalURL]);
    expect(result.current.frames.map(({ frameIndex, pts }) => ({ frameIndex, pts }))).toEqual([{ frameIndex: 7, pts: 9 }, { frameIndex: 0, pts: 2 }]);
    expect(drawn).toHaveLength(2); expect(drawn.every((surface) => surface instanceof HTMLVideoElement)).toBe(true);
  });
  it('T02 uses packed playback and captures the real alpha renderer canvas, never the opaque packed video', async () => {
    const { result } = renderHook(() => useThumbnails(alpha, selected));
    await waitFor(() => expect(result.current.status).toBe('ready'));
    expect(sources).toEqual([alpha.manifest!.packedURL]); expect(seeks).toEqual([9.2, 2.1]);
    expect(glDraw).toHaveBeenCalled(); expect(drawn).toHaveLength(2);
    expect(drawn.every((surface) => surface instanceof HTMLCanvasElement)).toBe(true);
    expect(result.current.frames.map((frame) => frame.frameIndex)).toEqual([7, 0]);
  });
  it('T04 real extract controls pass the table interval and panel packed presentation to preview cards', async () => {
    const draft = createVideoToolDraft('video.extract-frames', { nodeId: '10000000-0000-4000-8000-000000000001', canonicalURL: alpha.canonicalURL, mediaInfo: { width: 96, height: 64, duration: 12, mimeType: 'video/webm' } });
    const props = { toolId: 'video.extract-frames' as const, draft, onChange: vi.fn(), analyses: [], frameTable: { schemaVersion: 1 as const, timescale: 10, runs: [{ start: 20, count: 1, step: 2, duration: 2 }, { start: 90, count: 1, step: 4, duration: 4 }] }, presentedTime: 2, disabled: false, pickingSlot: null, inputNames: new Map<string, string>(), onPick: vi.fn(), onAnalyse: vi.fn(), analysing: false, onEditTimeline: vi.fn(), previewSource: alpha };
    render(createElement(VideoToolControls, props));
    await waitFor(() => expect(screen.getByTestId('video-frame-previews').querySelectorAll('img')).toHaveLength(1));
    expect(seeks).toEqual([2.1]); expect(sources).toEqual([alpha.manifest!.packedURL]);
    expect(drawn).toHaveLength(1); expect(drawn[0]).toBeInstanceOf(HTMLCanvasElement);
  });
  it('T03 replaces source ownership with no old thumbnail visible and disposes native resources', async () => {
    const { result, rerender, unmount } = renderHook(({ source }) => useThumbnails(source, selected), { initialProps: { source: native } });
    await waitFor(() => expect(result.current.status).toBe('ready'));
    rerender({ source: { ...native, canonicalURL: 'https://assets.example.test/new.mp4' } });
    expect(result.current.frames).toEqual([]);
    await waitFor(() => expect(result.current.status).toBe('ready'));
    unmount(); expect(document.querySelectorAll('video[src],canvas')).toHaveLength(0);
    expect(drawn.filter((surface) => surface instanceof HTMLVideoElement).map((surface) => surface.getAttribute('src'))).toEqual([null, null, null, null]);
    expect(sources).toEqual([native.canonicalURL, 'https://assets.example.test/new.mp4']);
  });
});
