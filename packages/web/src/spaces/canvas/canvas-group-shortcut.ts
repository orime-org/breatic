// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import type { ShortcutEvent } from '@web/spaces/canvas/canvas-history-shortcut';

/** A canvas grouping action a keyboard shortcut can request. */
export type GroupShortcut = 'group' | 'ungroup';

/**
 * Map a keyboard event to a canvas grouping action, covering both platforms:
 * mac uses `Cmd` (`metaKey`), windows uses `Ctrl` (`ctrlKey`) — we accept
 * either modifier rather than branching on the OS. Group is `mod+G`; ungroup
 * is `mod+Shift+G`. (`event.key` arrives uppercased when Shift is held, so we
 * lowercase before comparing.)
 * @param event - The keyboard event (or its `key` + modifier subset).
 * @returns `'group'` / `'ungroup'` when the event is a grouping shortcut, else `null`.
 */
export function matchGroupShortcut(event: ShortcutEvent): GroupShortcut | null {
  const mod = event.metaKey || event.ctrlKey;
  if (!mod) return null;
  if (event.key.toLowerCase() !== 'g') return null;
  return event.shiftKey ? 'ungroup' : 'group';
}
