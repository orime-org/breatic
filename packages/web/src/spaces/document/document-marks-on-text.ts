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
 * consult. A paste builds its slice from `$context.marks()` instead
 * (prosemirror-view's `parseFromClipboard`), so plain text pasted at a caret
 * just past a bare node still lands without the line's style.
 */

import { createExtension, type ExtensionFactoryInstance } from '@blocknote/core';
import type { Mark, Node as PMNode } from '@tiptap/pm/model';
import { Plugin, type EditorState, type Transaction } from '@tiptap/pm/state';

/**
 * What the next character takes, where a bare node sits before the caret.
 *
 * ProseMirror types with `storedMarks ?? $from.marks()`, and `ResolvedPos.marks`
 * answers by naming two nodes: the one behind the caret and the one ahead. It
 * takes the marks of the one behind, swapping to the one ahead where nothing
 * sits behind, and drops any mark declaring `inclusive: false` that the node
 * ahead does not also carry — which is how typing at the end of a link stops
 * extending it (`link` declares it, `@blocknote/core` Link/link.ts).
 *
 * A `hardBreak` carries nothing, so where one sits behind the caret that whole
 * rule answers off an empty node: a character typed there came out bare in the
 * middle of a styled line. This reaches one node further back for the node
 * behind and then applies the same rule, so the answer at that position is the
 * answer everywhere else.
 * @param state - The state after the strip.
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
  const ahead = $from.parent.maybeChild($from.index());
  let behind: PMNode | undefined;
  for (let index = $from.index() - 1; index >= 0 && behind === undefined; index -= 1) {
    const node = $from.parent.child(index);
    if (node.isText) {
      behind = node;
    }
  }
  // Nothing behind: the node ahead answers, the way `marks` swaps them.
  if (behind === undefined) {
    return ahead?.isText === true ? ahead.marks : undefined;
  }
  return behind.marks.filter(
    (mark) =>
      mark.type.spec.inclusive !== false ||
      (ahead !== null && ahead !== undefined && mark.isInSet(ahead.marks)),
  );
}

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
