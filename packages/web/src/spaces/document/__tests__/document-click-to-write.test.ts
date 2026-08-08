// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * Clicking the empty space under the last block starts a new one.
 *
 * A document Space opens with a title and nothing under it, so without this
 * there is nowhere to put the caret and the document cannot be written into at
 * all. The same click matters later for a different reason: the last block can
 * be a code block or a divider, and those give a user no way to get past them.
 *
 * Two things have to be true of the click, and BOTH are asserted here.
 *
 * It has to have landed on the editor rather than on a block. ProseMirror gives
 * every block its own element inside the editor's, so an event whose target is
 * the editor itself did not land on one.
 *
 * And it has to be BELOW the last line. Those two are not the same test, which
 * is what the first version of this got wrong: the editor's own box shows
 * through in the gap between blocks — the title carries a 28px bottom margin,
 * and a margin belongs to no child's box — so a click in that gap reports the
 * editor as its target while sitting near the TOP of the document. Handling it
 * appended a paragraph at the far end and threw the caret down there with it.
 * Reproduced in a real browser before this was written, on a document with a
 * title and one paragraph.
 *
 * The vertical test needs layout, which jsdom has none of, so the bottom of the
 * last line is stubbed per case. That the space below the last block exists at
 * all — the editor filling the height the scroller leaves it — is a browser
 * check, pinned by `A9b` in the design doc.
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
 * @param bodyHtml - HTML for the blocks after the title, if any.
 * @param editable - False to mount as a viewer.
 * @returns The fragment and the editor bound to it.
 */
function open(
  bodyHtml = '',
  editable = true,
): { body: Y.XmlFragment; editor: Editor } {
  const doc = new Y.Doc();
  Y.applyUpdate(doc, encodeInitialSpaceContent('document', 'Storyboard v3'));
  const body = documentBodyFragment(doc);
  const editor = new Editor({
    extensions: buildDocumentExtensions({ fragment: body }),
    editable,
  });
  editors.push(editor);
  if (bodyHtml) {
    editor.commands.setContent(
      `<h1 class="doc-title">Storyboard v3</h1>${bodyHtml}`,
    );
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
 */
function pressEditorAt(editor: Editor, clientY: number): void {
  editor.view.dom.dispatchEvent(
    new MouseEvent('mousedown', {
      bubbles: true,
      cancelable: true,
      button: 0,
      clientX: 40,
      clientY,
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

describe('clicking under the last block', () => {
  it('opens a block to type in when the body has none', () => {
    const { body, editor } = open();
    expect(body.length).toBe(1);

    clickBelowTheBlocks(editor);

    expect(editor.state.doc.childCount).toBe(2);
    expect(editor.state.doc.child(1).type.name).toBe('paragraph');
    expect(editor.state.doc.child(1).textContent).toBe('');
    // And the caret is in it, so the next keystroke lands there.
    expect(editor.state.selection.$from.index(0)).toBe(1);
  });

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

  it('writes nothing at all for a viewer', () => {
    // The server drops a viewer's update without an error, so a write here is
    // a permanent local divergence with nothing to signal it. Setting the
    // editor non-editable stops keystrokes, not a handler of our own.
    const { body, editor } = open('', false);
    const before = body.toString();

    clickBelowTheBlocks(editor);

    expect(body.toString()).toBe(before);
    expect(editor.state.doc.childCount).toBe(1);
  });

  it('leaves a click that landed on a block alone', () => {
    const { editor } = open('<p>written</p>');
    const before = editor.state.doc.childCount;

    // A block's own element, not the editor's.
    editor.view.dom.firstElementChild?.dispatchEvent(
      new MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 0 }),
    );

    expect(editor.state.doc.childCount).toBe(before);
  });

  it('leaves the gap BETWEEN two blocks alone, target notwithstanding', () => {
    // The 28px under the title belongs to no block's box, so the editor itself
    // is the target there — but the click is nowhere near the end of the
    // document, and ProseMirror puts the caret in the nearest block by itself.
    const { body, editor } = open('<p>written</p>');
    const before = { blocks: editor.state.doc.childCount, yjs: body.toString() };

    pinLastLineBottom(editor, 400);
    pressEditorAt(editor, 120);

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
