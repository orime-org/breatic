// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * A block the reader selected stays selected only while the body holds the
 * focus (user 2026-10-07).
 *
 * A picture, video, audio or divider the reader clicked or arrowed onto is a
 * node selection. When the focus leaves the body — a menu in the top bar, a
 * panel, a click on the page around it — nothing in the document is selected
 * any more, the same way the caret goes away from a text document the reader
 * left. The selection becomes the caret nearest the block, which shows
 * nothing while the body has no focus; when the reader clicks back in, the
 * old block is not drawn as selected for the moment between the press and the
 * new selection. Where that caret would land in a table cell, or where there
 * is no place for text, the selection stays where it is and is marked let go
 * ({@link isLetGo}): a block draws itself as not selected until the focus
 * comes back to the editable element or the selection moves to something
 * else. The full table of states and events is in the design (inner#1127,
 * 3.5.1).
 *
 * What belongs to the body (`belongsToBody`): the editable element, the area
 * around it that carries {@link BODY_PART} and holds the row handles, and
 * every layer drawn outside them that an element of the body opened: a
 * player's volume panel, a row's menu and its submenus, a picture's full-
 * screen view. A layer names its opener through the opener's `aria-controls`.
 * The body of another Space is not this body. The window losing the focus is
 * not leaving either; the reader comes back to the document as they left it.
 *
 * Watched on the page, not on the editable element: the focus can go from the
 * body to one of its own layers and from there out of the body, and that last
 * move never passes the editable element. When the focus falls to nothing the
 * decision waits for whoever closed a layer to put it back.
 */

import { createExtension } from '@blocknote/core';
import type { Node as PMNode } from '@tiptap/pm/model';
import { NodeSelection, Plugin, PluginKey, Selection, type EditorState } from '@tiptap/pm/state';
import { Decoration, DecorationSet, type EditorView } from '@tiptap/pm/view';

import { DIVIDER } from '@web/spaces/document/document-divider';
import { MEDIA_BLOCK_TYPES } from '@web/spaces/document/document-media-types';

/** The blocks the reader selects whole, by a click or an arrow. */
const READER_SELECTED = new Set<string>([DIVIDER, ...MEDIA_BLOCK_TYPES]);

/**
 * Whether a caret sits in a table cell, where it brings up the cell's own
 * button.
 * @param caret - The caret.
 * @returns True inside a cell.
 */
function inTableCell(caret: Selection): boolean {
  const { $from } = caret;
  for (let depth = $from.depth; depth > 0; depth -= 1) {
    const role: unknown = $from.node(depth).type.spec.tableRole;
    if (role === 'cell' || role === 'header_cell') return true;
  }
  return false;
}

/**
 * Where the caret goes when a block is not to be selected: the first place
 * for text after it, or before it when nothing follows.
 * @param doc - The document.
 * @param end - Where the block ends.
 * @returns The caret, or null when there is no place for text or the place is in a table cell.
 */
export function caretUnder(doc: PMNode, end: number): Selection | null {
  const $end = doc.resolve(end);
  const caret = Selection.findFrom($end, 1, true) ?? Selection.findFrom($end, -1, true);
  return caret === null || inTableCell(caret) ? null : caret;
}

/**
 * The attribute the area around the editable element carries, where the row
 * handles stand: the focus moving into it does not leave the body.
 */
export const BODY_PART = 'data-document-body-part';

/** The spec key of the decoration that marks a selected block let go. */
const LET_GO = 'documentLetGo';

const KEY = new PluginKey<boolean>('documentNodeSelectionFocus');

/**
 * The element that opened the layer an element is in, read off the opener's
 * `aria-controls`.
 * @param element - An element inside a layer.
 * @returns The opener, or null when no element names a layer around it.
 */
function openerOf(element: Element): Element | null {
  for (let layer = element.closest('[id]'); layer !== null; layer = layer.parentElement?.closest('[id]') ?? null) {
    // Radix ids carry colons, which a quoted attribute value takes as they are.
    const opener = element.ownerDocument.querySelector(`[aria-controls~="${layer.id}"]`);
    if (opener !== null) return opener;
  }
  return null;
}

/**
 * Whether an element is part of the body, directly or through the layers it
 * opened.
 * @param view - The view.
 * @param target - The element.
 * @returns True when it belongs to the body.
 */
function belongsToBody(view: EditorView, target: EventTarget | null): boolean {
  const body = view.dom.closest(`[${BODY_PART}]`) ?? view.dom;
  const seen = new Set<Element>();
  for (let at = target instanceof Element ? target : null; at !== null && !seen.has(at); at = openerOf(at)) {
    seen.add(at);
    if (body.contains(at)) return true;
  }
  return false;
}

/**
 * The block a reader-selected block selection is on.
 * @param selection - The selection.
 * @returns The block's id, or null when the selection is not on such a block.
 */
function selectedBlock(selection: Selection): string | null {
  if (!(selection instanceof NodeSelection) || !READER_SELECTED.has(selection.node.type.name)) return null;
  const id: unknown = selection.$from.parent.attrs.id;
  return typeof id === 'string' ? id : null;
}

/**
 * Lets go of the selected block: the caret goes under the given place, or,
 * with no place for text, the selection is marked let go.
 * @param view - The view.
 * @param end - Where the block the caret goes under ends.
 */
export function letGoOfBlock(view: EditorView, end: number): void {
  const caret = caretUnder(view.state.doc, end);
  const tr = view.state.tr.setMeta('addToHistory', false);
  view.dispatch(caret === null ? tr.setMeta(KEY, true) : tr.setSelection(caret));
}

/**
 * Whether a block's decorations say its selection was let go.
 * @param decorations - The decorations ProseMirror hands the block's view.
 * @returns True when the block is to be drawn as not selected.
 */
export function isLetGo(decorations: readonly Decoration[]): boolean {
  return decorations.some((decoration) => (decoration.spec as Record<string, unknown>)[LET_GO] === true);
}

/**
 * Lets go of a block the reader had selected, when the focus is no longer in
 * the body.
 * @param view - The view.
 * @param now - Where the focus is.
 */
function dropUnlessInBody(view: EditorView, now: EventTarget | null): void {
  const { selection } = view.state;
  if (selectedBlock(selection) === null || belongsToBody(view, now)) return;
  // The window itself lost the focus: the body still holds it within the page.
  if (!view.dom.ownerDocument.hasFocus()) return;
  letGoOfBlock(view, selection.to);
}

/**
 * The let-go mark on the selected block, while there is one.
 * @param state - The state.
 * @returns The decoration, or null.
 */
function letGoDecorations(state: EditorState): DecorationSet | null {
  const { selection } = state;
  if (KEY.getState(state) !== true || !(selection instanceof NodeSelection)) return null;
  return DecorationSet.create(state.doc, [Decoration.node(selection.from, selection.to, {}, { [LET_GO]: true })]);
}

/**
 * The extension that lets go of a selected block when the body loses focus.
 * @returns The extension, for the assembly to register.
 */
export const documentNodeSelectionFocusExtension = createExtension(() => ({
  key: 'document-node-selection-focus',
  prosemirrorPlugins: [
    new Plugin<boolean>({
      key: KEY,
      state: {
        init: () => false,
        apply: (tr, letGo, before, after) => {
          const meta: unknown = tr.getMeta(KEY);
          if (typeof meta === 'boolean') return meta;
          // A sync or an undo sets the selection again on the same block.
          return letGo && selectedBlock(after.selection) !== null && selectedBlock(after.selection) === selectedBlock(before.selection);
        },
      },
      props: { decorations: letGoDecorations },
      view: (view) => {
        const page = view.dom.ownerDocument;
        let later: ReturnType<typeof setTimeout> | undefined;
        /**
         * Lets go of the selected block when the focus leaves the body.
         * @param event - A focusout anywhere on the page.
         */
        const onFocusOut = (event: FocusEvent): void => {
          if (selectedBlock(view.state.selection) === null || !belongsToBody(view, event.target)) return;
          if (event.relatedTarget !== null) {
            dropUnlessInBody(view, event.relatedTarget);
            return;
          }
          // The focus fell to nothing: the reader clicked the page around the
          // body, or a layer of the body closed, which hands the focus back a
          // task later (Radix FocusScope does it in a timeout queued as it
          // unmounts, after this). Decided once that has run, by where the
          // focus is then.
          clearTimeout(later);
          later = setTimeout(() => {
            later = setTimeout(() => {
              if (!view.isDestroyed) dropUnlessInBody(view, page.activeElement);
            }, 0);
          }, 0);
        };
        /**
         * Takes the let-go mark off when the focus comes back to the editable
         * element.
         * @param event - A focusin anywhere on the page.
         */
        const onFocusIn = (event: FocusEvent): void => {
          if (KEY.getState(view.state) === true && event.target instanceof Node && view.dom.contains(event.target)) {
            view.dispatch(view.state.tr.setMeta(KEY, false).setMeta('addToHistory', false));
          }
        };
        page.addEventListener('focusout', onFocusOut, true);
        page.addEventListener('focusin', onFocusIn, true);
        return {
          destroy: () => {
            clearTimeout(later);
            page.removeEventListener('focusout', onFocusOut, true);
            page.removeEventListener('focusin', onFocusIn, true);
          },
        };
      },
    }),
  ],
}));
