// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readAppVersion, useAppUpdate } from '../use-app-update';

const fetchMock = vi.fn();
const manifest = (version: unknown): Response => new Response(JSON.stringify({ version }));
const settle = async (): Promise<void> => { await act(async () => { await Promise.resolve(); }); };
const visibility = (value: string): void => {
  Object.defineProperty(document, 'visibilityState', { configurable: true, value });
  document.dispatchEvent(new Event('visibilitychange'));
};
beforeEach(() => {
  vi.useFakeTimers();
  vi.stubEnv('PROD', true);
  vi.stubEnv('VITE_APP_VERSION', 'current');
  vi.stubGlobal('fetch', fetchMock);
  fetchMock.mockReset().mockImplementation(() => Promise.resolve(manifest('next')));
  sessionStorage.clear();
  visibility('visible');
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); });

describe('Project release detection', () => {
  it.each([null, {}, { version: '' }, { version: ' ' }, { version: 1 }, { version: '<html>' }])('ignores malformed manifest %j', value => {
    expect(readAppVersion(value)).toBeNull();
  });
  it('is opt-in for a versioned production build', async () => {
    vi.stubEnv('PROD', false);
    const first = renderHook(useAppUpdate); await settle(); first.unmount();
    vi.stubEnv('PROD', true); vi.stubEnv('VITE_APP_VERSION', '');
    renderHook(useAppUpdate); await settle();
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it('detects a release without refreshing and bypasses caches', async () => {
    const { result } = renderHook(useAppUpdate); await settle();
    expect(result.current.version).toBe('next');
    expect(fetchMock).toHaveBeenCalledWith(expect.stringContaining('/app-version.json'), expect.objectContaining({ cache: 'no-store', credentials: 'omit' }));
  });
  it('clears a stale notice when deployment returns to the running bundle', async () => {
    const { result } = renderHook(useAppUpdate); await settle();
    fetchMock.mockResolvedValue(manifest('current'));
    await act(async () => { await vi.advanceTimersByTimeAsync(210_000); });
    expect(result.current.version).toBeNull();
  });
  it('treats rollback versions as different, not older', async () => {
    fetchMock.mockResolvedValue(manifest('previous'));
    const { result } = renderHook(useAppUpdate); await settle();
    expect(result.current.version).toBe('previous');
  });
  it('remembers Later across Project mounts but permits another release', async () => {
    fetchMock.mockResolvedValue(manifest('defer-me'));
    const first = renderHook(useAppUpdate); await settle();
    act(() => first.result.current.dismiss()); first.unmount();
    const second = renderHook(useAppUpdate); await settle();
    expect(second.result.current.version).toBeNull();
    fetchMock.mockResolvedValue(manifest('new-after-defer'));
    await act(async () => { await vi.advanceTimersByTimeAsync(210_000); });
    expect(second.result.current.version).toBe('new-after-defer');
  });
  it('restores session choices after a page reload', async () => {
    sessionStorage.setItem('breatic:deferred-app-versions', '["from-session"]');
    fetchMock.mockResolvedValue(manifest('from-session'));
    const { result } = renderHook(useAppUpdate); await settle();
    expect(result.current.version).toBeNull();
  });
  it.each([new Response('bad JSON'), new Response('error', { status: 503 }), new Response('<html>SPA fallback</html>')])('silently ignores invalid HTTP responses', async response => {
    fetchMock.mockResolvedValue(response);
    const { result } = renderHook(useAppUpdate); await settle();
    await act(async () => { await vi.advanceTimersByTimeAsync(10_000); });
    expect(result.current.version).toBeNull();
  });
  it('pauses hidden tabs and resumes without focus-request bursts', async () => {
    const { unmount } = renderHook(useAppUpdate); await settle();
    act(() => visibility('hidden'));
    await act(async () => { await vi.advanceTimersByTimeAsync(600_000); });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    fetchMock.mockResolvedValue(manifest('next-visible'));
    act(() => visibility('visible')); await settle();
    act(() => { visibility('hidden'); visibility('visible'); }); await settle();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    unmount();
    await act(async () => { await vi.advanceTimersByTimeAsync(600_000); });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
  it('aborts timeouts and in-flight requests on unmount without overlap', async () => {
    let signal: AbortSignal | undefined;
    fetchMock.mockImplementation((_url: string, init: RequestInit) => new Promise((_resolve, reject) => {
      signal = init.signal as AbortSignal;
      signal.addEventListener('abort', () => reject(new Error('aborted')));
    }));
    const { unmount } = renderHook(useAppUpdate);
    act(() => visibility('visible'));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await act(async () => { await vi.advanceTimersByTimeAsync(10_000); });
    expect(signal?.aborted).toBe(true);
    await act(async () => { await vi.advanceTimersByTimeAsync(210_000); });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    unmount(); expect(signal?.aborted).toBe(true);
  });
});
