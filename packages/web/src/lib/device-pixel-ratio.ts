// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The screen's device pixel ratio, followed as it changes: moving the window
 * to another screen or changing the browser zoom changes it with nothing else
 * on the page re-rendering.
 */

import * as React from 'react';

/** Components to re-render when the ratio changes. */
const listeners = new Set<() => void>();
/** The one query the page listens on, for the ratio the screen has now. */
let query: MediaQueryList | null = null;

/** The ratio left its value: listen for the new one, then tell everyone. */
function handle(): void {
  arm();
  for (const listener of listeners) listener();
}

/**
 * Listen on the query for the current ratio. A resolution query matches one
 * value only, so it is replaced on every change.
 */
function arm(): void {
  query?.removeEventListener('change', handle);
  query = window.matchMedia(`(resolution: ${String(window.devicePixelRatio)}dppx)`);
  query.addEventListener('change', handle);
}

/**
 * Follow the ratio. The query is armed by the first follower and removed
 * when the last one leaves.
 * @param listener - Called when the ratio changes.
 * @returns The unsubscribe call.
 */
function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  if (listeners.size === 1) arm();
  return () => {
    listeners.delete(listener);
    if (listeners.size > 0) return;
    query?.removeEventListener('change', handle);
    query = null;
  };
}

/**
 * The ratio right now.
 * @returns Device pixels per CSS pixel.
 */
function snapshot(): number {
  return window.devicePixelRatio;
}

/**
 * Device pixels per CSS pixel, re-rendering the caller when it changes.
 * @returns The current ratio.
 */
export function useDevicePixelRatio(): number {
  return React.useSyncExternalStore(subscribe, snapshot, snapshot);
}
