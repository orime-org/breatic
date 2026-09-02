// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Puts the numbers on the screen without putting them in the document.
 *
 * BlockNote draws an ordered item's number from `data-index`, written by its
 * own indexing plugin and read by `content: var(--index) "."`. Neither shape
 * this Space needs can travel that way: a numbered heading is a `heading`
 * block, which those selectors do not match, and a level path would come out
 * as `1.1.` because the dot is welded into the rule.
 *
 * So the number rides on an attribute of our own, `data-doc-number`, and one
 * rule in `index.css` draws it for both kinds of block. Because it is a
 * decoration, it is recomputed from the document and never written back:
 * opening a document touches no bytes and fills nobody's undo stack.
 */

import { Plugin, PluginKey } from '@tiptap/pm/state';
import type { EditorState } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';
import type { Node as PMNode } from '@tiptap/pm/model';
import { createExtension } from '@blocknote/core';

import { computeNumbering } from '@web/spaces/document/document-numbering';

/** The attribute the stylesheet draws. */
export const DOC_NUMBER_ATTRIBUTE = 'data-doc-number';

const numberingKey = new PluginKey<DecorationSet>('documentNumbering');

/**
 * Builds one decoration per numbered block, on the block's own content node.
 *
 * The number is keyed by block id, which lives on the `blockContainer`, while
 * the element the stylesheet reaches is the content node one level inside it —
 * so the walk finds the container and decorates its first child.
 * @param doc - The document to number.
 * @returns The decorations for this document.
 */
function numberDecorations(doc: PMNode): DecorationSet {
  const numbers = computeNumbering(doc);
  const decorations: Decoration[] = [];
  doc.descendants((node, pos) => {
    if (node.type.name !== 'blockContainer') {
      return true;
    }
    const shown = numbers.get(String(node.attrs['id']));
    if (shown === undefined) {
      return true;
    }
    const content = node.firstChild;
    if (content === null) {
      return true;
    }
    const from = pos + 1;
    decorations.push(
      Decoration.node(from, from + content.nodeSize, {
        [DOC_NUMBER_ATTRIBUTE]: shown,
      }),
    );
    return true;
  });
  return DecorationSet.create(doc, decorations);
}

/**
 * The plugin that keeps those decorations in step with the document.
 * @returns The ProseMirror plugin.
 */
function numberingPlugin(): Plugin<DecorationSet> {
  return new Plugin<DecorationSet>({
    key: numberingKey,
    state: {
      // Empty by measurement, not by choice: this editor is always bound to a
      // Yjs fragment, and the document is still empty at this point — content
      // arrives afterwards as a transaction, which `apply` below picks up.
      init: () => DecorationSet.empty,
      // A caret move leaves every number where it was, so the whole walk is
      // skipped: this is what C10 asserts by counting transactions.
      apply: (tr, previous) =>
        tr.docChanged ? numberDecorations(tr.doc) : previous,
    },
    props: {
      decorations: (state: EditorState) => numberingKey.getState(state),
    },
  });
}

/**
 * The extension that registers it, for the assembly to pass through.
 */
export const documentNumberingExtension = createExtension(() => ({
  key: 'documentNumbering',
  prosemirrorPlugins: [numberingPlugin()],
}) as never);
