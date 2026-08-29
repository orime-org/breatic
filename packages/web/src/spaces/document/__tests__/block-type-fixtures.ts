// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Editors and selections for the block type menu's tests.
 *
 * Every selection here is a range. The bar refuses a collapsed one
 * (`SelectionBubbleBar.tsx`'s `isWarranted`), so a caret case would describe a
 * state no reader can reach through this menu — the shortcuts reach it instead
 * and are pinned separately.
 */

import { Editor } from '@tiptap/react';
import { TextSelection } from '@tiptap/pm/state';
import * as Y from 'yjs';

import { documentBodyFragment, encodeInitialSpaceContent } from '@breatic/shared';
import { buildDocumentExtensions } from '@web/spaces/document/document-extensions';

const live: Editor[] = [];

/**
 * An editor holding the given body, on a Y.Doc of its own.
 * @param bodyHtml - The body's HTML.
 * @returns The editor.
 */
export function openBody(bodyHtml: string): Editor {
  const doc = new Y.Doc();
  Y.applyUpdate(doc, encodeInitialSpaceContent('document'));
  const editor = new Editor({
    extensions: buildDocumentExtensions({ fragment: documentBodyFragment(doc) }),
  });
  live.push(editor);
  editor.commands.setContent(bodyHtml);
  return editor;
}

/** Destroys every editor opened since the last call. Put this in `afterEach`. */
export function closeAll(): void {
  live.splice(0).forEach((editor) => {
    editor.destroy();
  });
}

/**
 * The content range of the text block whose text is exactly `text`.
 * @param editor - The editor.
 * @param text - The block's whole text.
 * @returns That block's content range.
 * @throws {Error} When no text block reads exactly that.
 */
function blockRangeOf(editor: Editor, text: string): { from: number; to: number } {
  let hit: { from: number; to: number } | null = null;
  editor.state.doc.descendants((node, pos) => {
    if (hit !== null || !node.isTextblock) return hit === null;
    if (node.textContent === text) hit = { from: pos + 1, to: pos + node.nodeSize - 1 };
    return false;
  });
  if (hit === null) throw new Error(`no text block reading ${JSON.stringify(text)}`);
  return hit;
}

/**
 * Selects the text block reading exactly `text`.
 * @param editor - The editor.
 * @param text - The block's whole text.
 */
export function selectBlock(editor: Editor, text: string): void {
  const { from, to } = blockRangeOf(editor, text);
  editor.commands.setTextSelection({ from, to });
}

/**
 * Selects from inside one text block to inside another, the way a drag leaves it.
 * @param editor - The editor.
 * @param fromText - The first block's whole text.
 * @param toText - The last block's whole text.
 */
export function selectRange(editor: Editor, fromText: string, toText: string): void {
  const start = blockRangeOf(editor, fromText);
  const end = blockRangeOf(editor, toText);
  editor.commands.setTextSelection({ from: start.from, to: end.to });
}

/**
 * Selects from inside the first text block to inside the last one.
 *
 * What a drag across the whole body leaves, which is the shape `wrapInList`
 * answers to — an `AllSelection` gives a different answer and is pinned on its
 * own (`demo/2026-08-29-wrap-and-quote-probe-output.txt`).
 * @param editor - The editor.
 */
export function selectWholeBody(editor: Editor): void {
  const { doc } = editor.state;
  let first: number | null = null;
  let last = 1;
  doc.descendants((node, pos) => {
    if (!node.isTextblock) return true;
    if (first === null) first = pos + 1;
    last = pos + node.nodeSize - 1;
    return false;
  });
  editor.view.dispatch(
    editor.state.tr.setSelection(TextSelection.create(doc, first ?? 1, last)),
  );
}
