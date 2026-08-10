// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * Pasting across the line between the title and the body.
 *
 * The title holds text and nothing else, so a paste of several paragraphs has
 * nowhere to put all but the first of them. The rule the design settled on is
 * that the first paragraph's plain text goes into the title at the caret and the
 * paragraphs after it become body blocks in the same order, directly under it.
 *
 * **No code implements that rule, and none needs to.** It is what the editor
 * already does, because the title is an ordinary textblock as far as the
 * clipboard pipeline is concerned: the slice's first block fits, the rest do
 * not, and ProseMirror splices them in after. The cases below exist to pin that
 * — this document's shape is unusual enough that the behaviour could stop being
 * free at any upgrade, and nothing else would notice.
 *
 * Where the caret sits mid-title, the title's tail travels down onto the LAST
 * pasted block rather than staying behind the inserted text. That is the same
 * split Enter performs (caret mid-title, Enter, and the tail becomes the body's
 * first block — see `document-title-keymap.test`), and it is what the editor
 * does pasting into any paragraph, so it is the consistent answer rather than a
 * quirk to correct.
 *
 * The paste goes through `view.pasteHTML`, the editor's own clipboard pipeline,
 * so the slice under test is parsed the way a real paste parses it rather than
 * hand-built. Cross-checked in a real browser with a real click and real
 * keystrokes: caret between A and B of a title reading `SAB`, pasting
 * `<p>X</p><p>tail</p>` gives `<h1>SAX</h1><p>tailB</p>` — the same result these
 * cases assert.
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
 * A document with a title and the given body blocks, plus a live editor.
 * @param title - Text for the title.
 * @param bodyHtml - HTML for the blocks after it.
 * @returns The editor bound to it.
 */
function open(title: string, bodyHtml = ''): Editor {
  const doc = new Y.Doc();
  Y.applyUpdate(doc, encodeInitialSpaceContent('document', title));
  const editor = new Editor({
    extensions: buildDocumentExtensions({ fragment: documentBodyFragment(doc) }),
  });
  editors.push(editor);
  if (bodyHtml) {
    editor.commands.setContent(`<h1 class="doc-title">${title}</h1>${bodyHtml}`);
  }
  return editor;
}

/**
 * The document as a list of block type names and their text.
 * @param editor - The editor to read.
 * @returns One entry per top-level block.
 */
function blocks(editor: Editor): { type: string; text: string }[] {
  const out: { type: string; text: string }[] = [];
  editor.state.doc.forEach((node) => {
    out.push({ type: node.type.name, text: node.textContent });
  });
  return out;
}

describe('pasting several paragraphs into the title', () => {
  it('puts the first in the title and the rest under it', () => {
    const editor = open('');
    editor.commands.setTextSelection(1);
    editor.view.pasteHTML('<p>first line</p><p>second line</p>');

    expect(blocks(editor)).toEqual([
      { type: 'title', text: 'first line' },
      { type: 'paragraph', text: 'second line' },
    ]);
  });

  it('keeps all the paragraphs after the first, in order', () => {
    const editor = open('');
    editor.commands.setTextSelection(1);
    editor.view.pasteHTML('<p>one</p><p>two</p><p>three</p>');

    expect(blocks(editor)).toEqual([
      { type: 'title', text: 'one' },
      { type: 'paragraph', text: 'two' },
      { type: 'paragraph', text: 'three' },
    ]);
  });

  it('appends at the caret when the title already says something', () => {
    const editor = open('Draft: ');
    editor.commands.setTextSelection(1 + 'Draft: '.length);
    editor.view.pasteHTML('<p>scene one</p><p>scene two</p>');

    expect(blocks(editor)).toEqual([
      { type: 'title', text: 'Draft: scene one' },
      { type: 'paragraph', text: 'scene two' },
    ]);
  });

  it('splits at a caret in the middle, the tail riding the last pasted block', () => {
    // Enter does the same thing from the same caret, so this is the consistent
    // answer rather than a quirk: the title keeps what was before the caret,
    // and what was after it goes down with the paste.
    const editor = open('AB');
    editor.commands.setTextSelection(1 + 1);
    editor.view.pasteHTML('<p>X</p><p>tail</p>');

    expect(blocks(editor)).toEqual([
      { type: 'title', text: 'AX' },
      { type: 'paragraph', text: 'tailB' },
    ]);
  });

  it('replaces a selection inside the title', () => {
    const editor = open('AB');
    editor.commands.setTextSelection({ from: 1, to: 1 + 2 });
    editor.view.pasteHTML('<p>X</p><p>tail</p>');

    expect(blocks(editor)).toEqual([
      { type: 'title', text: 'X' },
      { type: 'paragraph', text: 'tail' },
    ]);
  });

  it('drops the marks the title cannot hold', () => {
    const editor = open('');
    editor.commands.setTextSelection(1);
    editor.view.pasteHTML('<p><strong>bold</strong></p><p>plain</p>');

    expect(editor.state.doc.child(0).textContent).toBe('bold');
    expect(editor.getHTML()).not.toContain('<strong>bold</strong>');
  });

  it('puts the pasted blocks ahead of blocks that were already there', () => {
    const editor = open('T', '<p>already here</p>');
    editor.commands.setTextSelection(1 + 1);
    editor.view.pasteHTML('<p>one</p><p>two</p>');

    expect(blocks(editor)).toEqual([
      { type: 'title', text: 'Tone' },
      { type: 'paragraph', text: 'two' },
      { type: 'paragraph', text: 'already here' },
    ]);
  });

  it('leaves the caret at the end of what was pasted', () => {
    const editor = open('');
    editor.commands.setTextSelection(1);
    editor.view.pasteHTML('<p>one</p><p>two</p>');

    const { $from } = editor.state.selection;
    expect($from.index(0)).toBe(1);
    expect($from.parentOffset).toBe(3);
  });

  it('a paste of one paragraph just goes into the title', () => {
    const editor = open('AB');
    editor.commands.setTextSelection(1 + 2);
    editor.view.pasteHTML('<p>CDE</p>');

    expect(blocks(editor)).toEqual([{ type: 'title', text: 'ABCDE' }]);
  });

  it('a whole document pasted into the title yields one title, text kept', () => {
    const editor = open('');
    editor.commands.setTextSelection(1);
    editor.view.pasteHTML(
      '<h1 class="doc-title">Their title</h1><p>their body</p>',
    );

    expect(blocks(editor)).toEqual([
      { type: 'title', text: 'Their title' },
      { type: 'paragraph', text: 'their body' },
    ]);
  });
});

describe('pasting into the body is left as it was', () => {
  it('a whole document pasted into the body keeps one title and the text (A20)', () => {
    const editor = open('Mine', '<p>body</p>');
    // End of the body's first block.
    editor.commands.setTextSelection(
      editor.state.doc.child(0).nodeSize + 1 + 'body'.length,
    );
    editor.view.pasteHTML(
      '<h1 class="doc-title">Their title</h1><p>their body</p>',
    );

    const shape = blocks(editor);
    expect(shape.filter((b) => b.type === 'title')).toHaveLength(1);
    expect(shape[0]).toEqual({ type: 'title', text: 'Mine' });
    expect(editor.getText()).toContain('Their title');
    expect(editor.getText()).toContain('their body');
  });

  it('an ordinary multi-paragraph paste into the body is untouched', () => {
    const editor = open('Mine', '<p>body</p>');
    editor.commands.setTextSelection(
      editor.state.doc.child(0).nodeSize + 1 + 'body'.length,
    );
    editor.view.pasteHTML('<p>one</p><p>two</p>');

    expect(blocks(editor)).toEqual([
      { type: 'title', text: 'Mine' },
      { type: 'paragraph', text: 'bodyone' },
      { type: 'paragraph', text: 'two' },
    ]);
  });
});
