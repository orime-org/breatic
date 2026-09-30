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
 * | `compositionstart`, capture phase on the editor element | ahead of ProseMirror's own handler: if the selection is a node selection, remember its block |
 * | while remembered | refuse every transaction that changes the document or moves the selection off that block's node — except a change arriving through Yjs, which is a co-editor's and has to land |
 * | `compositionend` | redraw the body from the unchanged state, put the node selection back, forget |
 *
 * What is remembered is the id of the block the node sits in, not a
 * position: the binding delivers every co-editor's change as one replace over
 * the whole document (`y-prosemirror` 1.3.7, `sync-plugin.js:657-661`), and a
 * position mapped through that comes back deleted. The node is looked up by id
 * whenever it is needed. A co-editor deleting the block mid-composition does
 * not end the hold: the composed characters still stay out, and at the end
 * there is no node to select, so the hold is only let go.
 */

import { createExtension } from '@blocknote/core';
import { NodeSelection, Plugin, PluginKey, type Transaction } from '@tiptap/pm/state';
import type { EditorView } from '@tiptap/pm/view';
import type { Node as PMNode } from '@tiptap/pm/model';
import { ySyncPluginKey } from 'y-prosemirror';

import { rowById } from '@web/spaces/document/document-row-by-id';

/** Holds the id of the block the composition began on, or null outside one. */
const KEY = new PluginKey<string | null>('documentNodeComposition');

/**
 * Where the held block's own node sits in this document.
 * @param doc - The document.
 * @param blockId - The held block's id.
 * @returns The node's position, or null once the block is gone.
 */
function heldAt(doc: PMNode, blockId: string): number | null {
  const row = rowById(doc, blockId);
  // A container opens with its content node, one past its own start.
  return row === undefined ? null : row.from + 1;
}

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
      new Plugin<string | null>({
        key: KEY,
        state: {
          init: () => null,
          apply: (tr, held) => {
            const set = tr.getMeta(KEY) as string | null | undefined;
            return set === undefined ? held : set;
          },
        },
        filterTransaction: (tr, state) => {
          const held = KEY.getState(state) ?? null;
          if (held === null || tr.getMeta(KEY) !== undefined || fromYjs(tr)) {
            return true;
          }
          if (tr.docChanged) return false;
          return (
            tr.selection instanceof NodeSelection &&
            tr.selection.from === heldAt(tr.doc, held)
          );
        },
        view: (view) => {
          /** Remembers a node selection the composition begins on. */
          const onStart = (): void => {
            const { selection } = view.state;
            const id = selection.$from.parent.attrs['id'] as unknown;
            if (selection instanceof NodeSelection && typeof id === 'string') {
              view.dispatch(view.state.tr.setMeta(KEY, id));
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
              const at = heldAt(tr.doc, held);
              if (at !== null) {
                tr.setSelection(NodeSelection.create(tr.doc, at));
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
