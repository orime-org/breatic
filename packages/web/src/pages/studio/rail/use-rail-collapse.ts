// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import * as React from 'react';

/**
 * Read a rail section's persisted collapsed flag from localStorage.
 * @param key the storage key for the section.
 * @returns `true` when the section was last left collapsed, else `false`.
 */
function readCollapsed(key: string): boolean {
  try {
    return window.localStorage.getItem(key) === '1';
  } catch {
    // Storage unavailable (private mode / SSR) — default to expanded.
    return false;
  }
}

/**
 * Persist a rail section's collapsed flag to localStorage.
 * @param key the storage key for the section.
 * @param collapsed whether the section is now collapsed.
 */
function writeCollapsed(key: string, collapsed: boolean): void {
  try {
    window.localStorage.setItem(key, collapsed ? '1' : '0');
  } catch {
    // Storage unavailable — degrade to in-memory only (no persistence).
  }
}

/**
 * Rail section collapse state (④⑤ Discord-style expand / collapse), persisted
 * in localStorage so the choice survives across sessions (spec §4.4). Default
 * is expanded (`collapsed === false`); storage failures degrade to in-memory.
 * @param storageKey a stable key identifying the section (e.g. `rail.myStudios`).
 * @returns the current `collapsed` flag and a `toggle` to flip it.
 */
export function useRailCollapse(storageKey: string): {
  collapsed: boolean;
  toggle: () => void;
} {
  const [collapsed, setCollapsed] = React.useState<boolean>(() =>
    readCollapsed(storageKey),
  );
  const toggle = React.useCallback((): void => {
    setCollapsed((prev) => {
      const next = !prev;
      writeCollapsed(storageKey, next);
      return next;
    });
  }, [storageKey]);
  return { collapsed, toggle };
}
