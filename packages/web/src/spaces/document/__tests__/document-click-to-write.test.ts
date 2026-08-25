// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Clicking the empty space of the document starts a block to type in.
 *
 * A document Space opens with no blocks at all, so without this there is
 * nowhere to put the caret by mouse and the document cannot be clicked into.
 * The same click matters later for a different reason: the last block can be
 * a code block, and that gives a user no way to get past it.
 *
 * Two things have to be true of the click on a document that HAS blocks, and
 * BOTH are asserted here.
 *
 * It has to have landed on the editor rather than on a block. ProseMirror gives
 * every block its own element inside the editor's, so an event whose target is
 * the editor itself did not land on one.
 *
 * And it has to be BELOW the last line. Those two are not the same test: the
 * editor's own box shows through in the margin gaps between blocks, so a click
 * in such a gap reports the editor as its target while sitting near the TOP of
 * the document. A document with no blocks skips the second question — the
 * whole editor is empty space, and any click on it asks to write.
 *
 * The vertical test needs layout, which jsdom has none of, so the bottom of the
 * last line is stubbed per case.
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import { Editor } from '@tiptap/core';
import * as Y from 'yjs';
import { documentBodyFragment, encodeInitialSpaceContent } from '@breatic/shared';

import { buildDocumentExtensions } from '@web/spaces/document/document-extensions';

const editors: Editor[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  editors.splice(0).forEach((e) => {
    e.destroy();
  });
});

/**
 * A seeded document with a live editor over it.
 * @param bodyHtml - HTML for the document's blocks, if any.
 * @param editable - False to mount as a viewer.
 * @returns The fragment and the editor bound to it.
 */
function open(
  bodyHtml = '',
  editable = true,
): { body: Y.XmlFragment; editor: Editor } {
  const doc = new Y.Doc();
  Y.applyUpdate(doc, encodeInitialSpaceContent('document'));
  const body = documentBodyFragment(doc);
  const editor = new Editor({
    extensions: buildDocumentExtensions({ fragment: body }),
    editable,
  });
  editors.push(editor);
  if (bodyHtml) {
    editor.commands.setContent(bodyHtml);
  }
  return { body, editor };
}

/**
 * Say where the document's last line ends, since jsdom lays nothing out.
 * @param editor - The editor to pin coordinates on.
 * @param bottom - The y coordinate the last line's bottom edge sits at.
 */
function pinLastLineBottom(editor: Editor, bottom: number): void {
  vi.spyOn(editor.view, 'coordsAtPos').mockReturnValue({
    top: bottom - 20,
    bottom,
    left: 0,
    right: 0,
  });
}

/**
 * Press the editor's own element — the space around the blocks, not a block.
 * @param editor - The editor to click in.
 * @param clientY - Where the press landed vertically.
 * @param modifiers - Modifier keys held down, if any.
 */
function pressEditorAt(
  editor: Editor,
  clientY: number,
  modifiers: MouseEventInit = {},
): void {
  editor.view.dom.dispatchEvent(
    new MouseEvent('click', {
      bubbles: true,
      cancelable: true,
      button: 0,
      clientX: 40,
      clientY,
      ...modifiers,
    }),
  );
}

/**
 * Press well below wherever the document's last line ends.
 * @param editor - The editor to click in.
 */
function clickBelowTheBlocks(editor: Editor): void {
  pinLastLineBottom(editor, 100);
  pressEditorAt(editor, 300);
}

describe('clicking an empty document', () => {
  it('opens a block to type in', () => {
    const { body, editor } = open();
    expect(body.length).toBe(0);

    clickBelowTheBlocks(editor);

    expect(editor.state.doc.childCount).toBe(1);
    expect(editor.state.doc.child(0).type.name).toBe('paragraph');
    expect(editor.state.doc.child(0).textContent).toBe('');
    // And the caret is in it, so the next keystroke lands there.
    expect(editor.state.selection.$from.index(0)).toBe(0);
  });

  it('opens on ANY click — an empty document has no "below the last line"', () => {
    const { editor } = open();
    // The pinned last line sits far below the press; on a document with
    // blocks this press would be a between-blocks click and do nothing.
    pinLastLineBottom(editor, 400);
    pressEditorAt(editor, 50);

    expect(editor.state.doc.childCount).toBe(1);
  });

  it('writes nothing at all for a viewer', () => {
    // The server drops a viewer's update without an error, so a write here is
    // a permanent local divergence with nothing to signal it. Setting the
    // editor non-editable stops keystrokes, not a handler of our own.
    const { body, editor } = open('', false);

    clickBelowTheBlocks(editor);

    expect(body.toString()).toBe('');
    expect(editor.state.doc.childCount).toBe(0);
  });
});

describe('clicking under the last block', () => {
  it('opens one past a last block a caret cannot follow', () => {
    // A code block swallows Enter, so without this there is no way past it.
    const { editor } = open('<pre><code>const a = 1</code></pre>');
    clickBelowTheBlocks(editor);

    expect(editor.state.doc.lastChild?.type.name).toBe('paragraph');
    expect(editor.state.selection.$from.index(0)).toBe(
      editor.state.doc.childCount - 1,
    );
  });

  it('reuses the empty paragraph already at the end rather than adding another', () => {
    const { editor } = open('<p>written</p><p></p>');
    const before = editor.state.doc.childCount;

    clickBelowTheBlocks(editor);

    expect(editor.state.doc.childCount).toBe(before);
    expect(editor.state.selection.$from.index(0)).toBe(before - 1);
  });

  it('leaves a click that landed on a block alone', () => {
    const { editor } = open('<p>written</p>');
    const before = editor.state.doc.childCount;

    // A block's own element, not the editor's.
    editor.view.dom.firstElementChild?.dispatchEvent(
      new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 }),
    );

    expect(editor.state.doc.childCount).toBe(before);
  });

  it('leaves a drag that selected something alone', () => {
    // Pressing below the last block and dragging up is how a selection gets
    // made from there. The press alone cannot tell that apart from a click —
    // which is why this is decided on release, by whether anything ended up
    // selected. Acting on it would both lose the selection and write a block
    // into a document other people are in.
    const { body, editor } = open('<p>written</p>');
    const before = { blocks: editor.state.doc.childCount, yjs: body.toString() };
    editor.commands.setTextSelection({
      from: 1,
      to: 1 + 'written'.length,
    });

    pinLastLineBottom(editor, 100);
    pressEditorAt(editor, 300);

    expect(editor.state.doc.childCount).toBe(before.blocks);
    expect(body.toString()).toBe(before.yjs);
    expect(editor.state.selection.empty).toBe(false);
  });

  it('leaves the gap BETWEEN two blocks alone, target notwithstanding', () => {
    // Margins belong to no block's box, so the editor itself is the target
    // there — but the click is nowhere near the end of the document, and
    // ProseMirror puts the caret in the nearest block by itself.
    const { body, editor } = open('<p>first</p><p>written</p>');
    const before = { blocks: editor.state.doc.childCount, yjs: body.toString() };

    pinLastLineBottom(editor, 400);
    pressEditorAt(editor, 120);

    expect(editor.state.doc.childCount).toBe(before.blocks);
    expect(body.toString()).toBe(before.yjs);
  });

  it('leaves a press with a modifier held alone', () => {
    // Shift and a click is how a selection gets extended, and the other
    // modifiers carry meanings of their own too. None of them says "start
    // writing here", so acting on one both loses the gesture and writes an
    // unasked-for block into a document other people are in.
    const { body, editor } = open('<p>written</p>');
    const before = { blocks: editor.state.doc.childCount, yjs: body.toString() };

    for (const held of [
      { shiftKey: true },
      { ctrlKey: true },
      { altKey: true },
      { metaKey: true },
    ]) {
      pinLastLineBottom(editor, 100);
      pressEditorAt(editor, 300, held);
    }

    expect(editor.state.doc.childCount).toBe(before.blocks);
    expect(body.toString()).toBe(before.yjs);
  });

  it('leaves a press level with the last line alone', () => {
    // The boundary itself: a press at the last line's own bottom edge is still
    // on that line, not under it.
    const { editor } = open('<p>written</p>');
    const before = editor.state.doc.childCount;

    pinLastLineBottom(editor, 200);
    pressEditorAt(editor, 200);

    expect(editor.state.doc.childCount).toBe(before);
  });
});
