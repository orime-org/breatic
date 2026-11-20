// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import * as React from 'react';
import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useMediaSurface } from '../use-media-surface';
import type { VideoPresentationSource, VideoRendererCallbacks, VideoRendererFactory } from '../types';
import { PRESENTED, presentedBundle, presentedDisplay } from '@web/test-utils/video-presentation';

// Reviewed resource lifecycle invariants for inner#1306. §97 (D10-1; design §3.3, §7.8): the source carries the selected
// bundle and its alpha-packed manifest (null for native); the earlier `presentation: VideoPresentation` descriptor with
// its `state` is gone (fixtures migrated, 4.4.5).
const CANONICAL = 'https://assets.example/canonical.webm';
const bundleOf = (versionId: string, fingerprint: string = PRESENTED.fingerprint, url = CANONICAL): ReturnType<typeof presentedBundle> =>
  presentedBundle(url, { sourceFingerprint: fingerprint, versionId, display: presentedDisplay(160, 96, 25) });
const source = { canonicalURL: CANONICAL, sourceFingerprint: PRESENTED.fingerprint, presentation: bundleOf(PRESENTED.versionId), manifest: null } as unknown as VideoPresentationSource;

let host: HTMLDivElement;
let hostRef: React.RefObject<HTMLDivElement | null>;
let sessions: { element: HTMLVideoElement; callbacks: VideoRendererCallbacks; dispose: ReturnType<typeof vi.fn> }[];
let createRenderer: VideoRendererFactory;

beforeEach(() => {
  host = document.createElement('div');
  document.body.append(host);
  hostRef = { current: host };
  sessions = [];
  createRenderer = vi.fn((_host, _source, callbacks) => {
    const element = document.createElement('video');
    const dispose = vi.fn();
    sessions.push({ element, callbacks, dispose });
    return { dispose };
  });
  vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {});
  vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue(undefined);
  vi.spyOn(HTMLMediaElement.prototype, 'load').mockImplementation(() => {});
});
afterEach(() => { cleanup(); host.remove(); vi.restoreAllMocks(); });

function mount(active = true): ReturnType<typeof renderHook<ReturnType<typeof useMediaSurface>, { source: VideoPresentationSource; active: boolean }>> {
  return renderHook((props) => useMediaSurface({ host: hostRef, source: props.source, active: props.active, createRenderer }), { initialProps: { source, active } });
}

function ready(index = 0): void {
  const session = sessions[index];
  act(() => session.callbacks.ready(session.element, session.element));
}

describe('effect-owned video surface lifecycle', () => {
  it('waits for the actual element and exposes original dimensions with a paused element', () => {
    const { result } = mount();
    expect(result.current.status).toBe('loading');
    expect(result.current.binding).toBeNull();
    ready();
    expect(result.current.status).toBe('ready');
    expect(result.current.binding?.element).toBe(sessions[0].element);
    expect(result.current.binding?.original).toEqual({ width: 160, height: 96, duration: 1 });
    expect(sessions[0].element.pause).toHaveBeenCalled();
    expect(result.current.binding?.getPresentedFrame()).toBeNull();
  });

  it('releases the old resource before binding another source and ignores old callbacks', () => {
    const { result, rerender } = mount();
    ready();
    const epoch = result.current.binding!.sourceEpoch;
    rerender({ source: { ...source, canonicalURL: 'https://assets.example/b.mp4', sourceFingerprint: 'b'.repeat(64), presentation: bundleOf(PRESENTED.versionId, 'b'.repeat(64), 'https://assets.example/b.mp4') } as unknown as VideoPresentationSource, active: true });
    expect(sessions[0].dispose).toHaveBeenCalledTimes(1);
    expect(result.current.status).toBe('loading');
    ready(0);
    expect(result.current.binding).toBeNull();
    ready(1);
    expect(result.current.binding?.element).toBe(sessions[1].element);
    expect(result.current.binding!.sourceEpoch).toBeGreaterThan(epoch);
  });

  it('releases on Space inactivity and recreates the actual element when active again', () => {
    const { result, rerender } = mount();
    ready();
    rerender({ source, active: false });
    expect(result.current.status).toBe('detached');
    expect(result.current.binding).toBeNull();
    expect(sessions[0].dispose).toHaveBeenCalledTimes(1);
    ready();
    expect(result.current.status).toBe('detached');
    rerender({ source, active: true });
    ready(1);
    expect(result.current.binding?.element).toBe(sessions[1].element);
  });

  it('releases every StrictMode instance once and ignores the disposed instance', () => {
    const { result, unmount } = renderHook(() => useMediaSurface({ host: hostRef, source, active: true, createRenderer }), { wrapper: React.StrictMode });
    expect(sessions).toHaveLength(2);
    expect(sessions[0].dispose).toHaveBeenCalledTimes(1);
    ready(0);
    expect(result.current.status).toBe('loading');
    ready(1);
    expect(result.current.binding?.element).toBe(sessions[1].element);
    unmount();
    expect(sessions.map((session) => session.dispose.mock.calls.length)).toEqual([1, 1]);
  });

  it('fails the current resource, rejects a late ready and rebuilds only on retry', () => {
    const { result } = mount();
    act(() => sessions[0].callbacks.error('decode-failed'));
    expect(result.current.status).toBe('failed');
    expect(result.current.error).toBe('decode-failed');
    expect(sessions[0].dispose).toHaveBeenCalledTimes(1);
    ready();
    expect(result.current.status).toBe('failed');
    act(() => result.current.retry());
    expect(result.current.status).toBe('loading');
    ready(1);
    expect(result.current.status).toBe('ready');
  });

  // §97: a source exists only for a selected bundle, so the earlier unknown/preparing/failed descriptor states are gone;
  // what remains is that a bundle of another source never reaches a renderer.
  it('does not create a renderer for a bundle of another source', () => {
    const { rerender } = mount(false);
    rerender({ source: { ...source, presentation: bundleOf(PRESENTED.versionId, 'b'.repeat(64)) } as unknown as VideoPresentationSource, active: true });
    expect(createRenderer).toHaveBeenCalledTimes(0);
  });

  // §97 D10-1 (design §3.3 runtimeSourceKey = JSON([canonicalURL, sourceFingerprint, versionId]), §7.8): the key's third
  // part is the version the surface shows. A new version changes it only once its own resource is ready; until then no
  // binding reports the new version.
  it('reports the shown version in the runtime source key and moves it only when the new version is ready', () => {
    const next = 'b'.repeat(64);
    const oldKey = JSON.stringify([CANONICAL, PRESENTED.fingerprint, PRESENTED.versionId]);
    const { result, rerender } = mount();
    ready();
    expect(result.current.binding?.sourceKey).toBe(oldKey);
    rerender({ source: { ...source, presentation: bundleOf(next) } as unknown as VideoPresentationSource, active: true });
    expect(result.current.binding?.sourceKey ?? oldKey).toBe(oldKey);
    ready(1);
    expect(result.current.binding?.sourceKey).toBe(JSON.stringify([CANONICAL, PRESENTED.fingerprint, next]));
  });

  it('loses the current frame on context loss and rebuilds on context restoration', () => {
    const { result } = mount();
    ready();
    const epoch = result.current.binding!.sourceEpoch;
    act(() => sessions[0].callbacks.contextLost());
    expect(result.current.status).toBe('failed');
    expect(result.current.binding).toBeNull();
    act(() => sessions[0].callbacks.contextRestored());
    expect(sessions[0].dispose).toHaveBeenCalledTimes(1);
    ready(1);
    expect(result.current.binding!.sourceEpoch).toBeGreaterThan(epoch);
  });
  it('synchronously forwards only committed draws to a mounted timeline consumer', () => {
    const onPresentedFrame = vi.fn();
    const { result, unmount } = renderHook(() => useMediaSurface({ host: hostRef, source, active: true, createRenderer, onPresentedFrame }));
    ready();
    act(() => sessions[0].callbacks.frame(0.125, 0));
    expect(onPresentedFrame).toHaveBeenCalledTimes(1);
    expect(onPresentedFrame).toHaveBeenLastCalledWith({ sourceKey: result.current.binding!.sourceKey, sourceEpoch: result.current.binding!.sourceEpoch, seekEpoch: 0, mediaTime: 0.125, surface: sessions[0].element });
    act(() => result.current.binding!.seek(0.75));
    act(() => sessions[0].callbacks.frame(0.25, 0));
    expect(onPresentedFrame).toHaveBeenCalledTimes(1);
    act(() => sessions[0].callbacks.frame(0.75, result.current.binding!.getSeekEpoch()));
    expect(onPresentedFrame).toHaveBeenCalledTimes(2);
    unmount();
    act(() => sessions[0].callbacks.frame(0.9, 1));
    expect(onPresentedFrame).toHaveBeenCalledTimes(2);
  });

  it('binds native transport at metadata before a decoder consumer requests its in-point', async () => {
    const onPresentedFrame = vi.fn();
    const { result } = renderHook(() => useMediaSurface({ host: hostRef, source, active: true, onPresentedFrame }));
    const element = host.querySelector('video')!;
    Object.defineProperties(element, { readyState: { value: 1 }, videoWidth: { value: 160 }, videoHeight: { value: 96 } });
    act(() => element.dispatchEvent(new Event('loadedmetadata')));
    expect(result.current.status).toBe('ready');
    expect(result.current.binding?.element).toBe(element);
    expect(result.current.binding?.getPresentedFrame()).toBeNull();
    expect(onPresentedFrame).toHaveBeenCalledTimes(0);
    act(() => result.current.binding!.seek(0.75));
    expect(element.currentTime).toBe(0.75);
    expect(result.current.binding?.getPresentedFrame()).toBeNull();
    await act(async () => result.current.binding!.play());
    expect(element.play).toHaveBeenCalledTimes(1);
    const pauses = vi.mocked(element.pause).mock.calls.length;
    act(() => result.current.binding!.pause());
    expect(element.pause).toHaveBeenCalledTimes(pauses + 1);
    expect(onPresentedFrame).toHaveBeenCalledTimes(0);
  });

  it.each([
    ['native', 2.375], ['alpha_ready', 2.375], ['native', Number.NaN],
  ] as const)('seeks the actual %s clock beyond format duration with actual duration %s', (state, duration) => {
    const packed = { storageKey: 'video/packed.mp4', url: 'https://assets.example/packed.mp4', etag: '"packed"', size: 8192, sha256: '9'.repeat(64), contentType: 'video/mp4' };
    // A 17-frame grid at 8 fps lasts 17/8 = 2.125 s (P.display, §3.5).
    const clockBundle = presentedBundle(CANONICAL, { display: { ...presentedDisplay(160, 96, 17), fps: { numerator: 8, denominator: 1 } }, original: { width: 160, height: 96, duration: 2.125 },
      ...(state === 'alpha_ready' ? { playback: { kind: 'alpha-packed' as const, carrier: packed, manifest: { ...packed, storageKey: 'video/packed.json', url: 'https://assets.example/packed.json', contentType: 'application/json' } } } : {}) });
    const clockSource = { ...source, presentation: clockBundle, manifest: state === 'alpha_ready' ? { schemaVersion: 1, packed, packedWidth: 320, packedHeight: 96, colorRect: { x: 0, y: 0, width: 160, height: 96 }, alphaRect: { x: 160, y: 0, width: 160, height: 96 } } : null } as unknown as VideoPresentationSource;
    const { result } = renderHook(() => useMediaSurface({ host: hostRef, source: clockSource, active: true, createRenderer }));
    const session = sessions[0];
    Object.defineProperty(session.element, 'duration', { value: duration });
    const surface = state === 'alpha_ready' ? document.createElement('canvas') : session.element;
    act(() => session.callbacks.ready(session.element, surface));
    act(() => session.callbacks.frame(1, result.current.binding!.getSeekEpoch()));
    const previousEpoch = result.current.binding!.getSeekEpoch();
    expect(result.current.binding!.getPresentedFrame()?.mediaTime).toBe(1);
    act(() => result.current.binding!.seek(2.25));
    expect(session.element.currentTime).toBe(2.25);
    expect(result.current.binding!.original.duration).toBe(2.125);
    expect(result.current.binding!.getSeekEpoch()).toBeGreaterThan(previousEpoch);
    expect(result.current.binding!.getPresentedFrame()).toBeNull();
    act(() => session.callbacks.frame(2.25, previousEpoch));
    expect(result.current.binding!.getPresentedFrame()).toBeNull();
    act(() => session.callbacks.frame(2.25, result.current.binding!.getSeekEpoch()));
    expect(result.current.binding!.getPresentedFrame()?.mediaTime).toBe(2.25);
  });

});

/**
 * Makes an element's play and pause follow the HTML rule: pause rejects every pending play promise with an AbortError,
 * in a later task.
 * @param element - The element.
 * @throws {never} Never.
 */
function followPlayRule(element: HTMLVideoElement): void {
  let pending: ((error: unknown) => void)[] = [];
  vi.mocked(element.play).mockImplementation(() => new Promise<void>((_resolve, reject) => { pending.push(reject); }));
  vi.mocked(element.pause).mockImplementation(() => {
    const rejected = pending;
    pending = [];
    setTimeout(() => { for (const reject of rejected) reject(new DOMException('The play() request was interrupted by a call to pause().', 'AbortError')); }, 0);
  });
}

describe('a play interrupted by a later pause (split segment preview pressed twice)', () => {
  it('passes the AbortError on without pausing the player again or reporting the play as refused', async () => {
    const { result } = mount();
    ready();
    const element = sessions[0].element;
    followPlayRule(element);
    const binding = result.current.binding!;
    const first = binding.play();
    binding.pause();
    // The second play is still pending when the test unmounts, whose release pauses and so rejects it.
    binding.play().catch(() => undefined);
    const pauses = vi.mocked(element.pause).mock.calls.length;
    await act(async () => { await expect(first).rejects.toMatchObject({ name: 'AbortError' }); });
    expect(element.pause).toHaveBeenCalledTimes(pauses);
    expect(result.current.error).toBeNull();
  });

  it('still reports a play the player refuses', async () => {
    const { result } = mount();
    ready();
    vi.mocked(sessions[0].element.play).mockRejectedValue(new DOMException('Not allowed', 'NotAllowedError'));
    await act(async () => { await expect(result.current.binding!.play()).rejects.toMatchObject({ name: 'NotAllowedError' }); });
    expect(result.current.error).toBe('play-rejected');
  });
});
