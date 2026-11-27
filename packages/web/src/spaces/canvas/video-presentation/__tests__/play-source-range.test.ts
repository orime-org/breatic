// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-Breatic-Source-Available-2.0

/**
 * inner#1306 split segment preview (canvas design §4 split row; demo video-controls.tsx CutEditor previewSegment): a segment
 * preview plays exactly one source range in the node's own player and stops at its end.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { playSourceRange } from '../play-source-range';

/**
 * A stand-in for the node's media binding: a media element whose clock the test moves. As in a browser, a seek moves
 * `currentTime` and sets `seeking` at once, and the element's `seeking` event, which the browser dispatches later, is
 * dispatched by the test by hand; the seek has landed (`seeking` false again) by the time a play resolves. As Chromium does,
 * the element stores a seek target in whole microseconds, so `currentTime` reads the rounded value back.
 * @param play - What the player's play does.
 * @returns The binding and its element.
 */
function fakeBinding(play: () => Promise<void> = () => Promise.resolve()): { binding: Parameters<typeof playSourceRange>[0]; element: EventTarget & { currentTime: number; ended: boolean; seeking: boolean } } {
  const element = Object.assign(new EventTarget(), { currentTime: 0, ended: false, seeking: false });
  const binding = {
    element: element as unknown as HTMLVideoElement,
    seek: vi.fn((seconds: number) => { element.seeking = true; element.currentTime = Math.round(seconds * 1e6) / 1e6; }),
    play: vi.fn(async () => { await play(); element.seeking = false; }),
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

  it('settles without failing when a later pause interrupts the pending play (HTML pause rule)', async () => {
    let pending: ((error: unknown) => void)[] = [];
    const { binding } = fakeBinding(() => new Promise<void>((_resolve, reject) => { pending.push(reject); }));
    vi.mocked(binding.pause).mockImplementation(() => {
      const rejected = pending;
      pending = [];
      setTimeout(() => { for (const reject of rejected) reject(new DOMException('interrupted', 'AbortError')); }, 0);
    });
    const stopped = playSourceRange(binding, 1, 2);
    stopped.stop();
    await expect(stopped.done).resolves.toBeUndefined();
    const interrupted = playSourceRange(binding, 2, 3);
    binding.pause();
    await expect(interrupted.done).resolves.toBeUndefined();
  });
});

describe('playSourceRange once playing', () => {
  let frames: Map<number, FrameRequestCallback>;
  afterEach(() => { vi.unstubAllGlobals(); });

  /**
   * Replaces the animation frame clock with one the test runs by hand.
   * @throws {never} Never.
   */
  function fakeFrames(): void {
    frames = new Map();
    let next = 0;
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { next += 1; frames.set(next, callback); return next; });
    vi.stubGlobal('cancelAnimationFrame', (id: number) => { frames.delete(id); });
  }

  /**
   * Runs every animation frame callback pending now.
   * @throws {never} Never.
   */
  function runFrames(): void {
    const due = [...frames.entries()];
    frames.clear();
    for (const [, callback] of due) callback(0);
  }

  it('keeps one animation frame chain however many time events arrive', async () => {
    fakeFrames();
    const { binding, element } = fakeBinding();
    playSourceRange(binding, 1, 3);
    await Promise.resolve(); await Promise.resolve();
    expect(frames.size).toBe(1);
    for (let index = 0; index < 20; index += 1) {
      element.currentTime = 1 + index * 0.05;
      element.dispatchEvent(new Event('timeupdate'));
    }
    expect(frames.size).toBe(1);
    runFrames();
    expect(frames.size).toBe(1);
  });

  it('pauses on the end found on an animation frame', async () => {
    fakeFrames();
    const { binding, element } = fakeBinding();
    const playback = playSourceRange(binding, 1, 2);
    element.dispatchEvent(new Event('seeking'));
    await Promise.resolve(); await Promise.resolve();
    element.currentTime = 2.01;
    runFrames();
    await expect(playback.done).resolves.toBeUndefined();
    expect(binding.pause).toHaveBeenCalledOnce();
    expect(binding.seek).toHaveBeenLastCalledWith(2);
    expect(frames.size).toBe(0);
  });

  it('keeps playing through the seeking event of its own start seek, even one that arrives after the play started', async () => {
    fakeFrames();
    const { binding, element } = fakeBinding();
    let settled = false;
    const playback = playSourceRange(binding, 1, 2);
    void playback.done.then(() => { settled = true; });
    await Promise.resolve(); await Promise.resolve();
    element.dispatchEvent(new Event('seeking'));
    element.currentTime = 1.5;
    element.dispatchEvent(new Event('timeupdate'));
    runFrames();
    await Promise.resolve();
    expect(settled).toBe(false);
    expect(frames.size).toBe(1);
    expect(binding.seek).toHaveBeenCalledTimes(1);
  });

  it('ends at the position a user seek past the range end takes it to, before the seeking event arrives', async () => {
    fakeFrames();
    const { binding, element } = fakeBinding();
    const playback = playSourceRange(binding, 0, 3);
    element.dispatchEvent(new Event('seeking'));
    await Promise.resolve(); await Promise.resolve();
    binding.seek(5.4);
    runFrames();
    await expect(playback.done).resolves.toBeUndefined();
    element.dispatchEvent(new Event('seeking'));
    expect(binding.pause).not.toHaveBeenCalled();
    expect(binding.seek).toHaveBeenCalledTimes(2);
    expect(element.currentTime).toBe(5.4);
    expect(frames.size).toBe(0);
  });

  it('ends at the position a user seek made while the play is pending takes it to', async () => {
    fakeFrames();
    let started: () => void = () => {};
    const { binding, element } = fakeBinding(() => new Promise<void>((resolve) => { started = resolve; }));
    const playback = playSourceRange(binding, 0, 3);
    binding.seek(4.8);
    element.dispatchEvent(new Event('seeking'));
    element.dispatchEvent(new Event('seeking'));
    started();
    await expect(playback.done).resolves.toBeUndefined();
    runFrames();
    element.dispatchEvent(new Event('timeupdate'));
    expect(binding.pause).not.toHaveBeenCalled();
    expect(binding.seek).toHaveBeenCalledTimes(2);
    expect(element.currentTime).toBe(4.8);
    expect(frames.size).toBe(0);
  });

  it('ends at the position a seek of the user from the native controls takes it to', async () => {
    fakeFrames();
    const { binding, element } = fakeBinding();
    const playback = playSourceRange(binding, 1, 2);
    element.dispatchEvent(new Event('seeking'));
    await Promise.resolve(); await Promise.resolve();
    element.seeking = true;
    element.currentTime = 4;
    element.dispatchEvent(new Event('seeking'));
    element.dispatchEvent(new Event('timeupdate'));
    runFrames();
    await expect(playback.done).resolves.toBeUndefined();
    expect(binding.pause).not.toHaveBeenCalled();
    expect(binding.seek).toHaveBeenCalledTimes(1);
    expect(element.currentTime).toBe(4);
    expect(frames.size).toBe(0);
  });

  it('keeps playing a range whose start the player stores rounded, and stops at its end', async () => {
    fakeFrames();
    const { binding, element } = fakeBinding();
    const start = 31 / 30;
    const playback = playSourceRange(binding, start, 2);
    let settled = false;
    void playback.done.then(() => { settled = true; });
    element.dispatchEvent(new Event('seeking'));
    await Promise.resolve(); await Promise.resolve();
    element.seeking = true;
    element.dispatchEvent(new Event('seeking'));
    runFrames();
    await Promise.resolve();
    expect(settled).toBe(false);
    element.seeking = false;
    element.currentTime = 2.01;
    runFrames();
    await expect(playback.done).resolves.toBeUndefined();
    expect(binding.pause).toHaveBeenCalledOnce();
    expect(binding.seek).toHaveBeenLastCalledWith(2);
  });

  it('keeps the next segment playing when the seeking event of the previous segment start arrives after it began', async () => {
    fakeFrames();
    const { binding, element } = fakeBinding();
    const first = playSourceRange(binding, 0, 2);
    first.stop();
    let settled = false;
    const second = playSourceRange(binding, 2, 4);
    void second.done.then(() => { settled = true; });
    // The browser dispatches both seeks' events only now: the first segment's, then the second's.
    element.dispatchEvent(new Event('seeking'));
    element.dispatchEvent(new Event('seeking'));
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
    element.currentTime = 2.5;
    element.dispatchEvent(new Event('timeupdate'));
    runFrames();
    await Promise.resolve();
    expect(settled).toBe(false);
    expect(frames.size).toBe(1);
  });
});
