// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * Enter across two list items throws, so this replaces the command that throws.
 *
 * `@tiptap/core@3.29.2`'s `splitBlock` asks `canSplit` of the document as it
 * stands, then deletes the selection, then splits the document that deletion
 * left behind (`dist/index.cjs:2847`). Delete the text of two list items and
 * the structure around them collapses, so the answer it got no longer holds and
 * `tr.split` throws `TransformError: Inserted content deeper than insertion
 * position`. Upstream issue ueberdosis/tiptap#7734 is open — introduced in
 * v2.6.0, still there in 3.29.2 — and the fix proposed in #7990 is unmerged
 * with maintainers questioning it.
 *
 * `prosemirror-commands`' `splitBlockAs` (`dist/index.cjs:276`) runs the other
 * way round: delete first, re-read the position out of the transaction, walk
 * the depth chain again, then ask. So this hands the work to it.
 *
 * Two things tiptap's version does that the official one does not, and both
 * have to be carried over:
 *
 * - **Attributes marked `keepOnSplit`.** Thirteen of them are live in this
 *   editor, `heading.level` and `orderedList.start` among them. `splitBlockAs`
 *   takes a callback for exactly this, and the callback has to answer `null`
 *   anywhere but the end of a block: the official code treats any non-null
 *   answer as final, short-circuiting its own `atEnd` test, and a split in the
 *   middle of a heading would come out as heading followed by paragraph.
 * - **Marks.** tiptap calls `ensureMarks` with the marks that survive a split;
 *   the official command touches none. Without it, a split at the end of a bold
 *   line leaves the next keystroke unbolded — and the split's own output is
 *   identical either way, so nothing that compares documents can see it.
 *
 * **This extension must not carry a `priority`.** Commands merge the other way
 * round from key bindings: `dist:4705` folds them with the later extension
 * winning, and `dist:2027` sorts by priority descending, so a lower priority
 * lands later and wins. Measured: at `priority: 1000` the override never runs.
 *
 * When upstream fixes this, check what they merged before deleting this file.
 * #7990's approach only moves `canSplit`, which measures differently from both
 * the browser and this — run the tests before removing anything.
 */

import { Extension, defaultBlockAt, getSplittedAttributes } from '@tiptap/core';
import type { RawCommands } from '@tiptap/core';
import { splitBlockAs } from '@tiptap/pm/commands';
import type { Mark, Node as PMNode, ResolvedPos } from '@tiptap/pm/model';
import type { EditorState, Transaction } from '@tiptap/pm/state';

/**
 * The marks a split should hand to whatever gets typed next.
 * @param state - The state the split runs against.
 * @param splittable - Names of the marks that survive a split.
 * @returns Those of the current marks that survive, or null when there are none.
 */
function marksThatSurvive(
  state: EditorState,
  splittable: string[],
): readonly Mark[] | null {
  const { $from, $to } = state.selection;
  const marks = state.storedMarks ?? ($to.parentOffset ? $from.marks() : null);
  if (!marks) return null;
  return marks.filter((mark) => splittable.includes(mark.type.name));
}

/** The document editor's split command, official order, tiptap's extras. */
export const DocumentSplitBlock = Extension.create({
  name: 'documentSplitBlock',

  /**
   * Replace `splitBlock` with the official implementation.
   * @returns The command, by name.
   */
  addCommands() {
    return {
      splitBlock:
        () =>
          ({ state, dispatch, editor, tr }) => {
            const attributes = editor.extensionManager.attributes;
            const splittable = editor.extensionManager.splittableMarks;
            const surviving = marksThatSurvive(state, splittable);
            const ran = splitBlockAs((node: PMNode, atEnd: boolean, $from: ResolvedPos) => {
              if (!atEnd) return null;
              const deflt = defaultBlockAt($from.node(-1).contentMatchAt($from.indexAfter(-1)));
              if (!deflt) return null;
              return {
                type: deflt,
                attrs: getSplittedAttributes(attributes, node.type.name, node.attrs),
              };
            })(state, dispatch as ((tr: Transaction) => void) | undefined);
            // On the props' `tr`, not `state.tr`: in plain ProseMirror the
            // latter builds a NEW transaction on every access and this line
            // would mutate a discarded one. tiptap's chainable state happens
            // to return the shared transaction from both, but only `tr` says
            // so in its own name.
            if (ran && dispatch && surviving) {
              tr.ensureMarks(surviving as Mark[]);
            }
            return ran;
          },
    } as Partial<RawCommands>;
  },
});
