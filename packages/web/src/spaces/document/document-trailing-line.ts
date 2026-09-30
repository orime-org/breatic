// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The body always ends in a block that holds text (#124, A6).
 *
 * A drag can only end inside text (`prosemirror-state` 1.4.4,
 * `TextSelection.between` in `selection.ts:287-305`), and the empty line
 * BlockNote draws under the last block is a decoration, not a block. So when
 * the last block is a divider or a fallback block, a drag past the end stops
 * above it and the block is left out of the selection.
 *
 * The shape is Tiptap's `TrailingNode` (`@tiptap/extensions` 3.29.2,
 * `trailing-node.ts`): after a change leaves the document ending in a block
 * with no text, append a real empty paragraph.
 *
 * Only the editor that made the change appends. A change that came in through
 * Yjs is a co-editor's, whose own editor has already appended; appending again
 * here would leave one empty line per open editor.
 */

import { createExtension } from '@blocknote/core';
import { Plugin, PluginKey, type Transaction } from '@tiptap/pm/state';
import type { Node } from '@tiptap/pm/model';

import { fromYjs } from '@web/spaces/document/document-node-composition';

/**
 * Whether the last block of the document, nested blocks included, holds text.
 * @param doc - The document.
 * @returns False when that block is a divider, a fallback block or any other
 * block without inline content.
 */
function endsInText(doc: Node): boolean {
  // doc > blockGroup > blockContainer (blockContent, blockGroup?)
  let container = doc.lastChild?.lastChild ?? null;
  while (container?.lastChild?.type.name === 'blockGroup') {
    container = container.lastChild.lastChild;
  }
  return container?.firstChild?.isTextblock !== false;
}

/**
 * Whether any of these transactions is a local edit.
 * @param transactions - The transactions just applied.
 * @returns True when one of them changed the document and did not come through Yjs.
 */
function editedHere(transactions: readonly Transaction[]): boolean {
  return transactions.some((tr) => tr.docChanged && !fromYjs(tr));
}

/**
 * The extension that keeps a writable line at the end of the body.
 * @returns The extension, for the assembly to register.
 */
export const documentTrailingLineExtension = createExtension(() => {
  return {
    key: 'document-trailing-line',
    prosemirrorPlugins: [
      new Plugin({
        key: new PluginKey('documentTrailingLine'),
        appendTransaction: (transactions, _old, state) => {
          if (!editedHere(transactions) || endsInText(state.doc)) return null;
          const { blockContainer, paragraph } = state.schema.nodes;
          // The end of the root blockGroup, one step inside the document's end.
          const end = state.doc.content.size - 1;
          return state.tr.insert(end, blockContainer!.create(null, paragraph!.create()));
        },
      }),
    ],
  } as never;
});
