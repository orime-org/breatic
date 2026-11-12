// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * inner#1306 split segment preview (canvas design §4 split row; demo video-controls.tsx CutEditor previewSegment): a segment
 * preview plays exactly one source range in the node's own player and stops at its end.
 */

import { describe, expect, it, vi } from 'vitest';
import { playSourceRange } from '../play-source-range';

/**
 * A stand-in for the node's media binding: a media element whose clock the test moves.
 * @param play - What the player's play does.
 * @returns The binding and its element.
 */
function fakeBinding(play: () => Promise<void> = () => Promise.resolve()): { binding: Parameters<typeof playSourceRange>[0]; element: EventTarget & { currentTime: number; ended: boolean } } {
  const element = Object.assign(new EventTarget(), { currentTime: 0, ended: false });
  const binding = {
    element: element as unknown as HTMLVideoElement,
    seek: vi.fn((seconds: number) => { element.currentTime = seconds; }),
    play: vi.fn(play),
    pause: vi.fn(),
  };
  return { binding, element };
}

describe('playSourceRange', () => {
  it('seeks to the start, plays, and pauses on the end once the clock reaches it', async () => {
    const { binding, element } = fakeBinding();
    const playback = playSourceRange(binding, 1, 2);
    expect(binding.seek).toHaveBeenCalledWith(1);
    expect(binding.play).toHaveBeenCalledOnce();
    await Promise.resolve();
    element.currentTime = 1.5;
    element.dispatchEvent(new Event('timeupdate'));
    expect(binding.pause).not.toHaveBeenCalled();
    element.currentTime = 2.1;
    element.dispatchEvent(new Event('timeupdate'));
    await expect(playback.done).resolves.toBeUndefined();
    expect(binding.pause).toHaveBeenCalledOnce();
    expect(binding.seek).toHaveBeenLastCalledWith(2);
  });

  it('ends without moving the player when stopped or paused by the user', async () => {
    const stopped = fakeBinding();
    const first = playSourceRange(stopped.binding, 1, 2);
    first.stop();
    await expect(first.done).resolves.toBeUndefined();
    expect(stopped.binding.pause).toHaveBeenCalledOnce();
    expect(stopped.binding.seek).toHaveBeenCalledTimes(1);

    const paused = fakeBinding();
    const second = playSourceRange(paused.binding, 1, 2);
    await Promise.resolve(); await Promise.resolve();
    paused.element.dispatchEvent(new Event('pause'));
    await expect(second.done).resolves.toBeUndefined();
    expect(paused.binding.seek).toHaveBeenCalledTimes(1);
  });

  it('rejects when the player refuses to play', async () => {
    const { binding } = fakeBinding(() => Promise.reject(new Error('NotAllowedError')));
    await expect(playSourceRange(binding, 1, 2).done).rejects.toThrow('NotAllowedError');
  });
});
