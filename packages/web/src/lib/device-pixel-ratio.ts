// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The screen's device pixel ratio, followed as it changes: moving the window
 * to another screen or changing the browser zoom changes it with nothing else
 * on the page re-rendering.
 */

import * as React from 'react';

/**
 * Listen for the ratio leaving its current value. A resolution query matches
 * one value only, so the query is re-armed for the new value on every change.
 * @param onChange - Called when the ratio changes.
 * @returns The unsubscribe call.
 */
function subscribe(onChange: () => void): () => void {
  let query: MediaQueryList | null = null;
  /** Listen on the query for the ratio the screen has now. */
  const arm = (): void => {
    query?.removeEventListener('change', handle);
    query = window.matchMedia(`(resolution: ${String(window.devicePixelRatio)}dppx)`);
    query.addEventListener('change', handle);
  };
  /** Re-arm for the new ratio, then tell React. */
  function handle(): void {
    arm();
    onChange();
  }
  arm();
  return () => query?.removeEventListener('change', handle);
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
