// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Tab and Shift-Tab, for every selection rather than for a caret alone.
 *
 * The move and the question of whether it is possible are the same call:
 * `nestBlock` reads `$from.blockRange($to)` and leaves the document alone when
 * the range has nowhere to go (`nestBlock.ts`, `startIndex === 0`). Asking a
 * separate question first is what put the two out of step — `canNestBlock`
 * resolves the block at `selection.anchor`, which is the end the drag started
 * from, so a backwards drag asked about one block and acted on another.
 *
 * WHEN IT CANNOT MOVE, THE READER IS TOLD. A block already as deep as it can
 * go took the key and did nothing, and there was no way to tell that from a
 * press that missed (user 2026-09-08). The blocks in the selection are marked
 * `data-tab-blocked` and the stylesheet animates them; the mark is dropped
 * when the animation ends, and dropped and re-applied on a second press so a
 * reader pressing again sees the animation from its start.
 *
 * Whether the document moved is read the same way it is caused: the state's
 * `doc` is a persistent value, so an unchanged document is the same object.
 *
 * The key is claimed either way. An unclaimed Tab is one the browser answers,
 * and the browser answers it by moving focus out of the editor: measured,
 * focus went from the editor to `BODY` and the next characters the reader
 * typed reached nothing. BlockNote's own source says the same —
 * `KeyboardShortcutsExtension.ts:958`, "Always returning true for tab key
 * presses ensures they're not captured by the browser. Otherwise, they blur
 * the editor".
 */

import { createExtension } from '@blocknote/core';
import type { EditorView } from '@tiptap/pm/view';
import type { Node as PMNode } from '@tiptap/pm/model';

/** The attribute the stylesheet animates. */
const BLOCKED_ATTRIBUTE = 'data-tab-blocked';

/** What the editor object offers this file. */
interface TabEditor {
  nestBlock: () => void;
  unnestBlock: () => void;
  prosemirrorView: EditorView | null;
}

/**
 * The wrappers of every block the selection covers.
 *
 * Indentation is applied to the whole range, so what could not move is the
 * whole range too. The wrapper is what carries the block's own indentation,
 * which is what a nudge has to move.
 * @param view - The editor view to read.
 * @returns The elements to mark, which may be empty.
 */
function selectedWrappers(view: EditorView): HTMLElement[] {
  const { from, to } = view.state.selection;
  const found = new Set<HTMLElement>();
  view.state.doc.nodesBetween(from, to, (node: PMNode, pos: number) => {
    if (node.type.name !== 'blockContainer') return true;
    const dom = view.nodeDOM(pos);
    if (dom instanceof HTMLElement) found.add(dom);
    return true;
  });
  return [...found];
}

/**
 * Marks those blocks, and takes the mark off when the animation ends.
 *
 * Removing an existing mark first is what restarts the animation: an element
 * that already carries it would go on playing the run it started, and a reader
 * pressing again would see nothing.
 * @param view - The editor view the selection belongs to.
 */
function sayItCannotMove(view: EditorView): void {
  selectedWrappers(view).forEach((wrapper) => {
    wrapper.removeAttribute(BLOCKED_ATTRIBUTE);
    // Reading a layout property is what makes the browser treat the next set
    // as a new animation rather than as the continuation of the old one.
    void wrapper.offsetWidth;
    wrapper.setAttribute(BLOCKED_ATTRIBUTE, '');
    wrapper.addEventListener(
      'animationend',
      () => {
        wrapper.removeAttribute(BLOCKED_ATTRIBUTE);
      },
      { once: true },
    );
  });
}

/**
 * Runs a move and says so when the document came back unchanged.
 * @param editor - The editor to move in.
 * @param move - The move to try.
 */
function moveOrSayNo(editor: TabEditor, move: () => void): void {
  const { prosemirrorView: view } = editor;
  const before = view?.state.doc;
  move();
  if (view !== null && view.state.doc === before) sayItCannotMove(view);
}

/**
 * The extension that binds Tab for the whole document.
 * @returns The extension, for the assembly to register.
 */
export const documentTabExtension = createExtension(() => ({
  key: 'document-tab',
  keyboardShortcuts: {
    Tab: ({ editor }: { editor: TabEditor }) => {
      moveOrSayNo(editor, () => {
        editor.nestBlock();
      });
      return true;
    },
    'Shift-Tab': ({ editor }: { editor: TabEditor }) => {
      moveOrSayNo(editor, () => {
        editor.unnestBlock();
      });
      return true;
    },
  },
}) as never);
