// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-Breatic-Source-Available-2.0

/**
 * Where typing a trigger opens the slash menu (inner#1125 design 5.1).
 *
 * The full-width slash and the ideographic comma open the same menu.
 */

import type { Node as PMNode } from '@tiptap/pm/model';
import { TextSelection, type EditorState, type Transaction } from '@tiptap/pm/state';

/**
 * The characters that open the slash menu: the slash, the full-width slash
 * (U+FF0F) and the ideographic comma (U+3001).
 */
export const SLASH_TRIGGERS: readonly string[] = ['/', '\uFF0F', '\u3001'];

/**
 * Reads a Shift+Enter line break as a newline and any other inline leaf as
 * an object character.
 * @param leaf - An inline leaf node.
 * @returns Its text.
 */
function leafText(leaf: PMNode): string {
  return leaf.type.name === 'hardBreak' ? '\n' : '\ufffc';
}

/**
 * Whether a trigger typed at the caret may open the menu: where the caret is
 * at the start of a line or after whitespace. A trigger typed over a
 * selection replaces it as any other character does. Read before the
 * trigger is inserted.
 * @param tr - A transaction on the state the trigger is typed into.
 * @returns True when the menu may open.
 */
export function slashMayOpen(tr: Transaction): boolean {
  const $cursor = tr.selection instanceof TextSelection ? tr.selection.$cursor : null;
  if ($cursor === null) return false;
  if ($cursor.parentOffset === 0) return true;
  // A line break made by Shift+Enter starts a line as a block start does.
  const before = $cursor.parent.textBetween($cursor.parentOffset - 1, $cursor.parentOffset, undefined, leafText);
  return /\s/u.test(before);
}

/**
 * Whether a Shift+Enter line break stands between the start of the query and
 * the caret, so the caret has left the line the menu opened on.
 * @param state - The editor state.
 * @param queryStart - Where the query starts, just past the trigger.
 * @returns True when the caret is past a line break.
 */
export function slashCrossesLineBreak(state: EditorState, queryStart: number): boolean {
  const caret = state.selection.from;
  if (caret <= queryStart) return false;
  return state.doc.textBetween(queryStart, caret, undefined, leafText).includes('\n');
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
