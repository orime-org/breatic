// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * inner#1306 approved demo video-controls.tsx PlaybackStrip: the shared playhead follows playback. The panel re-renders
 * only on pause and seek, so while the source plays the strip reads the live clock itself every animation frame.
 */

import * as React from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { VideoPlaybackStrip, type VideoPlaybackLiveClock } from '../video/VideoPlaybackStrip';

let frames: Map<number, FrameRequestCallback>;
let nextFrame: number;

/**
 * Runs the pending animation frames once.
 */
function tick(): void {
  const pending = [...frames.values()];
  frames.clear();
  act(() => { for (const callback of pending) callback(0); });
}

/**
 * A video element whose paused state the test drives.
 * @returns The element and a setter for its paused state.
 */
function fakeElement(): { element: HTMLVideoElement; setPaused: (paused: boolean) => void } {
  const element = document.createElement('video');
  let paused = true;
  Object.defineProperty(element, 'paused', { configurable: true, get: () => paused });
  return { element, setPaused: (value) => { paused = value; } };
}

/**
 * The playhead's left offset.
 * @returns The CSS left value.
 */
function head(): string {
  return screen.getByTestId('video-playback-head').style.left;
}

/**
 * The middle time label.
 * @returns Its text.
 */
function middle(): string | null {
  return screen.getByTestId('video-playback-times').children[1]!.textContent;
}

beforeEach(() => {
  frames = new Map();
  nextFrame = 1;
  vi.stubGlobal('requestAnimationFrame', vi.fn((callback: FrameRequestCallback) => { const id = nextFrame++; frames.set(id, callback); return id; }));
  vi.stubGlobal('cancelAnimationFrame', vi.fn((id: number) => { frames.delete(id); }));
});

afterEach(() => { vi.unstubAllGlobals(); });

describe('the playback strip live clock (FM5)', () => {
  it('moves the head and the middle label while the source plays', () => {
    const { element, setPaused } = fakeElement();
    let now = 1;
    const clock: VideoPlaybackLiveClock = { element, read: () => now };
    render(<VideoPlaybackStrip src='https://media.example.test/a.mp4' duration={10} aspect={16 / 9} presentedTime={1} liveClock={clock} />);
    expect(head()).toBe('10%');
    setPaused(false);
    fireEvent(element, new Event('play'));
    now = 2.5;
    tick();
    expect(head()).toBe('25%');
    expect(middle()).toBe('2.50 s');
    now = 4;
    tick();
    expect(head()).toBe('40%');
  });

  it('starts following when mounted on a source already playing', () => {
    const { element, setPaused } = fakeElement();
    setPaused(false);
    render(<VideoPlaybackStrip src='https://media.example.test/a.mp4' duration={10} aspect={16 / 9} presentedTime={1} liveClock={{ element, read: () => 3 }} />);
    tick();
    expect(head()).toBe('30%');
  });

  it('stops the loop on pause and shows the presented time it is given', () => {
    const { element, setPaused } = fakeElement();
    const clock: VideoPlaybackLiveClock = { element, read: () => 6 };
    const { rerender } = render(<VideoPlaybackStrip src='https://media.example.test/a.mp4' duration={10} aspect={16 / 9} presentedTime={1} liveClock={clock} />);
    setPaused(false);
    fireEvent(element, new Event('play'));
    tick();
    expect(head()).toBe('60%');
    setPaused(true);
    fireEvent(element, new Event('pause'));
    expect(frames.size).toBe(0);
    rerender(<VideoPlaybackStrip src='https://media.example.test/a.mp4' duration={10} aspect={16 / 9} presentedTime={6.5} liveClock={clock} />);
    expect(head()).toBe('65%');
  });

  it('stops the loop when playback ends', () => {
    const { element, setPaused } = fakeElement();
    render(<VideoPlaybackStrip src='https://media.example.test/a.mp4' duration={10} aspect={16 / 9} presentedTime={1} liveClock={{ element, read: () => 2 }} />);
    setPaused(false);
    fireEvent(element, new Event('play'));
    tick();
    expect(frames.size).toBe(1);
    setPaused(true);
    fireEvent(element, new Event('ended'));
    expect(frames.size).toBe(0);
  });

  it('cancels the loop on unmount', () => {
    const { element, setPaused } = fakeElement();
    const { unmount } = render(<VideoPlaybackStrip src='https://media.example.test/a.mp4' duration={10} aspect={16 / 9} presentedTime={1} liveClock={{ element, read: () => 2 }} />);
    setPaused(false);
    fireEvent(element, new Event('play'));
    expect(frames.size).toBe(1);
    unmount();
    expect(frames.size).toBe(0);
    expect(cancelAnimationFrame).toHaveBeenCalled();
  });

  it('cancels the old source loop when the source changes', () => {
    const first = fakeElement();
    const second = fakeElement();
    const { rerender } = render(<VideoPlaybackStrip src='https://media.example.test/a.mp4' duration={10} aspect={16 / 9} presentedTime={1} liveClock={{ element: first.element, read: () => 2 }} />);
    first.setPaused(false);
    fireEvent(first.element, new Event('play'));
    expect(frames.size).toBe(1);
    rerender(<VideoPlaybackStrip src='https://media.example.test/b.mp4' duration={10} aspect={16 / 9} presentedTime={1} liveClock={{ element: second.element, read: () => 2 }} />);
    expect(frames.size).toBe(0);
    expect(head()).toBe('10%');
  });
});
