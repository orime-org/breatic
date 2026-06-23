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

/** The current selection's grouping offer (mirrors `GroupToolbar['kind']`). */
export type GroupOfferKind = 'group' | 'ungroup' | 'none';

/** How the canvas should respond to a (possibly grouping) keyboard chord. */
export interface GroupShortcutPlan {
  /**
   * True when the chord IS a group / ungroup chord — the canvas always swallows
   * it (preventDefault) so the browser's native Cmd+G (find-again) never fires,
   * regardless of whether the action applies.
   */
  preventDefault: boolean;
  /** The grouping action to run, or null when the chord doesn't apply. */
  run: GroupShortcut | null;
}

/**
 * Decide the canvas response to a keyboard chord: a group / ungroup chord is
 * ALWAYS swallowed so the browser's native Cmd+G (find-again) can't fire on the
 * canvas, but the grouping action only runs when it matches the current
 * selection's offer. So Cmd+G while the selection mixes a group with loose nodes
 * (offer `none`) is swallowed yet does nothing — the no-op decision — instead of
 * leaking to the browser. A non-grouping chord (`action` null) passes through
 * untouched.
 * @param action - The matched grouping action, or null for a non-grouping chord.
 * @param offerKind - The current selection's grouping offer.
 * @returns Whether to preventDefault, and which action (if any) to run.
 */
export function planGroupShortcut(
  action: GroupShortcut | null,
  offerKind: GroupOfferKind,
): GroupShortcutPlan {
  if (action === null) return { preventDefault: false, run: null };
  const applies =
    (action === 'group' && offerKind === 'group') ||
    (action === 'ungroup' && offerKind === 'ungroup');
  return { preventDefault: true, run: applies ? action : null };
}
