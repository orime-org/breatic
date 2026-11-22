// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * inner#1306 frames-split §5.5: a video focus crop takes the grid frame the node's player last drew. The player keeps that
 * frame from its own mount, so a video paused before the crop opened still names its frame; a frame from another source,
 * resource or seek is not current.
 */
import { renderHook } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { MediaPlayerVideoSnapshot } from '@web/spaces/canvas/nodes/_shared/MediaPlayer';
import type { PresentedMediaFrame } from '../types';
import { useCanvasVideoBindings } from '../use-canvas-video-bindings';

const URL_A = 'https://assets.example.test/a.mp4';

/**
 * A ready node attachment whose player last drew `frame`.
 * @param frame - What the player's clock holds.
 * @param seekEpoch - The binding's current seek identity.
 * @returns The snapshot.
 */
function attached(frame: PresentedMediaFrame | null, seekEpoch = 3): MediaPlayerVideoSnapshot {
  const element = document.createElement('video');
  return { status: 'ready', error: null, binding: { sourceKey: 'key-a', sourceEpoch: 2, element, surface: element, container: document.createElement('div'),
    original: { width: 640, height: 360, duration: 6 }, getSeekEpoch: () => seekEpoch, getPresentedFrame: () => frame,
    seek: () => undefined, play: () => Promise.resolve(), pause: () => undefined } };
}

/**
 * A frame the player drew.
 * @param over - Fields that differ from the binding's.
 * @returns The frame.
 */
function drawn(over: Partial<PresentedMediaFrame> = {}): PresentedMediaFrame {
  return { sourceKey: 'key-a', sourceEpoch: 2, seekEpoch: 3, mediaTime: 2.04, surface: document.createElement('video'), ...over };
}

describe('the frame a node player last drew', () => {
  it('FC01 is read for a node that hosts no panel, as the player drew it before anything asked', () => {
    const { result } = renderHook(() => useCanvasVideoBindings(null, null));
    result.current.onVideoBinding('node-2', URL_A, attached(drawn()));
    expect(result.current.presentedFrameOf('node-2', URL_A)?.mediaTime).toBe(2.04);
  });

  it.each([
    ['another source', drawn({ sourceKey: 'key-b' })],
    ['another resource', drawn({ sourceEpoch: 1 })],
    ['an earlier seek', drawn({ seekEpoch: 2 })],
  ])('FC02 is not current when it is from %s', (_case, frame) => {
    const { result } = renderHook(() => useCanvasVideoBindings(null, null));
    result.current.onVideoBinding('node-2', URL_A, attached(frame));
    expect(result.current.presentedFrameOf('node-2', URL_A)).toBeNull();
  });

  it('FC03 is unknown for another URL or a detached node', () => {
    const { result } = renderHook(() => useCanvasVideoBindings(null, null));
    result.current.onVideoBinding('node-2', URL_A, attached(drawn()));
    expect(result.current.presentedFrameOf('node-2', 'https://assets.example.test/b.mp4')).toBeNull();
    result.current.onVideoBinding('node-2', URL_A, { status: 'detached', error: null, binding: null });
    expect(result.current.presentedFrameOf('node-2', URL_A)).toBeNull();
  });
});
