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
 * The click is recognised by what it lands on rather than by where it is:
 * ProseMirror renders each block as its own element inside the editor's, so a
 * click that reports the EDITOR itself as its target landed in the space
 * around the blocks, not on one. That is a DOM fact rather than a geometric
 * one, which is why it can be pinned here instead of only in a browser.
 *
 * What still needs a browser: that this space exists at all. The editor has to
 * fill the height the scroller leaves it, or there is nothing under the last
 * block to click. Pinned by `A9b` in the design doc, not here.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { Editor } from '@tiptap/core';
import * as Y from 'yjs';
import { documentBodyFragment, encodeInitialSpaceContent } from '@breatic/shared';

import { buildDocumentExtensions } from '@web/spaces/document/document-extensions';

const editors: Editor[] = [];

afterEach(() => {
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
 * Click the editor's own element — the space around the blocks, not a block.
 * @param editor - The editor to click in.
 */
function clickBelowTheBlocks(editor: Editor): void {
  editor.view.dom.dispatchEvent(
    new MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 0 }),
  );
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
});
