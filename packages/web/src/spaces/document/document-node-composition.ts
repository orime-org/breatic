// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * An input method started on a selected divider writes nothing (#124, A5).
 *
 * A key typed on a node selection is already refused by BlockNote's
 * `NodeSelectionKeyboard`; an input method goes around it. By the time
 * `compositionstart` reaches ProseMirror the browser has moved its own
 * selection into the nearest text and ProseMirror has followed it, so the
 * composed characters land at the end of the line above (probe reading b).
 *
 * The shape is Lexical's: a composition that begins on a whole-node selection
 * is kept out of the model (`LexicalEvents.ts`'s `onCompositionStart` and
 * `beforeinput` both require a range selection).
 *
 * | when | what |
 * |---|---|
 * | `compositionstart`, capture phase on the editor element | ahead of ProseMirror's own handler: if the selection is a node selection, start holding |
 * | while holding | refuse every transaction that changes the document or moves the selection — except a change arriving through Yjs, which is a co-editor's and has to land |
 * | `compositionend`, once no composition is running | redraw the body from the unchanged state, stop holding |
 *
 * The selection needs no putting back: every local move is refused, and a
 * co-editor's change restores a node selection itself (`y-prosemirror` 1.3.7,
 * `restoreRelativeSelection` in `sync-plugin.js:249-275`).
 *
 * "Once no composition is running" matters because a Korean input method ends
 * one syllable's composition and starts the next in the same task. The end
 * handler runs a tick later, when the next composition is already under way,
 * and letting go then would let that syllable in.
 */

import { createExtension } from '@blocknote/core';
import { NodeSelection, Plugin, PluginKey, type Transaction } from '@tiptap/pm/state';
import type { EditorView } from '@tiptap/pm/view';
import { ySyncPluginKey } from 'y-prosemirror';

/** Whether a composition that began on a node selection is being held. */
const KEY = new PluginKey<boolean>('documentNodeComposition');

/**
 * Whether a transaction is a change that came in through Yjs.
 * @param tr - The transaction.
 * @returns True for a peer's edit or anything else the binding writes.
 */
function fromYjs(tr: Transaction): boolean {
  const sync = tr.getMeta(ySyncPluginKey) as { isChangeOrigin?: boolean } | undefined;
  return sync?.isChangeOrigin === true;
}

/**
 * Throws away whatever the browser wrote into the DOM during the composition
 * and redraws it from the state, which never took those characters.
 *
 * `docView.markDirty` is internal to prosemirror-view (1.42.2 here): without
 * it `updateState` with an unchanged document compares node for node, finds
 * nothing to do, and leaves the composed characters on screen.
 * @param view - The editor view.
 */
function redraw(view: EditorView): void {
  const { docView } = view as unknown as {
    docView: { markDirty: (from: number, to: number) => void };
  };
  docView.markDirty(0, view.state.doc.content.size);
  view.updateState(view.state);
}

/**
 * The extension that keeps an input method off a selected node.
 * @returns The extension, for the assembly to register.
 */
export const documentNodeCompositionExtension = createExtension(() => {
  return {
    key: 'document-node-composition',
    prosemirrorPlugins: [
      new Plugin<boolean>({
        key: KEY,
        state: {
          init: () => false,
          apply: (tr, held) => (tr.getMeta(KEY) as boolean | undefined) ?? held,
        },
        filterTransaction: (tr, state) =>
          KEY.getState(state) !== true ||
          tr.getMeta(KEY) !== undefined ||
          fromYjs(tr) ||
          (!tr.docChanged && tr.selection.eq(state.selection)),
        view: (view) => {
          /** Starts holding when the composition begins on a node selection. */
          const onStart = (): void => {
            if (view.state.selection instanceof NodeSelection) {
              view.dispatch(view.state.tr.setMeta(KEY, true));
            }
          };
          /** Redraws and stops holding once the last composition has ended. */
          const onEnd = (): void => {
            // After ProseMirror's own handler has run for this event.
            setTimeout(() => {
              if (KEY.getState(view.state) !== true || view.isDestroyed || view.composing) {
                return;
              }
              redraw(view);
              view.dispatch(view.state.tr.setMeta(KEY, false));
            }, 0);
          };
          view.dom.addEventListener('compositionstart', onStart, true);
          view.dom.addEventListener('compositionend', onEnd, true);
          return {
            destroy: () => {
              view.dom.removeEventListener('compositionstart', onStart, true);
              view.dom.removeEventListener('compositionend', onEnd, true);
            },
          };
        },
      }),
    ],
  } as never;
});
