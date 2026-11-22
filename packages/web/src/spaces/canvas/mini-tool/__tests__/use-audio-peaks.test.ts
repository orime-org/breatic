// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * When the cut band reads an audio source's peaks, and when it reads them
 * again (inner#1305 §4.4, #1580): a band open before the peaks are written
 * reads them once more when the server announces them for its audio, and
 * never on a timer.
 */

import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const fetchAudioPeaks = vi.hoisted(() => vi.fn());

vi.mock('@web/spaces/canvas/mini-tool/audio-peaks', () => ({ fetchAudioPeaks }));

const { useAudioPeaks } = await import('@web/spaces/canvas/mini-tool/use-audio-peaks');
const { announceAudioPeaksReady } = await import('@web/spaces/canvas/mini-tool/audio-peaks-ready');

const URL = 'https://cdn/audio/a.mp3';
const OTHER = 'https://cdn/audio/b.mp3';

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
    const { result } = renderHook(() => useAudioPeaks(URL));
    expect(result.current).toEqual({ kind: 'loading' });

    await settle();

    expect(result.current).toEqual({ kind: 'ready', peaks: [1, 2] });
    expect(fetchAudioPeaks).toHaveBeenCalledTimes(1);
  });

  it('G-06 reads missing peaks once more when they are announced for its audio, and shows them', async () => {
    fetchAudioPeaks.mockResolvedValueOnce('missing').mockResolvedValueOnce([9]);
    const { result } = renderHook(() => useAudioPeaks(URL));
    await settle();
    expect(result.current).toEqual({ kind: 'missing' });

    act(() => { announceAudioPeaksReady(URL); });
    await settle();

    expect(fetchAudioPeaks).toHaveBeenCalledTimes(2);
    expect(result.current).toEqual({ kind: 'ready', peaks: [9] });
  });

  it('G-07 does not read when another audio\'s peaks are announced', async () => {
    fetchAudioPeaks.mockResolvedValue('missing');
    renderHook(() => useAudioPeaks(URL));
    await settle();

    act(() => { announceAudioPeaksReady(OTHER); });
    await settle();

    expect(fetchAudioPeaks).toHaveBeenCalledTimes(1);
  });

  it('G-08 does not read again once its peaks are there', async () => {
    fetchAudioPeaks.mockResolvedValue([1, 2]);
    renderHook(() => useAudioPeaks(URL));
    await settle();

    act(() => { announceAudioPeaksReady(URL); });
    await settle();

    expect(fetchAudioPeaks).toHaveBeenCalledTimes(1);
  });

  it('G-09 reads missing peaks only once while nothing is announced', async () => {
    fetchAudioPeaks.mockResolvedValue('missing');
    const { result } = renderHook(() => useAudioPeaks(URL));
    await settle();

    await act(async () => { await vi.advanceTimersByTimeAsync(600_000); });

    expect(fetchAudioPeaks).toHaveBeenCalledTimes(1);
    expect(result.current).toEqual({ kind: 'missing' });
  });

  it('reads an invalid file once', async () => {
    fetchAudioPeaks.mockResolvedValue('invalid');
    const { result } = renderHook(() => useAudioPeaks(URL));
    await settle();

    await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });

    expect(fetchAudioPeaks).toHaveBeenCalledTimes(1);
    expect(result.current).toEqual({ kind: 'invalid' });
  });

  it('stops reading when the band closes', async () => {
    fetchAudioPeaks.mockResolvedValue('missing');
    const { unmount } = renderHook(() => useAudioPeaks(URL));
    await settle();

    unmount();
    act(() => { announceAudioPeaksReady(URL); });
    await settle();

    expect(fetchAudioPeaks).toHaveBeenCalledTimes(1);
    expect(fetchAudioPeaks.mock.calls[0]?.[1]).toHaveProperty('aborted', true);
  });
});
