// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * A style lives on text, whichever control put it there.
 *
 * The rule belongs to the document rather than to any one control: a node the
 * reader cannot see a style on carries none. This schema holds two such nodes.
 * `hardBreak` is a line wrap, bold or coloured or not. `unsupportedInline`
 * stands in for vocabulary a newer build wrote and this one cannot draw. Yjs
 * agrees and more strongly — `y-prosemirror` maps a non-text inline node by
 * its attributes alone (`createTypeFromElementNode`, sync-plugin.js) — so a
 * mark on one lives in the writing client and nowhere else.
 *
 * ## Why the rule is held here rather than in each control
 *
 * `tr.addMark` covers every inline node in its range, and the writers that
 * reach it are not all ours. The bubble bar's own write walks text runs
 * (`styleTheRuns`). The five chords tiptap binds — `Mod-b`, `Mod-i`, `Mod-u`,
 * `Mod-Shift-s`, `Mod-e` — go straight to `toggleMark`, and `applyLink` builds
 * its own transaction. Holding the rule in each of them means knowing the full
 * list, and the list grows: it already grew by two between the bar's write
 * being narrowed and this being written.
 *
 * One `appendTransaction` answers for all of them, and for whatever a later
 * slice adds, because it reads the document the writers produced rather than
 * the intent behind any one write.
 *
 * ## What it costs
 *
 * A press stays one history entry: the appended transaction joins the dispatch
 * that provoked it. A peer's update provokes nothing, because Yjs never
 * carried such a mark to begin with, so nothing is written back over the wire.
 */

import { createExtension, type ExtensionFactoryInstance } from '@blocknote/core';
import type { Node as PMNode } from '@tiptap/pm/model';
import { Plugin, type Transaction } from '@tiptap/pm/state';

/**
 * Takes every mark off the inline nodes that cannot show one.
 * @returns The plugin.
 */
function marksStayOnTextPlugin(): Plugin {
  return new Plugin({
    appendTransaction: (_transactions, _oldState, state) => {
      let tr: Transaction | undefined;
      state.doc.descendants((node: PMNode, pos: number) => {
        if (node.isInline && !node.isText && node.marks.length > 0) {
          tr = (tr ?? state.tr).removeMark(pos, pos + node.nodeSize, null);
        }
        return true;
      });
      return tr;
    },
  });
}

/**
 * The document's rule that a style lives on text.
 * @returns The extension, for the assembly to register.
 */
export function marksStayOnTextExtension(): ExtensionFactoryInstance {
  return createExtension(() => ({
    key: 'marksStayOnText',
    prosemirrorPlugins: [marksStayOnTextPlugin()],
  }) as never)();
}
