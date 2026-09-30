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
 * | `compositionstart`, capture phase on the editor element | ahead of ProseMirror's own handler: if the selection is a node selection, remember where |
 * | while remembered | refuse every transaction that changes the document or moves the selection off that node — except a change arriving through Yjs, which is a co-editor's and has to land |
 * | `compositionend` | redraw the body from the unchanged state, put the node selection back, forget |
 *
 * The remembered position is plugin state, mapped through every transaction
 * that gets through, so a co-editor's edit above the node leaves it pointing
 * at the same node, and one that deletes the node drops it.
 */

import { createExtension } from '@blocknote/core';
import { NodeSelection, Plugin, PluginKey, type Transaction } from '@tiptap/pm/state';
import type { EditorView } from '@tiptap/pm/view';
import { ySyncPluginKey } from 'y-prosemirror';

/** Holds where the composition began, or null outside one. */
const KEY = new PluginKey<number | null>('documentNodeComposition');

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
      new Plugin<number | null>({
        key: KEY,
        state: {
          init: () => null,
          apply: (tr, held) => {
            const set = tr.getMeta(KEY) as number | null | undefined;
            if (set !== undefined) return set;
            if (held === null) return null;
            const mapped = tr.mapping.mapResult(held);
            return mapped.deleted ? null : mapped.pos;
          },
        },
        filterTransaction: (tr, state) => {
          const held = KEY.getState(state) ?? null;
          if (held === null || tr.getMeta(KEY) !== undefined || fromYjs(tr)) {
            return true;
          }
          if (tr.docChanged) return false;
          return tr.selection instanceof NodeSelection && tr.selection.from === held;
        },
        view: (view) => {
          /** Remembers a node selection the composition begins on. */
          const onStart = (): void => {
            const { selection } = view.state;
            if (selection instanceof NodeSelection) {
              view.dispatch(view.state.tr.setMeta(KEY, selection.from));
            }
          };
          /** Redraws and gives the node selection back once it ends. */
          const onEnd = (): void => {
            // After ProseMirror's own handler has run for this event.
            setTimeout(() => {
              const held = KEY.getState(view.state) ?? null;
              if (held === null || view.isDestroyed) return;
              redraw(view);
              const tr = view.state.tr.setMeta(KEY, null);
              const node = tr.doc.nodeAt(held);
              if (node !== null && NodeSelection.isSelectable(node)) {
                tr.setSelection(NodeSelection.create(tr.doc, held));
              }
              view.dispatch(tr);
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
