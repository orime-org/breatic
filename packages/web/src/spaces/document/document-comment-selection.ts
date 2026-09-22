// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Which threads the reader is looking at (#18, A6 · A20).
 *
 * A press on a highlight opens the comment it belongs to. Where that comment
 * appears is the chrome's business — in the panel if it is open, floating
 * beside the line if it is not — and this holds the one thing both need: which
 * threads were pressed.
 *
 * A LIST, NOT ONE. Two comments may cover the same run, and the library's own
 * handler reaches only the first of them (`comments/extension.ts:261-263`).
 * Naming all of them is what lets the reader pick, which is what the three
 * implementations that answer this question do (see `document-comment-hit.ts`).
 * So this answers the press itself and returns true, which is the last thing
 * ProseMirror calls for it. Getting there before the library's handler is a
 * matter of priority rather than of list order — see {@link selectionPlugin}.
 *
 * The selection holds thread ids and no position. Where a thread is, is the
 * position table's answer and it is recomputed on every change — so a
 * selection made before a peer edited the line above still points at the right
 * words, with nothing here to keep in step.
 */

import { createExtension } from '@blocknote/core';
import { Extension } from '@tiptap/core';
import { Plugin, PluginKey, type EditorState } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';
import type { Node as ProseMirrorNode } from '@tiptap/pm/model';

import { threadsAtPosition } from '@web/spaces/document/document-comment-hit';
import type { ToolEditor } from '@web/spaces/document/document-tool-button';

/**
 * The plugin's key, which is also the meta a caller selects threads with:
 * dispatching a list selects them, dispatching an empty one clears it.
 */
export const DOCUMENT_COMMENT_SELECTION = new PluginKey<SelectionState>(
  'documentCommentSelection',
);

/** What the plugin holds: which threads, and the paint that says so. */
interface SelectionState {
  /** The threads the reader is looking at. */
  readonly ids: readonly string[];
  /** The deeper colour over their highlights. */
  readonly decorations: DecorationSet;
}

/** Nothing selected, one object for every such answer. */
const NOTHING: readonly string[] = [];

/** The state a document with nothing selected is in. */
const UNSELECTED: SelectionState = {
  ids: NOTHING,
  decorations: DecorationSet.empty,
};

/** The mark's name on the schema, as the library registers it. */
const COMMENT_MARK = 'comment';

/**
 * The class the deeper colour is painted through.
 *
 * The library's, kept because the stylesheet already paints it and because a
 * press answered by either of us should look the same.
 */
const SELECTED_CLASS = 'bn-thread-mark-selected';

/**
 * The threads the reader is looking at.
 * @param state - The editor state to read.
 * @returns Their ids, empty when none is selected.
 */
export function selectedThreadsIn(state: EditorState): readonly string[] {
  return DOCUMENT_COMMENT_SELECTION.getState(state)?.ids ?? NOTHING;
}

/**
 * Paints the deeper colour over every selected thread's highlight.
 *
 * Walked rather than read off the library's position table, because that
 * table merges a thread's marks into one span from its first start to its
 * last end — and a comment split by an Enter has a gap in the middle that the
 * merged range would paint over. Nothing is walked while nothing is selected,
 * which is nearly always.
 * @param doc - The body to walk.
 * @param ids - The selected threads.
 * @returns The decorations, empty when nothing is selected.
 */
function paintSelected(
  doc: ProseMirrorNode,
  ids: readonly string[],
): DecorationSet {
  if (ids.length === 0) return DecorationSet.empty;
  const painted: Decoration[] = [];
  doc.descendants((node, pos) => {
    node.marks.forEach((mark) => {
      if (mark.type.name !== COMMENT_MARK) return;
      if (!ids.includes(mark.attrs.threadId as string)) return;
      painted.push(
        Decoration.inline(pos, pos + node.nodeSize, { class: SELECTED_CLASS }),
      );
    });
    return true;
  });
  return DecorationSet.create(doc, painted);
}

/** Everyone waiting to hear that the selection changed. */
const listeners = new Set<() => void>();

/**
 * Hear about every change to which threads are being looked at.
 *
 * The editor's own events do not cover it: selecting a thread dispatches a
 * transaction carrying nothing but the meta, so neither the document nor the
 * text selection moves.
 * @param listener - Called after any change.
 * @returns The function that stops it.
 */
export function onSelectedThreadsChange(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * Looks at a set of threads, or at none.
 * @param editor - The document editor.
 * @param threadIds - Which threads; empty clears the selection.
 */
export function selectThreads(
  editor: ToolEditor,
  threadIds: readonly string[],
): void {
  const view = editor.prosemirrorView;
  if (view === null) return;
  view.dispatch(
    view.state.tr.setMeta(DOCUMENT_COMMENT_SELECTION, [...threadIds]),
  );
}

/**
 * The plugin, delivered through tiptap so that its priority is honoured.
 *
 * Measured: registering it as a BlockNote `prosemirrorPlugin` puts it at
 * index 33 of the state's plugins while the library's comments plugin sits at
 * 10, whatever order the extension list is written in — so the library's
 * handler answered every press first and the second of two overlapping
 * threads stayed unreachable. Priority is the knob that decides this, and
 * tiptap's extension manager is what reads it.
 */
const selectionPlugin = Extension.create({
  name: 'documentCommentSelection',
  priority: 1000,

  /**
   * The plugin that answers a press on a highlight.
   * @returns That plugin.
   */
  addProseMirrorPlugins() {
    return [buildSelectionPlugin()];
  },
});

/**
 * The extension that answers a press on a highlight.
 * @returns The extension, for the assembly to register.
 */
export const documentCommentSelection = createExtension(() => ({
  key: 'document-comment-selection',
  tiptapExtensions: [selectionPlugin],
}) as never);

/**
 * Builds the plugin that holds the selection and answers presses.
 * @returns The plugin.
 */
function buildSelectionPlugin(): Plugin<SelectionState> {
  return new Plugin<SelectionState>({
    key: DOCUMENT_COMMENT_SELECTION,
    state: {
      /**
       * Starts with nothing selected.
       * @returns The unselected state.
       */
      init: (): SelectionState => UNSELECTED,

      /**
       * Selects, clears, or carries the selection across this change.
       * @param tr - The transaction being applied.
       * @param current - What was selected before it.
       * @returns What is selected after it.
       */
      apply: (tr, current): SelectionState => {
        const asked = tr.getMeta(DOCUMENT_COMMENT_SELECTION) as
          | readonly string[]
          | undefined;
        if (asked === undefined) {
          // The paint follows the words: an edit moves the highlights it
          // sits on, and mapping is how ProseMirror carries a decoration
          // across one. Nothing selected means nothing to carry.
          if (current.ids.length === 0) return current;
          return {
            ids: current.ids,
            decorations: current.decorations.map(tr.mapping, tr.doc),
          };
        }
        // The same object back for an empty list, so a second clear reads
        // as no change rather than as a new state.
        if (asked.length === 0) return UNSELECTED;
        return { ids: asked, decorations: paintSelected(tr.doc, asked) };
      },
    },

    props: {
      /**
       * The deeper colour over the threads being read.
       * @param state - The editor state.
       * @returns Their decorations.
       */
      decorations: (state): DecorationSet =>
        DOCUMENT_COMMENT_SELECTION.getState(state)?.decorations ??
        DecorationSet.empty,

      /**
       * Opens whatever the press landed on.
       * @param view - The view the press was in.
       * @param pos - Where it landed.
       * @param event - The press itself.
       * @returns True once it has been answered, which stops the library's
       *   own handler taking the first of two overlapping threads.
       */
      handleClick: (view, pos, event): boolean => {
        if (event.button !== 0) return false;
        const hits = threadsAtPosition(view.state.doc, pos);
        const before = selectedThreadsIn(view.state);
        // A press on plain text clears the selection and is NOT answered:
        // it is also the press that moves the caret there.
        if (hits.length === 0) {
          if (before.length > 0) {
            view.dispatch(
              view.state.tr.setMeta(DOCUMENT_COMMENT_SELECTION, []),
            );
          }
          return false;
        }
        view.dispatch(
          view.state.tr.setMeta(DOCUMENT_COMMENT_SELECTION, [...hits]),
        );
        return true;
      },
    },

    /**
     * Tells whoever is watching that the selection changed.
     * @param view - The view this plugin is in.
     * @returns The update hook.
     */
    view: (view) => {
      let last = selectedThreadsIn(view.state);
      return {
        /**
         * Fires the listeners when the selection is not what it was.
         * @param updated - The view after the change.
         */
        update: (updated): void => {
          const now = selectedThreadsIn(updated.state);
          if (now === last) return;
          last = now;
          listeners.forEach((listener) => {
            listener();
          });
        },
      };
    },
  });
}
