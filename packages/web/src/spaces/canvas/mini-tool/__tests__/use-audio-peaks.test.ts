// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * When the cut band reads an audio source's peaks, and when it reads them
 * again (inner#1305 §4.4): a band open before the peaks are written keeps
 * reading on an interval until they land or its time runs out.
 */

import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const fetchAudioPeaks = vi.hoisted(() => vi.fn());

vi.mock('@web/spaces/canvas/mini-tool/audio-peaks', () => ({ fetchAudioPeaks }));

const { useAudioPeaks } = await import('@web/spaces/canvas/mini-tool/use-audio-peaks');

const URL = 'https://cdn/audio/a.mp3';
const RETRY = { everyMs: 5000, forMs: 12_000 };

/**
 * Let the pending reads settle.
 */
async function settle(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  fetchAudioPeaks.mockReset();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('useAudioPeaks', () => {
  it('starts loading and answers the peaks it read', async () => {
    fetchAudioPeaks.mockResolvedValue([1, 2]);
    const { result } = renderHook(() => useAudioPeaks(URL, RETRY));
    expect(result.current).toEqual({ kind: 'loading' });

    await settle();

    expect(result.current).toEqual({ kind: 'ready', peaks: [1, 2] });
    expect(fetchAudioPeaks).toHaveBeenCalledTimes(1);
  });

  it('reads missing peaks again on the interval and shows them once they land', async () => {
    fetchAudioPeaks.mockResolvedValueOnce('missing').mockResolvedValueOnce('missing').mockResolvedValueOnce([9]);
    const { result } = renderHook(() => useAudioPeaks(URL, RETRY));
    await settle();
    expect(result.current).toEqual({ kind: 'missing' });

    await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
    expect(fetchAudioPeaks).toHaveBeenCalledTimes(2);
    await act(async () => { await vi.advanceTimersByTimeAsync(5000); });

    expect(fetchAudioPeaks).toHaveBeenCalledTimes(3);
    expect(result.current).toEqual({ kind: 'ready', peaks: [9] });
  });

  it('stops reading once its time is up', async () => {
    fetchAudioPeaks.mockResolvedValue('missing');
    renderHook(() => useAudioPeaks(URL, RETRY));
    await settle();

    await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });

    // The first read, then one at 5 s and one at 10 s; 15 s is past 12 s.
    expect(fetchAudioPeaks).toHaveBeenCalledTimes(3);
  });

  it('reads once when it is not to read again', async () => {
    fetchAudioPeaks.mockResolvedValue('missing');
    const { result } = renderHook(() => useAudioPeaks(URL, null));
    await settle();

    await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });

    expect(fetchAudioPeaks).toHaveBeenCalledTimes(1);
    expect(result.current).toEqual({ kind: 'missing' });
  });

  it('reads an invalid file once', async () => {
    fetchAudioPeaks.mockResolvedValue('invalid');
    const { result } = renderHook(() => useAudioPeaks(URL, RETRY));
    await settle();

    await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });

    expect(fetchAudioPeaks).toHaveBeenCalledTimes(1);
    expect(result.current).toEqual({ kind: 'invalid' });
  });

  it('stops reading when the band closes', async () => {
    fetchAudioPeaks.mockResolvedValue('missing');
    const { unmount } = renderHook(() => useAudioPeaks(URL, RETRY));
    await settle();

    unmount();
    await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });

    expect(fetchAudioPeaks).toHaveBeenCalledTimes(1);
    expect(fetchAudioPeaks.mock.calls[0]?.[1]).toHaveProperty('aborted', true);
  });
});
