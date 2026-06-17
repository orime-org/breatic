// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/** A canvas history action a keyboard shortcut can request. */
export type HistoryShortcut = 'undo' | 'redo';

/** The minimal keyboard-event shape the matcher needs (testable without DOM). */
export interface ShortcutEvent {
  key: string;
  metaKey: boolean;
  ctrlKey: boolean;
  shiftKey: boolean;
}

/**
 * Map a keyboard event to a canvas history action, covering both platforms:
 * mac uses `Cmd` (`metaKey`), windows uses `Ctrl` (`ctrlKey`) — we accept
 * either modifier rather than branching on the OS. Undo is `mod+Z`; redo is
 * `mod+Shift+Z` (both platforms) or `mod+Y` (the windows `Ctrl+Y` convention,
 * harmlessly also accepted with `Cmd` on mac).
 * @param event - The keyboard event (or its `key` + modifier subset).
 * @returns `'undo'` / `'redo'` when the event is a history shortcut, else `null`.
 */
export function matchHistoryShortcut(event: ShortcutEvent): HistoryShortcut | null {
  const mod = event.metaKey || event.ctrlKey;
  if (!mod) return null;
  const key = event.key.toLowerCase();
  if ((key === 'z' && event.shiftKey) || key === 'y') return 'redo';
  if (key === 'z') return 'undo';
  return null;
}
