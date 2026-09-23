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
 * A SECOND PRESS ON THE SAME COMMENT IS LEFT ALONE, because commented words
 * can be a link as well and the link handler sits behind both comment
 * handlers in the chain (measured: this at plugin index 3, the library's at
 * 12, `handleClickLink` at 95). The library answers this the same way, and
 * its own comment says why: "If the clicked thread is already selected, do
 * nothing and let other handlers process the event (e.g. navigating a link)"
 * (`comments/extension.ts`). Standing aside here is only half of it — the
 * library's handler would take the press next — so what is being read is
 * written into the library's store too, which is what makes it stand aside
 * as well.
 *
 * The selection holds thread ids and no position. Where a thread is, is the
 * position table's answer and it is recomputed on every change — so a
 * selection made before a peer edited the line above still points at the right
 * words, with nothing here to keep in step.
 */

import { createExtension } from '@blocknote/core';
import { Extension, type Extension as TiptapExtension } from '@tiptap/core';
import { Plugin, PluginKey, type EditorState } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';
import type { Node as ProseMirrorNode } from '@tiptap/pm/model';

import { threadsAtPosition } from '@web/spaces/document/document-comment-hit';
import {
  commentsOn,
  isLiveCommentMark,
  threadIsPaintedIn,
} from '@web/spaces/document/document-comment-extension';
import type { ToolEditor } from '@web/spaces/document/document-tool-button';

/** The editor surface this plugin needs, past the view. */
interface CommentSelectionHost {
  /**
   * The registered extension matching a factory.
   * @param factory - The factory to match on.
   */
  getExtension(factory: unknown): unknown;
}

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
  /** The thread their pointer is resting on in the panel, if any. */
  readonly hovered: string | null;
  /** The deeper colour over every highlight either of those names. */
  readonly decorations: DecorationSet;
}

/** Nothing selected, one object for every such answer. */
const NOTHING: readonly string[] = [];

/** The state a document with nothing selected is in. */
const UNSELECTED: SelectionState = {
  ids: NOTHING,
  hovered: null,
  decorations: DecorationSet.empty,
};

/**
 * The meta a caller says which card the pointer is resting on with.
 *
 * Kept apart from the selection because they answer different questions and
 * outlive each other: resting on a card says where the reader is looking
 * right now, and leaving it leaves an open comment open.
 */
const DOCUMENT_COMMENT_HOVER = 'documentCommentHover';


/**
 * The class the deeper colour is painted through.
 *
 * The library's, kept because the stylesheet already paints it and because a
 * press answered by either of us should look the same.
 */
const SELECTED_CLASS = 'doc-comment-mark-reading';

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
      // Under the "all" filter a settled card stays on the panel, so nothing
      // takes its thread out of `ids` — the paint refuses on its own
      // (design §9.5, invariant one).
      if (!isLiveCommentMark(mark)) return;
      if (!ids.includes(mark.attrs.threadId as string)) return;
      painted.push(
        Decoration.inline(pos, pos + node.nodeSize, { class: SELECTED_CLASS }),
      );
    });
    return true;
  });
  return DecorationSet.create(doc, painted);
}

/**
 * Every thread whose highlight is drawn deeper right now.
 * @param ids - The threads the reader has open.
 * @param hovered - The card their pointer is resting on, if any.
 * @returns Both, without repeats.
 */
function deepened(
  ids: readonly string[],
  hovered: string | null,
): readonly string[] {
  if (hovered === null || ids.includes(hovered)) return ids;
  return [...ids, hovered];
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
 * The thread the pointer is resting on.
 * @param state - The editor state to read.
 * @returns Its id, or null when the pointer is on no card.
 */
export function hoveredThreadIn(state: EditorState): string | null {
  return DOCUMENT_COMMENT_SELECTION.getState(state)?.hovered ?? null;
}

/**
 * Says which card the pointer is resting on, or that it rests on none.
 * @param editor - The document editor.
 * @param threadId - The thread under the pointer, or null.
 */
export function hoverThread(
  editor: ToolEditor,
  threadId: string | null,
): void {
  const view = editor.prosemirrorView;
  if (view === null) return;
  view.dispatch(view.state.tr.setMeta(DOCUMENT_COMMENT_HOVER, threadId));
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
 * @param editor - The editor, for telling the library what is being read.
 * @returns The tiptap extension carrying it.
 */
function selectionPlugin(editor: CommentSelectionHost): TiptapExtension {
  return Extension.create({
    name: 'documentCommentSelection',
    priority: 1000,

    /**
     * The plugin that answers a press on a highlight.
     * @returns That plugin.
     */
    addProseMirrorPlugins() {
      return [buildSelectionPlugin(editor)];
    },
  });
}

/**
 * The extension that answers a press on a highlight.
 *
 * Built from the editor the factory is handed, because standing aside on a
 * second press takes writing the library's store as well as this one's.
 */
export const documentCommentSelection = createExtension(
  ({ editor }: { editor: CommentSelectionHost }) =>
    ({
      key: 'document-comment-selection',
      tiptapExtensions: [selectionPlugin(editor)],
    }) as never,
);

/**
 * Tells the library which thread is being read.
 *
 * Its handler answers a press on any thread that is not the one it holds, so
 * leaving this unwritten would have it take every press this plugin lets
 * through — and the link behind them would still never open.
 *
 * Only a thread whose highlight is still standing is named. The library
 * draws its own decoration over whichever thread it is told is being read,
 * nested inside the mark and coloured through it by the library's own
 * stylesheet, so naming a settled one paints the words A8 promises read as
 * prose. Its handler passes settled marks by, so there is nothing to ask it
 * to stand aside from either.
 * @param doc - The body, for judging whether that highlight still stands.
 * @param editor - The editor whose comments extension to write.
 * @param threadId - The thread, or undefined for none.
 */
function tellLibrary(
  doc: ProseMirrorNode,
  editor: CommentSelectionHost,
  threadId: string | undefined,
): void {
  const comments = commentsOn(editor);
  if (comments === undefined) return;
  const named =
    threadId !== undefined && threadIsPaintedIn(doc, threadId)
      ? threadId
      : undefined;
  if (comments.store.state.selectedThreadId === named) return;
  comments.store.setState((previous) => ({
    ...previous,
    selectedThreadId: named,
  }));
}

/**
 * Builds the plugin that holds the selection and answers presses.
 * @param editor - The editor, for telling the library what is being read.
 * @returns The plugin.
 */
function buildSelectionPlugin(
  editor: CommentSelectionHost,
): Plugin<SelectionState> {
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
        const hovered = tr.getMeta(DOCUMENT_COMMENT_HOVER) as
          | string
          | null
          | undefined;
        if (hovered !== undefined) {
          if (hovered === current.hovered) return current;
          const ids = current.ids;
          if (ids.length === 0 && hovered === null) return UNSELECTED;
          return {
            ids,
            hovered,
            decorations: paintSelected(tr.doc, deepened(ids, hovered)),
          };
        }

        const asked = tr.getMeta(DOCUMENT_COMMENT_SELECTION) as
          | readonly string[]
          | undefined;
        if (asked === undefined) {
          if (current.ids.length === 0 && current.hovered === null) {
            return current;
          }
          // Redrawn rather than carried across. Mapping keeps a decoration
          // only while its endpoints survive the steps, and everything that
          // arrives through Yjs replaces the whole body: measured
          // 2026-09-23, settling a thread dispatches a mark rewrite whose
          // step maps are empty — those would map fine — and then a
          // `ReplaceStep` mapping `[0, 27, 27]` over a 27-long document.
          // Every peer edit comes back the same way, so mapping loses the
          // paint on any thread being read whenever anyone else types.
          // Redrawing also makes invariant one (design §9.5) enforced by
          // `paintSelected` on every path rather than only on the ones that
          // carry a meta.
          if (!tr.docChanged) return current;
          return {
            ids: current.ids,
            hovered: current.hovered,
            decorations: paintSelected(
              tr.doc,
              deepened(current.ids, current.hovered),
            ),
          };
        }
        // The same object back for an empty list, so a second clear reads
        // as no change rather than as a new state.
        if (asked.length === 0 && current.hovered === null) return UNSELECTED;
        return {
          ids: asked,
          hovered: current.hovered,
          decorations: paintSelected(tr.doc, deepened(asked, current.hovered)),
        };
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
        // A press on plain text clears the selection and is left unanswered,
        // so that whoever else cares about it still sees it — the link
        // handler among them. Where the caret lands is decided in the
        // mousedown handling and is untouched by the answer either way,
        // measured in a browser.
        if (hits.length === 0) {
          if (before.length > 0) {
            view.dispatch(
              view.state.tr.setMeta(DOCUMENT_COMMENT_SELECTION, []),
            );
          }
          return false;
        }
        // Already open: the reader is pressing the same comment again, and
        // what they are after is whatever else those words are.
        if (
          hits.length === before.length &&
          hits.every((id) => before.includes(id))
        ) {
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
         * Fires the listeners when the selection is not what it was, and
         * keeps the library's own store in step with it.
         * @param updated - The view after the change.
         */
        update: (updated): void => {
          const now = selectedThreadsIn(updated.state);
          if (now === last) return;
          last = now;
          tellLibrary(updated.state.doc, editor, now[0]);
          listeners.forEach((listener) => {
            listener();
          });
        },
      };
    },
  });
}
