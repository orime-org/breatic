// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The keys the block type menu prints, bound to what pressing the row does.
 *
 * A key printed beside a row has to do what the row does (user 2026-08-29).
 * Eight bindings arrive with tiptap's own extensions — `Mod-Alt-0` from
 * Paragraph, `Mod-Alt-1/2/3` from Heading, `Mod-Shift-7/8` from the list pair,
 * `Mod-Shift-b` from Blockquote, `Mod-Alt-c` from CodeBlock — and each runs a
 * stock command whose result the model contradicts, so all eight are taken
 * over here.
 *
 * Priority rather than order: tiptap merges key bindings with the HIGHER
 * priority winning, the opposite of how it merges commands.
 */

import { Extension } from '@tiptap/core';

import { runBlockType } from '@web/spaces/document/document-block-model';
import type { BlockTypeId } from '@web/spaces/document/document-block-model';

/**
 * The eight chords, in tiptap's own notation.
 *
 * `Mod-Alt-0` is here although the menu prints no key beside Text: the binding
 * exists in the editor either way and runs the same transition, so leaving it
 * to Paragraph's own command would make one of the nine behave differently
 * from the row that names it.
 */
const BINDINGS: Array<[chord: string, id: BlockTypeId]> = [
  ['Mod-Alt-0', 'paragraph'],
  ['Mod-Alt-1', 'heading-1'],
  ['Mod-Alt-2', 'heading-2'],
  ['Mod-Alt-3', 'heading-3'],
  ['Mod-Shift-8', 'bullet-list'],
  ['Mod-Shift-7', 'ordered-list'],
  ['Mod-Alt-c', 'code-block'],
  ['Mod-Shift-b', 'quote'],
];

/** Binds the menu's keys to the menu's transitions. */
export const DocumentBlockTypeKeys = Extension.create({
  name: 'documentBlockTypeKeys',

  // Above every extension that ships one of these chords. Paragraph sits at
  // 1000 itself (`@tiptap/extension-paragraph@3.29.2` `dist/index.js:7`), and
  // at equal priority the one registered first keeps the chord — so this goes
  // one above rather than level with the highest of them.
  priority: 1001,

  addKeyboardShortcuts() {
    return Object.fromEntries(
      BINDINGS.map(([chord, id]) => [
        chord,
        (): boolean => {
          runBlockType(this.editor, id);
          return true;
        },
      ]),
    );
  },
});
