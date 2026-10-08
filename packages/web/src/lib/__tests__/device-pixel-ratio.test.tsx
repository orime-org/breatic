// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { act, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { useDevicePixelRatio } from '@web/lib/device-pixel-ratio';

/** Change listeners, by the resolution query they were registered on. */
let listeners: { query: string; cb: () => void }[] = [];

/**
 * Move the screen to a new ratio. Like a browser, only a query whose match
 * flips hears about it: the one for the ratio being left.
 * @param from - The ratio the screen had.
 * @param to - The ratio it has now.
 */
function moveScreen(from: number, to: number): void {
  vi.stubGlobal('devicePixelRatio', to);
  const left = `(resolution: ${String(from)}dppx)`;
  for (const l of listeners.filter((x) => x.query === left)) l.cb();
}

/** Shows what the hook answers. */
function Probe(): React.JSX.Element {
  return <span data-testid='dpr'>{useDevicePixelRatio()}</span>;
}

/**
 * Put the screen at a ratio and route resolution queries to `listeners`.
 * @param ratio - Device pixels per CSS pixel.
 */
function screenAt(ratio: number): void {
  vi.stubGlobal('devicePixelRatio', ratio);
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: true,
    media: query,
    addEventListener: (_: string, cb: () => void) => listeners.push({ query, cb }),
    removeEventListener: (_: string, cb: () => void) => {
      listeners = listeners.filter((l) => l.query !== query || l.cb !== cb);
    },
  }));
}

afterEach(() => {
  vi.unstubAllGlobals();
  listeners = [];
});

describe('useDevicePixelRatio', () => {
  it('answers the ratio the screen has now', () => {
    screenAt(2);
    render(<Probe />);
    expect(screen.getByTestId('dpr')).toHaveTextContent('2');
  });

  it('follows the window onto a screen with another ratio', () => {
    screenAt(1);
    render(<Probe />);

    act(() => moveScreen(1, 2));
    expect(screen.getByTestId('dpr')).toHaveTextContent('2');

    act(() => moveScreen(2, 3));
    expect(screen.getByTestId('dpr')).toHaveTextContent('3');
  });
});
