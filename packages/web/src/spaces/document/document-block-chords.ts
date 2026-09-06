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

import { getBlockInfoFromSelection } from '@blocknote/core';

import { runBlockType, updateFor } from '@web/spaces/document/document-block-run';
import type { RunEditor } from '@web/spaces/document/document-block-run';
import type { BlockTypeId } from '@web/spaces/document/document-block-ticks';
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
 * The markdown shorthands, beside the row each stands for.
 *
 * §3.2 is one table over every control that writes a block type, and this is
 * the third of them. The shorthands the blocks bring answer by type alone,
 * which is a different question wherever the table's one coexisting pair is
 * involved: an ordered item is `numberedListItem`, and the same thing on a
 * heading is the `numbered` prop. Measured before these were routed here:
 * `# ` on an ordered item dropped the number the menu row keeps, and `1. ` on
 * a heading was refused outright, leaving the reader looking at the "1. " they
 * typed.
 *
 * The three list shorthands come from `document-list-block.ts`, which reads
 * them off the same specs; a check list carries `checked`, which the table has
 * no row for, so its two forms both land on the one row and take the prop from
 * the spec.
 */
const SHORTHANDS: { find: RegExp; row: BlockTypeId; props?: Record<string, unknown> }[] = [
  { find: /^(#)\s$/, row: 'heading-1' },
  { find: /^(##)\s$/, row: 'heading-2' },
  { find: /^(###)\s$/, row: 'heading-3' },
  { find: /^\s?(\d+)\.\s$/, row: 'ordered-list' },
  { find: /^\s?[-+*]\s$/, row: 'bullet-list' },
  { find: /^\s?\[\s*\]\s$/, row: 'task-list', props: { checked: false } },
  { find: /^\s?\[[Xx]\]\s$/, row: 'task-list', props: { checked: true } },
];

/**
 * Builds the extension that binds all nine.
 * @returns The extension, for the assembly to register.
 */
export const documentChordsExtension = createExtension(() => ({
  key: 'documentBlockTypeChords',
  runsBefore: OVERRIDDEN,
  inputRules: SHORTHANDS.map(({ find, row, props }) => ({
    find,
    replace({ editor }: { editor: RunEditor }) {
      const info = getBlockInfoFromSelection(
        (editor as unknown as { prosemirrorState: unknown }).prosemirrorState as never,
      );
      if (!info.isBlockContainer) return undefined;
      const update = updateFor(info.blockContent.node, row, false);
      return { ...update, props: { ...update.props, ...(props ?? {}) } };
    },
  })),
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
