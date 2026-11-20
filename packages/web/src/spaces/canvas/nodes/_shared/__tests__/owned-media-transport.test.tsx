// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import * as React from 'react';
import { act, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useMediaPlayer } from '../use-media-player';
import type { MediaSurfaceBinding } from '../../../video-presentation/types';

function owner(sourceKey: string): MediaSurfaceBinding {
  const element = document.createElement('video');
  const container = document.createElement('div');
  Object.defineProperty(container, 'requestFullscreen', { value: vi.fn().mockResolvedValue(undefined) });
  Object.defineProperty(element, 'pause', { value: vi.fn() });
  Object.defineProperty(element, 'play', { value: vi.fn().mockResolvedValue(undefined) });
  return {
    sourceKey, sourceEpoch: 1, element, surface: document.createElement('canvas'), container,
    original: { width: 1080, height: 1920, duration: 10 }, getSeekEpoch: () => 0, getPresentedFrame: () => null,
    seek: vi.fn(), play: vi.fn().mockResolvedValue(undefined), pause: vi.fn(),
  };
}

afterEach(() => vi.restoreAllMocks());

describe('existing controls on the actual presentation owner', () => {
  // Full screen left this hook for the corner button (`MediaFullscreen`), so only play and seek are the owner's here.
  it('uses the owned play and seek while the old element ref is empty', () => {
    const owned = owner('canonical-a');
    const ref: React.RefObject<HTMLMediaElement | null> = { current: null };
    const { result } = renderHook(() => useMediaPlayer(ref, 10, undefined, owned));
    act(() => { result.current.togglePlay(); result.current.seekFraction(0.25); });
    expect(owned.play).toHaveBeenCalledOnce();
    expect(owned.seek).toHaveBeenCalledExactlyOnceWith(2.5);
    expect(owned.element.currentTime).toBe(0);
  });

  it('rebinds native event listeners to the new owned element and ignores the released source', () => {
    const first = owner('canonical-a'); const second = owner('canonical-b');
    first.element.currentTime = 3;
    const ref: React.RefObject<HTMLMediaElement | null> = { current: null };
    const { result, rerender, unmount } = renderHook(({ owned }) => useMediaPlayer(ref, 10, undefined, owned), { initialProps: { owned: first } });
    expect(result.current.currentTime).toBe(3);
    rerender({ owned: second });
    expect(result.current.currentTime).toBe(0);
    act(() => { first.element.currentTime = 8; first.element.dispatchEvent(new Event('timeupdate')); });
    expect(result.current.currentTime).toBe(0);
    act(() => { second.element.currentTime = 4; second.element.dispatchEvent(new Event('timeupdate')); });
    expect(result.current.currentTime).toBe(4);
    unmount();
    expect(first.pause).toHaveBeenCalledOnce();
    expect(second.pause).toHaveBeenCalledOnce();
  });

  it('changes volume and mute on the actual packed-video element and reads its native state', () => {
    const owned = owner('canonical-a');
    const { result } = renderHook(() => useMediaPlayer({ current: null }, 10, undefined, owned));
    act(() => { result.current.setVolumeLevel(0.3); result.current.toggleMute(); owned.element.dispatchEvent(new Event('volumechange')); });
    expect(owned.element.volume).toBe(0.3);
    expect(owned.element.muted).toBe(true);
    expect(result.current.volume).toBe(0.3);
    expect(result.current.muted).toBe(true);
  });
});
