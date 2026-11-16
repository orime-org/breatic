// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Where typing a trigger opens the slash menu (inner#1125 design 5.1).
 *
 * The full-width slash and the ideographic comma are what the slash key types
 * with a Chinese or Japanese input method on, so they open the same menu.
 */

import type { Transaction } from '@tiptap/pm/state';

/** The characters that open the slash menu. */
export const SLASH_TRIGGERS: readonly string[] = ['/', '／', '、'];

/**
 * Whether a trigger typed at the caret may open the menu: at the start of a
 * line or after whitespace, with nothing selected. Read before the trigger is
 * inserted.
 * @param tr - A transaction on the state the trigger is typed into.
 * @returns True when the menu may open.
 */
export function slashMayOpen(tr: Transaction): boolean {
  const { $from, empty } = tr.selection;
  if (!empty) return false;
  if ($from.parentOffset === 0) return true;
  const before = $from.parent.textBetween($from.parentOffset - 1, $from.parentOffset, undefined, '￼');
  return /\s/u.test(before);
}

/** What the slash menu reads of the suggestion extension's state. */
interface ShownState {
  readonly show: boolean;
  readonly triggerCharacter?: string;
}

/**
 * Whether the suggestion extension is showing our menu. The extension keeps
 * the last trigger in its state after the menu closes, so `show` decides.
 * @param state - The extension's state, if any.
 * @returns True while our menu is open.
 */
export function slashMenuShown(state: ShownState | undefined): boolean {
  return state !== undefined && state.show && SLASH_TRIGGERS.includes(state.triggerCharacter ?? '');
}
