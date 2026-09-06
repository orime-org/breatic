// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The nine chords, bound to what the nine rows do.
 *
 * A key printed beside a row has to do what the row does (user 2026-08-29), so
 * the bindings and the menu read one table and neither can move without the
 * other.
 *
 * Seven of the nine arrive bound: `Mod-Alt-0` from the paragraph block
 * (`Paragraph/block.ts:58-77`), `Mod-Alt-1` through `Mod-Alt-3` from the
 * heading block (`Heading/block.ts:166-174`, which binds up to six), and
 * `Mod-Shift-7/8/9` from the three list blocks — those last three left with
 * the extensions replaced when the ordered item was rebuilt
 * (`document-list-block.ts`). Each built-in sets
 * the block to that type unconditionally, which §3.2 contradicts twice over:
 * pressing a row the block already has is a cancel, and an ordered item that
 * becomes a heading keeps its number.
 *
 * `runsBefore` is what wins the two that are still registered. BlockNote turns
 * each extension into its own keymap plugin and ranks them by a topological
 * sort of that field (`util/topo-sort.ts:166-205`). Measured: with the field
 * empty the heading block's binding wins and an ordered item loses its number
 * on `Mod-Alt-1`; with it declared this extension outranks both. Registration
 * order does not enter into it.
 */

import { createExtension } from '@blocknote/core';

import { runBlockType } from '@web/spaces/document/document-block-run';
import type { RunEditor } from '@web/spaces/document/document-block-run';
import {
  BLOCK_TYPE_SHORTCUTS,
  shortcutChord,
} from '@web/spaces/document/document-block-type-shortcuts';

/**
 * The keys of the built-in extensions this one has to be reached before.
 *
 * Only the two that still register a chord of ours. The list blocks' own
 * extensions are gone, replaced when the ordered item was rebuilt, so
 * `Mod-Shift-7/8/9` reach nothing else.
 */
const OVERRIDDEN = ['paragraph-shortcuts', 'heading-shortcuts'];

/**
 * Builds the extension that binds all nine.
 * @returns The extension, for the assembly to register.
 */
export const documentChordsExtension = createExtension(() => ({
  key: 'documentBlockTypeChords',
  runsBefore: OVERRIDDEN,
  keyboardShortcuts: Object.fromEntries(
    BLOCK_TYPE_SHORTCUTS.map(({ id, spec }) => [
      shortcutChord(spec),
      ({ editor }: { editor: RunEditor }): boolean => {
        runBlockType(editor, id);
        return true;
      },
    ]),
  ),
}) as never);
