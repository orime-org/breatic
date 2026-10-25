// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import * as React from 'react';
import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useMediaSurface } from '../use-media-surface';
import type { VideoPresentationSource, VideoRendererCallbacks, VideoRendererFactory } from '../types';

// Independent expected: approved canvas design sections 18–20, inner#1306.
const source: VideoPresentationSource = {
  canonicalURL: 'https://assets.example/canonical.webm',
  sourceFingerprint: 'a'.repeat(64),
  presentation: { schemaVersion: 1, sourceFingerprint: 'a'.repeat(64), original: { width: 160, height: 96, duration: 1 }, state: 'native' },
};

let host: HTMLDivElement;
let sessions: { element: HTMLVideoElement; callbacks: VideoRendererCallbacks; dispose: ReturnType<typeof vi.fn> }[];
let createRenderer: VideoRendererFactory;

beforeEach(() => {
  host = document.createElement('div');
  document.body.append(host);
  sessions = [];
  createRenderer = vi.fn((_host, _source, callbacks) => {
    const element = document.createElement('video');
    const dispose = vi.fn();
    sessions.push({ element, callbacks, dispose });
    return { dispose };
  });
  vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {});
  vi.spyOn(HTMLMediaElement.prototype, 'load').mockImplementation(() => {});
});
afterEach(() => { host.remove(); vi.restoreAllMocks(); });

function mount(active = true): ReturnType<typeof renderHook<ReturnType<typeof useMediaSurface>, { source: VideoPresentationSource; active: boolean }>> {
  return renderHook((props) => useMediaSurface({ host: { current: host }, source: props.source, active: props.active, createRenderer }), { initialProps: { source, active } });
}

function ready(index = 0): void {
  const session = sessions[index]!;
  act(() => session.callbacks.ready(session.element, session.element));
}

describe('effect-owned video surface lifecycle', () => {
  it('waits for the actual element and exposes original dimensions with a paused element', () => {
    const { result } = mount();
    expect(result.current.status).toBe('loading');
    expect(result.current.binding).toBeNull();
    ready();
    expect(result.current.status).toBe('ready');
    expect(result.current.binding?.element).toBe(sessions[0]!.element);
    expect(result.current.binding?.original).toEqual({ width: 160, height: 96, duration: 1 });
    expect(sessions[0]!.element.pause).toHaveBeenCalled();
    expect(result.current.binding?.getPresentedFrame()).toBeNull();
  });

  it('releases the old resource before binding another source and ignores old callbacks', () => {
    const { result, rerender } = mount();
    ready();
    const epoch = result.current.binding!.sourceEpoch;
    rerender({ source: { ...source, canonicalURL: 'https://assets.example/b.mp4', sourceFingerprint: 'b'.repeat(64), presentation: { ...source.presentation, sourceFingerprint: 'b'.repeat(64) } }, active: true });
    expect(sessions[0]!.dispose).toHaveBeenCalledTimes(1);
    expect(result.current.status).toBe('loading');
    ready(0);
    expect(result.current.binding).toBeNull();
    ready(1);
    expect(result.current.binding?.element).toBe(sessions[1]!.element);
    expect(result.current.binding!.sourceEpoch).toBeGreaterThan(epoch);
  });

  it('releases on Space inactivity and recreates the actual element when active again', () => {
    const { result, rerender } = mount();
    ready();
    rerender({ source, active: false });
    expect(result.current.status).toBe('detached');
    expect(result.current.binding).toBeNull();
    expect(sessions[0]!.dispose).toHaveBeenCalledTimes(1);
    ready();
    expect(result.current.status).toBe('detached');
    rerender({ source, active: true });
    ready(1);
    expect(result.current.binding?.element).toBe(sessions[1]!.element);
  });

  it('releases every StrictMode instance once and ignores the disposed instance', () => {
    const { result, unmount } = renderHook(() => useMediaSurface({ host: { current: host }, source, active: true, createRenderer }), { wrapper: React.StrictMode });
    expect(sessions).toHaveLength(2);
    expect(sessions[0]!.dispose).toHaveBeenCalledTimes(1);
    ready(0);
    expect(result.current.status).toBe('loading');
    ready(1);
    expect(result.current.binding?.element).toBe(sessions[1]!.element);
    unmount();
    expect(sessions.map((session) => session.dispose.mock.calls.length)).toEqual([1, 1]);
  });

  it('fails the current resource, rejects a late ready and rebuilds only on retry', () => {
    const { result } = mount();
    act(() => sessions[0]!.callbacks.error('decode-failed'));
    expect(result.current.status).toBe('failed');
    expect(result.current.error).toBe('decode-failed');
    expect(sessions[0]!.dispose).toHaveBeenCalledTimes(1);
    ready();
    expect(result.current.status).toBe('failed');
    act(() => result.current.retry());
    expect(result.current.status).toBe('loading');
    ready(1);
    expect(result.current.status).toBe('ready');
  });

  it('does not create a native renderer for unknown, preparing or failed presentation', () => {
    const { rerender } = mount(false);
    for (const state of ['classifying', 'alpha_pending', 'failed'] as const) {
      rerender({ source: { ...source, presentation: { ...source.presentation, state, attempt: { jobId: 'accepted', deadlineAt: 7201000 }, ...(state === 'failed' ? { error: 'unsupported-format' } : {}) } }, active: true });
    }
    expect(createRenderer).toHaveBeenCalledTimes(0);
  });

  it('loses the current frame on context loss and rebuilds on context restoration', () => {
    const { result } = mount();
    ready();
    const epoch = result.current.binding!.sourceEpoch;
    act(() => sessions[0]!.callbacks.contextLost());
    expect(result.current.status).toBe('failed');
    expect(result.current.binding).toBeNull();
    act(() => sessions[0]!.callbacks.contextRestored());
    expect(sessions[0]!.dispose).toHaveBeenCalledTimes(1);
    ready(1);
    expect(result.current.binding!.sourceEpoch).toBeGreaterThan(epoch);
  });
});
