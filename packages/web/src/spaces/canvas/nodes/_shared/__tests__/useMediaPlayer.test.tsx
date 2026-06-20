// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import * as React from 'react';
import { describe, it, expect, vi, beforeAll } from 'vitest';
import { render, screen, act, renderHook } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { useMediaPlayer } from '@web/spaces/canvas/nodes/_shared/useMediaPlayer';

// jsdom does not implement HTMLMediaElement.play()/pause(); stub them so the
// hook's transport calls don't throw "Not implemented".
beforeAll(() => {
  HTMLMediaElement.prototype.play = vi.fn().mockResolvedValue(undefined);
  HTMLMediaElement.prototype.pause = vi.fn();
});

/**
 * Minimal harness: a native <audio> wired to the hook, with the hook's state
 * surfaced as text + a toggle button so tests can drive and read it.
 */
function Harness(): React.JSX.Element {
  const ref = React.useRef<HTMLAudioElement>(null);
  const p = useMediaPlayer(ref);
  return (
    <div>
      {/* eslint-disable-next-line jsx-a11y/media-has-caption -- test fixture */}
      <audio ref={ref} data-testid='el' />
      <span data-testid='playing'>{String(p.playing)}</span>
      <span data-testid='time'>{p.currentTime}</span>
      <span data-testid='duration'>{p.duration}</span>
      <span data-testid='progress'>{p.progress}</span>
      <button type='button' data-testid='toggle' onClick={p.togglePlay}>
        toggle
      </button>
    </div>
  );
}

describe('useMediaPlayer', () => {
  it('reflects the media element play / pause + time events into state', () => {
    render(<Harness />);
    const el = screen.getByTestId('el') as HTMLAudioElement;

    expect(screen.getByTestId('playing').textContent).toBe('false');

    act(() => el.dispatchEvent(new Event('play')));
    expect(screen.getByTestId('playing').textContent).toBe('true');

    Object.defineProperty(el, 'duration', { value: 100, configurable: true });
    act(() => el.dispatchEvent(new Event('loadedmetadata')));
    expect(screen.getByTestId('duration').textContent).toBe('100');

    Object.defineProperty(el, 'currentTime', { value: 25, configurable: true });
    act(() => el.dispatchEvent(new Event('timeupdate')));
    expect(screen.getByTestId('time').textContent).toBe('25');
    // progress = currentTime / duration
    expect(screen.getByTestId('progress').textContent).toBe('0.25');

    act(() => el.dispatchEvent(new Event('pause')));
    expect(screen.getByTestId('playing').textContent).toBe('false');
  });

  it('togglePlay calls play() when paused and pause() when playing', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    const el = screen.getByTestId('el') as HTMLAudioElement;

    await user.click(screen.getByTestId('toggle'));
    expect(el.play).toHaveBeenCalledTimes(1);

    act(() => el.dispatchEvent(new Event('play')));
    await user.click(screen.getByTestId('toggle'));
    expect(el.pause).toHaveBeenCalledTimes(1);
  });

  it('StrictMode-safe: cleanup removes exactly what setup added (no leak)', () => {
    // Drive the hook against a MOCK element (not a real <audio>) so only the
    // hook touches add/removeEventListener — jsdom's internal media listeners
    // (same event names, never removed) would otherwise pollute the balance.
    const added: string[] = [];
    const removed: string[] = [];
    const mockEl = {
      paused: true,
      currentTime: 0,
      duration: 0,
      volume: 1,
      muted: false,
      addEventListener: (type: string): void => void added.push(type),
      removeEventListener: (type: string): void => void removed.push(type),
      play: vi.fn().mockResolvedValue(undefined),
      pause: vi.fn(),
    } as unknown as HTMLMediaElement;
    const ref = { current: mockEl };

    const { unmount } = renderHook(() => useMediaPlayer(ref), {
      wrapper: ({ children }) => <React.StrictMode>{children}</React.StrictMode>,
    });
    unmount();

    // StrictMode double-invokes the effect: setup→cleanup→setup, then unmount
    // cleanup. A symmetric effect leaves adds and removes as identical multisets;
    // a leaked listener (cleanup missing one) would break this — the exact trap.
    expect([...removed].sort()).toEqual([...added].sort());
    expect(added.length).toBeGreaterThan(0);
  });
});
