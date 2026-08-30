// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The chord each block type row answers to.
 *
 * One table, because a key printed beside a row has to do what the row does
 * (user 2026-08-29): `document-block-type-keys.ts` binds these and the menu
 * prints these, so neither side can be changed without the other following.
 *
 * A descriptor rather than a string: the same chord reads `⌘⌥1` on macOS and
 * `Ctrl+Alt+1` on Windows, and `packages/web/CLAUDE.md` makes carrying both
 * mandatory. `formatShortcut` turns it into whichever the reader is on, and
 * {@link shortcutChord} into the notation tiptap binds.
 */

import type { ShortcutSpec } from '@web/spaces/canvas/format-shortcut';
import type { BlockTypeId } from '@web/spaces/document/document-block-model';

/** One row's chord, and whether the menu draws it. */
export interface BlockTypeShortcut {
  id: BlockTypeId;
  spec: ShortcutSpec;
  /** Drawn in the row's shortcut column, the way the demo draws it. */
  printed: boolean;
}

/**
 * The eight chords, printed the way the demo prints them.
 *
 * The demo draws a chord on all eight exclusive rows and leaves only the task
 * list blank (`demo/2026-08-29-block-type-transitions.html:211-218`), and the
 * task list has no chord because it has no command.
 */
export const BLOCK_TYPE_SHORTCUTS: BlockTypeShortcut[] = [
  { id: 'paragraph', spec: { mod: true, alt: true, key: '0' }, printed: true },
  { id: 'heading-1', spec: { mod: true, alt: true, key: '1' }, printed: true },
  { id: 'heading-2', spec: { mod: true, alt: true, key: '2' }, printed: true },
  { id: 'heading-3', spec: { mod: true, alt: true, key: '3' }, printed: true },
  { id: 'bullet-list', spec: { mod: true, shift: true, key: '8' }, printed: true },
  { id: 'ordered-list', spec: { mod: true, shift: true, key: '7' }, printed: true },
  { id: 'code-block', spec: { mod: true, alt: true, key: 'C' }, printed: true },
  { id: 'quote', spec: { mod: true, shift: true, key: 'B' }, printed: true },
];

/** Looked up by row, for the menu. */
const BY_ID = new Map(BLOCK_TYPE_SHORTCUTS.map((entry) => [entry.id, entry]));

/**
 * The chord a row prints, if it prints one.
 * @param id - Which row.
 * @returns That chord, or undefined where the row's column is empty.
 */
export function printedShortcut(id: BlockTypeId): ShortcutSpec | undefined {
  const entry = BY_ID.get(id);
  return entry?.printed === true ? entry.spec : undefined;
}

/**
 * The chord in tiptap's own notation, for `addKeyboardShortcuts`.
 *
 * A letter goes down to lower case. prosemirror-keymap looks the press up by
 * the character it produced first of all — `map[modifiers(keyName(event),
 * event)]` is `keydownHandler`'s opening line (`prosemirror-keymap@1.2.3`
 * `dist/index.js`) — and Ctrl+Alt+c produces `c`, so `Mod-Alt-C` misses. The
 * keyCode fallback below it, which would find the binding anyway, is turned off
 * on Windows whenever Ctrl and Alt are both held (that combination is AltGr
 * there), so on Windows an uppercase name is a chord nothing can press. The
 * menu prints the capital either way.
 * @param spec - The chord.
 * @returns It, written the way tiptap reads chords.
 */
export function shortcutChord(spec: ShortcutSpec): string {
  const parts: string[] = [];
  if (spec.mod) parts.push('Mod');
  if (spec.shift) parts.push('Shift');
  if (spec.alt) parts.push('Alt');
  parts.push(spec.key.length === 1 ? spec.key.toLowerCase() : spec.key);
  return parts.join('-');
}
