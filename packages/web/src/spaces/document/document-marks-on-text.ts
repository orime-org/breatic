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
 * One `appendTransaction` answers for every writer that DISPATCHES its marks,
 * because it reads the document they produced rather than the intent behind
 * any one write. A writer that APPENDS them has to leave the non-text nodes
 * alone itself: ProseMirror runs the append loop until no plugin adds anything
 * and caps nothing, so two plugins that undo each other's work hang the tab
 * inside one dispatch. The one other mark-adding `appendTransaction` here,
 * `autolink`, terminates because it skips a range that already carries its own
 * mark.
 *
 * ## What it costs
 *
 * A press stays one history entry: the appended transaction joins the dispatch
 * that provoked it. A peer's update never provokes a strip, because Yjs never
 * carried such a mark to begin with — it can provoke the stored-mark half,
 * which runs on every transaction rather than only on the ones that moved the
 * caret.
 *
 * ## What it does not reach
 *
 * `storedMarks` is what `Transaction.insertText` and `replaceSelectionWith`
 * consult. Both a paste and a drop build their slice through
 * `parseFromClipboard` and land it with `replaceRange` (prosemirror-view's
 * input.ts), neither of which reads `storedMarks` — so plain text arriving
 * either way at a caret just past a bare node lands without the line's style.
 */

import { createExtension, type ExtensionFactoryInstance } from '@blocknote/core';
import type { Mark, Node as PMNode } from '@tiptap/pm/model';
import { Plugin, type EditorState, type Transaction } from '@tiptap/pm/state';

/**
 * What the next character takes, where a bare node sits before the caret.
 *
 * ProseMirror types with `storedMarks ?? $from.marks()`, and `ResolvedPos.marks`
 * answers off the node behind the caret. A `hardBreak` carries nothing, so
 * where one sits there the whole rule answers off an empty node: a character
 * typed there came out bare in the middle of a styled line.
 *
 * The answer comes from ProseMirror rather than from a second copy of its
 * rule. `ResolvedPos.marksAcross` takes the marks of the node AFTER the
 * position it is called on and drops every mark declaring `inclusive: false`
 * that the node after its argument does not also carry — the pair of nodes
 * `marks` weighs, addressed from their two positions instead of from one
 * index. Called from the front of the last text node behind the caret, with
 * the caret as the far end, it carries that text's marks forward.
 *
 * Only the near end reads back past bare nodes. The far end stays at the
 * caret, so the node it weighs against is whatever sits immediately after —
 * a second `hardBreak` where the caret is on an empty line, which carries
 * nothing and so drops the `inclusive: false` marks. That is the answer this
 * document wants: a link does not reach across a line the reader left empty.
 *
 * Where no text sits behind at all, the caret itself is the near end and the
 * end of the block is the far one. Nothing follows the end of a block
 * (`Fragment.findIndex` returns `content.length` at `pos == size`), so every
 * `inclusive: false` mark falls away there — which is what `marks` does on
 * that side too, by swapping the pair and leaving the other seat empty.
 * @param state - The state the appended transaction is built from. The strip
 *   above is computed from this same state and has not been applied to it.
 * @returns The marks to type with, or nothing where the question does not
 *   arise (a range selection, marks already stored, or text behind the caret).
 */
function marksToTypeWith(state: EditorState): readonly Mark[] | undefined {
  const { selection, storedMarks } = state;
  if (!selection.empty || storedMarks !== null) {
    return undefined;
  }
  const { $from } = selection;
  if ($from.nodeBefore === null || $from.nodeBefore.isText) {
    return undefined;
  }
  let behind = $from.index() - 1;
  while (behind >= 0 && !$from.parent.child(behind).isText) {
    behind -= 1;
  }
  const near =
    behind >= 0 ? state.doc.resolve($from.posAtIndex(behind)) : $from;
  const far = behind >= 0 ? $from : state.doc.resolve($from.end());
  return near.marksAcross(far) ?? undefined;
}

/**
 * Takes every mark off the inline nodes that cannot show one.
 * @returns The plugin.
 */
function marksStayOnTextPlugin(): Plugin {
  return new Plugin({
    appendTransaction: (transactions, _oldState, state) => {
      let tr: Transaction | undefined;
      // Only a step can put a mark on a node, so a batch that left the
      // document alone — a caret move, a peer's cursor — has nothing to strip.
      if (transactions.some((one) => one.docChanged)) {
        state.doc.descendants((node: PMNode, pos: number) => {
          if (node.isInline && !node.isText && node.marks.length > 0) {
            tr = (tr ?? state.tr).removeMark(pos, pos + node.nodeSize, null);
          }
          return true;
        });
      }
      const typing = marksToTypeWith(state);
      if (typing !== undefined) {
        tr = (tr ?? state.tr).setStoredMarks(typing);
      }
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
