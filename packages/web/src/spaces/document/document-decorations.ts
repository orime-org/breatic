// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * What the stylesheet needs that the document does not hold.
 *
 * Two things reach the screen from here, both computed from the document and
 * never written back: recomputing on every change is what keeps opening a
 * document from touching a byte or filling a collaborator's undo stack.
 *
 * **The numbers.** BlockNote draws an ordered item's number from `data-index`,
 * written by its own indexing plugin and read by `content: var(--index) "."`.
 * Neither shape this Space needs can travel that way: a numbered heading is a
 * `heading` block, which those selectors do not match, and a level path would
 * come out as `1.1.` because the dot is welded into the rule. So the number
 * rides on `data-doc-number`, drawn by one rule in `index.css`.
 *
 * **Where a quote begins and ends.** A quote is a prop on each block, and
 * BlockNote renders that prop as `data-quoted` on its own — enough for the four
 * declarations that are per block. The other three belong to the whole quote
 * (its outer margins, and the two blocks whose own margins give way to them),
 * so the ends of each run are marked here.
 */

import { Plugin, PluginKey } from '@tiptap/pm/state';
import type { EditorState } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';
import type { Node as PMNode } from '@tiptap/pm/model';
import { createExtension } from '@blocknote/core';

import { computeNumbering } from '@web/spaces/document/document-numbering';
import { quoteRuns } from '@web/spaces/document/document-quote-runs';

/** The attribute the number is drawn from. */
const DOC_NUMBER_ATTRIBUTE = 'data-doc-number';

/** The attribute marking the block a quote opens on. */
const QUOTE_FIRST_ATTRIBUTE = 'data-quoted-first';

/** The attribute marking the block a quote closes on. */
const QUOTE_LAST_ATTRIBUTE = 'data-quoted-last';

const decorationsKey = new PluginKey<DecorationSet>('documentDecorations');

/**
 * Builds one decoration per block that needs one, on the block's own content
 * node.
 *
 * Everything here is keyed by block id, which lives on the `blockContainer`,
 * while the element the stylesheet reaches is the content node one level
 * inside it — so the walk finds the container and decorates its first child.
 * A block wanting both a number and a run mark gets one decoration carrying
 * both, so what reaches the DOM does not depend on how ProseMirror merges two.
 * @param doc - The document to read.
 * @returns The decorations for this document.
 */
function blockDecorations(doc: PMNode): DecorationSet {
  // Read once and handed on: both what a run's ends are marked with and how a
  // numbered heading restarts inside one are drawn from the same walk.
  const runs = quoteRuns(doc);
  const numbers = computeNumbering(doc, runs);
  const opens = new Set<string>();
  const closes = new Set<string>();
  runs.forEach((run) => {
    opens.add(run[0]!);
    closes.add(run[run.length - 1]!);
  });

  const decorations: Decoration[] = [];
  doc.descendants((node, pos) => {
    if (node.type.name !== 'blockContainer') {
      return true;
    }
    const id = String(node.attrs['id']);
    const attrs: Record<string, string> = {};
    const shown = numbers.get(id);
    if (shown !== undefined) {
      attrs[DOC_NUMBER_ATTRIBUTE] = shown;
    }
    if (opens.has(id)) {
      attrs[QUOTE_FIRST_ATTRIBUTE] = '';
    }
    if (closes.has(id)) {
      attrs[QUOTE_LAST_ATTRIBUTE] = '';
    }
    const content = node.firstChild;
    if (Object.keys(attrs).length === 0 || content === null) {
      return true;
    }
    const from = pos + 1;
    decorations.push(Decoration.node(from, from + content.nodeSize, attrs));
    return true;
  });
  return DecorationSet.create(doc, decorations);
}

/**
 * The plugin that keeps those decorations in step with the document.
 * @returns The ProseMirror plugin.
 */
function decorationsPlugin(): Plugin<DecorationSet> {
  return new Plugin<DecorationSet>({
    key: decorationsKey,
    state: {
      // Empty by measurement, not by choice: this editor is always bound to a
      // Yjs fragment, and the document is still empty at this point — content
      // arrives afterwards as a transaction, which `apply` below picks up.
      init: () => DecorationSet.empty,
      // A caret move leaves every number and every run boundary where it was,
      // so the whole walk is skipped: this is what C10 asserts by counting
      // transactions.
      apply: (tr, previous) =>
        tr.docChanged ? blockDecorations(tr.doc) : previous,
    },
    props: {
      decorations: (state: EditorState) => decorationsKey.getState(state),
    },
  });
}

/**
 * The extension that registers it, for the assembly to pass through.
 */
export const documentDecorationsExtension = createExtension(() => ({
  key: 'documentDecorations',
  prosemirrorPlugins: [decorationsPlugin()],
}) as never);
