// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useVideoFrameThumbnails } from '../video/use-video-frame-thumbnails';

const state = vi.hoisted(() => ({ dispose: vi.fn(), requested: [] as number[], canvas: null as HTMLCanvasElement | null }));
vi.mock('mediabunny', () => ({
  ALL_FORMATS: [],
  Input: class {
    getPrimaryVideoTrack = vi.fn(async () => ({ canDecode: async () => true }));
    dispose = state.dispose;
  },
  UrlSource: class {},
  CanvasSink: class {
    async *canvasesAtTimestamps(times: Iterable<number>) {
      for (const pts of times) { state.requested.push(pts); yield { timestamp: pts, canvas: state.canvas }; }
    }
  },
}));

beforeEach(() => { state.canvas = document.createElement('canvas'); vi.spyOn(state.canvas, 'toDataURL').mockReturnValue('data:image/png;base64,actual-frame'); });
afterEach(() => vi.restoreAllMocks());

describe('authoritative frame thumbnail lifetime', () => {
  it('decodes the requested actual PTS without deriving frames from FPS', async () => {
    state.requested = [];
    state.dispose.mockClear();
    const { result, unmount } = renderHook(() => useVideoFrameThumbnails('https://media.example.test/source.mp4', [{ frameIndex: 2, pts: 0.12 }]));
    await waitFor(() => expect(result.current.status).toBe('ready'));
    expect(state.requested).toEqual([0.12]);
    expect(result.current.frames).toEqual([{ frameIndex: 2, pts: 0.12, url: 'data:image/png;base64,actual-frame' }]);
    unmount();
    expect(state.dispose).toHaveBeenCalledTimes(1);
  });
  it('disposes every independent decoder after a source replacement and detach', async () => {
    state.dispose.mockClear();
    const { result, rerender, unmount } = renderHook(({ url }) => useVideoFrameThumbnails(url, [{ frameIndex: 0, pts: 0 }]), { initialProps: { url: 'https://media.example.test/a.mp4' } });
    await waitFor(() => expect(result.current.status).toBe('ready'));
    rerender({ url: 'https://media.example.test/b.mp4' });
    await waitFor(() => expect(state.dispose).toHaveBeenCalledTimes(2));
    unmount();
    expect(state.dispose).toHaveBeenCalledTimes(2);
  });
});
