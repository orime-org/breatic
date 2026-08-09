// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * The keys that cross the line between the title and the body.
 *
 * The title is a node type nothing else in the schema resembles, so every
 * gesture at that boundary lands in a branch the editor's defaults were not
 * written for. They are pinned together rather than one at a time because they
 * are one decision: what Enter does dictates what Backspace has to undo, and
 * changing either alone leaves the pair inconsistent.
 *
 * NOT covered here, deliberately: the up and down arrows. Vertical caret
 * movement in a contenteditable is the browser's own, not something the
 * editor's key handling sees, so a jsdom test of it would assert nothing. They
 * are checked in the browser instead.
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
 * @returns The fragment and the editor bound to it.
 */
function open(
  title: string,
  bodyHtml = '',
): { body: Y.XmlFragment; editor: Editor } {
  const doc = new Y.Doc();
  Y.applyUpdate(doc, encodeInitialSpaceContent('document', title));
  const body = documentBodyFragment(doc);
  const editor = new Editor({ extensions: buildDocumentExtensions({ fragment: body }) });
  editors.push(editor);
  if (bodyHtml) {
    editor.commands.setContent(
      `<h1 class="doc-title">${title}</h1>${bodyHtml}`,
    );
  }
  return { body, editor };
}

/**
 * Press a key the way the browser delivers one.
 *
 * NOT `editor.commands.keyboardShortcut(...)`: that wrapper takes a
 * transaction from the state BEFORE running the handler and dispatches it
 * afterwards, so a handler that builds and dispatches its own transaction has
 * its work silently reverted. Measured — the same key through this path
 * produces the right document, through that one produces the old.
 * @param editor - The editor to send the key to.
 * @param key - The key name, as `KeyboardEvent.key` reports it.
 */
function press(editor: Editor, key: string): void {
  editor.view.someProp('handleKeyDown', (f) =>
    f(editor.view, new KeyboardEvent('keydown', { key })),
  );
}

/**
 * Where the caret sits, as a block index plus an offset inside that block.
 * @param editor - The editor to read.
 * @returns The caret's block index and its offset within that block's text.
 */
function caret(editor: Editor): { block: number; offset: number } {
  const $from = editor.state.selection.$from;
  return { block: $from.index(0), offset: $from.parentOffset };
}

describe('Enter inside the title', () => {
  it('splits at the caret: what follows becomes the body’s new first block', () => {
    const { editor } = open('ABCDE');
    // Caret after "B" — position 1 is the start of the title's text.
    editor.commands.setTextSelection(1 + 2);
    press(editor, 'Enter');

    expect(editor.state.doc.child(0).textContent).toBe('AB');
    expect(editor.state.doc.child(1).type.name).toBe('paragraph');
    expect(editor.state.doc.child(1).textContent).toBe('CDE');
    // And the caret follows the text it cut loose.
    expect(caret(editor)).toEqual({ block: 1, offset: 0 });
  });

  it('at the end of the title, opens an empty first body block', () => {
    const { editor } = open('ABCDE');
    editor.commands.setTextSelection(1 + 5);
    press(editor, 'Enter');

    expect(editor.state.doc.child(0).textContent).toBe('ABCDE');
    expect(editor.state.doc.child(1).type.name).toBe('paragraph');
    expect(editor.state.doc.child(1).textContent).toBe('');
    expect(caret(editor)).toEqual({ block: 1, offset: 0 });
  });

  it('at the start of the title, moves the whole title text down', () => {
    const { editor } = open('ABCDE');
    editor.commands.setTextSelection(1);
    press(editor, 'Enter');

    expect(editor.state.doc.child(0).type.name).toBe('title');
    expect(editor.state.doc.child(0).textContent).toBe('');
    expect(editor.state.doc.child(1).textContent).toBe('ABCDE');
    expect(caret(editor)).toEqual({ block: 1, offset: 0 });
  });

  it('with a selection, replaces it and then splits at the caret', () => {
    // Selecting a run and pressing a key replaces it — that is what a key does
    // everywhere. Requiring a collapsed cursor left this key doing nothing at
    // all here, because every default handler the editor would fall back on
    // stops at the title's isolating boundary.
    const { editor } = open('ABCDE');
    editor.commands.setTextSelection({ from: 1 + 1, to: 1 + 3 });
    press(editor, 'Enter');

    expect(editor.state.doc.child(0).textContent).toBe('A');
    expect(editor.state.doc.child(1).type.name).toBe('paragraph');
    expect(editor.state.doc.child(1).textContent).toBe('DE');
    expect(caret(editor)).toEqual({ block: 1, offset: 0 });
  });

  it('with the whole title selected, empties it and opens a blank first block', () => {
    const { editor } = open('ABCDE');
    editor.commands.setTextSelection({ from: 1, to: 1 + 5 });
    press(editor, 'Enter');

    expect(editor.state.doc.child(0).type.name).toBe('title');
    expect(editor.state.doc.child(0).textContent).toBe('');
    expect(editor.state.doc.child(1).textContent).toBe('');
    expect(editor.state.doc.childCount).toBe(2);
  });

  it('with a selection reaching into the body, replaces it and splits there', () => {
    // The editor's own Enter answers this one — deleting the selection joins
    // the two blocks and then splits at the caret. It only stopped answering
    // when the title was `isolating`, which made every default bail at the
    // boundary; nothing else picked the key up and it did nothing at all.
    const { editor } = open('ABCDE', '<p>12345</p>');
    const titleSize = editor.state.doc.child(0).nodeSize;
    editor.commands.setTextSelection({ from: 1 + 2, to: titleSize + 1 + 2 });
    press(editor, 'Enter');

    expect(editor.state.doc.child(0).textContent).toBe('AB');
    expect(editor.state.doc.child(1).type.name).toBe('paragraph');
    expect(editor.state.doc.child(1).textContent).toBe('345');
  });

  it('puts the new block first, ahead of blocks that were already there', () => {
    const { editor } = open('ABCDE', '<p>already here</p>');
    editor.commands.setTextSelection(1 + 2);
    press(editor, 'Enter');

    expect(editor.state.doc.child(1).textContent).toBe('CDE');
    expect(editor.state.doc.child(2).textContent).toBe('already here');
  });
});

describe('Backspace at the start of the body', () => {
  it('merges the first block back into the title', () => {
    const { editor } = open('AB', '<p>CDE</p>');
    // Start of the body's first block.
    editor.commands.setTextSelection(editor.state.doc.child(0).nodeSize + 1);
    press(editor, 'Backspace');

    expect(editor.state.doc.child(0).textContent).toBe('ABCDE');
    expect(editor.state.doc.childCount).toBe(1);
    // The caret sits at the join, so typing continues where the text was cut.
    expect(caret(editor)).toEqual({ block: 0, offset: 2 });
  });

  it('drops the marks the title cannot hold', () => {
    const { editor } = open('AB', '<p><strong>CDE</strong></p>');
    editor.commands.setTextSelection(editor.state.doc.child(0).nodeSize + 1);
    press(editor, 'Backspace');

    expect(editor.state.doc.child(0).textContent).toBe('ABCDE');
    expect(editor.getHTML()).not.toContain('<strong>');
  });

  it('when that block is empty, removes it and leaves the title alone', () => {
    const { editor } = open('AB', '<p></p><p>keep me</p>');
    editor.commands.setTextSelection(editor.state.doc.child(0).nodeSize + 1);
    press(editor, 'Backspace');

    expect(editor.state.doc.child(0).textContent).toBe('AB');
    expect(editor.state.doc.childCount).toBe(2);
    expect(editor.state.doc.child(1).textContent).toBe('keep me');
  });

  it('does nothing when the body holds no blocks at all', () => {
    const { body, editor } = open('AB');
    editor.commands.setTextSelection(1 + 2);
    press(editor, 'Backspace');
    // Backspace at the END of the title is ordinary text editing, so a
    // character goes; what must not happen is the title itself going.
    expect(body.length).toBe(1);
    expect((body.get(0) as Y.XmlElement).nodeName).toBe('title');
  });
});

describe('Delete at the end of the title', () => {
  it('pulls the body’s first block up into it', () => {
    const { editor } = open('AB', '<p>CDE</p>');
    editor.commands.setTextSelection(1 + 2);
    press(editor, 'Delete');

    expect(editor.state.doc.child(0).textContent).toBe('ABCDE');
    expect(editor.state.doc.childCount).toBe(1);
    expect(caret(editor)).toEqual({ block: 0, offset: 2 });
  });

  it('does nothing at all when the body is empty', () => {
    const { body, editor } = open('AB');
    editor.commands.setTextSelection(1 + 2);
    press(editor, 'Delete');

    expect(editor.state.doc.child(0).textContent).toBe('AB');
    expect(body.length).toBe(1);
  });
});

describe('when the body’s first block is not a plain textblock', () => {
  // A container block — a list, a quote — is ONE top-level block holding
  // several paragraphs. Treating it as "the body's first paragraph" destroys
  // it. What the editor already does everywhere else in the body is lift the
  // container's first paragraph out and leave the rest of the container
  // standing; a second press then merges that paragraph. Measured in the
  // browser on this very build: `<p>abc</p><ul><li>one</li><li>two</li></ul>`
  // with the caret at the end of `abc` and Delete pressed gives
  // `<p>abc</p><p>one</p><ul><li>two</li></ul>`. The boundary with the title
  // has to behave the same way.

  it('Delete at the end of the title lifts a list’s first item out, keeping the rest', () => {
    const { editor } = open('AB', '<ul><li><p>one</p></li><li><p>two</p></li></ul>');
    editor.commands.setTextSelection(1 + 2);
    press(editor, 'Delete');

    expect(editor.state.doc.child(0).textContent).toBe('AB');
    expect(editor.state.doc.child(1).type.name).toBe('paragraph');
    expect(editor.state.doc.child(1).textContent).toBe('one');
    expect(editor.state.doc.child(2).type.name).toBe('bulletList');
    expect(editor.state.doc.child(2).textContent).toBe('two');
  });

  it('a second Delete then merges that paragraph, as it would any other', () => {
    const { editor } = open('AB', '<ul><li><p>one</p></li><li><p>two</p></li></ul>');
    editor.commands.setTextSelection(1 + 2);
    press(editor, 'Delete');
    editor.commands.setTextSelection(1 + 2);
    press(editor, 'Delete');

    expect(editor.state.doc.child(0).textContent).toBe('ABone');
    expect(editor.state.doc.child(1).type.name).toBe('bulletList');
    expect(editor.state.doc.child(1).textContent).toBe('two');
  });

  it('Delete at the end of the title lifts a quote’s first paragraph out', () => {
    const { editor } = open('AB', '<blockquote><p>q1</p><p>q2</p></blockquote>');
    editor.commands.setTextSelection(1 + 2);
    press(editor, 'Delete');

    expect(editor.state.doc.child(0).textContent).toBe('AB');
    expect(editor.state.doc.child(1).type.name).toBe('paragraph');
    expect(editor.state.doc.child(1).textContent).toBe('q1');
    expect(editor.state.doc.child(2).type.name).toBe('blockquote');
    expect(editor.state.doc.child(2).textContent).toBe('q2');
  });

  it('Backspace inside a quote’s first paragraph lifts it out, title untouched', () => {
    const { editor } = open('AB', '<blockquote><p>q1</p><p>q2</p></blockquote>');
    // Start of `q1`: past the title, past the blockquote's own opening token.
    editor.commands.setTextSelection(editor.state.doc.child(0).nodeSize + 2);
    press(editor, 'Backspace');

    expect(editor.state.doc.child(0).textContent).toBe('AB');
    expect(editor.state.doc.child(1).type.name).toBe('paragraph');
    expect(editor.state.doc.child(1).textContent).toBe('q1');
    expect(editor.state.doc.child(2).type.name).toBe('blockquote');
    expect(editor.state.doc.child(2).textContent).toBe('q2');
  });

  it('Backspace inside a list’s first item lifts it out, title untouched', () => {
    const { editor } = open('AB', '<ul><li><p>one</p></li><li><p>two</p></li></ul>');
    editor.commands.setTextSelection(editor.state.doc.child(0).nodeSize + 3);
    press(editor, 'Backspace');

    expect(editor.state.doc.child(0).textContent).toBe('AB');
    expect(editor.state.doc.child(0).type.name).toBe('title');
    // Whatever shape the lift takes, the one thing that must not happen is the
    // list being swallowed whole: `two` is still in a list of its own.
    expect(editor.getHTML()).toContain('two');
    expect(editor.getHTML()).toContain('<ul>');
  });

  it('a code block, being a textblock, merges as plain text like anywhere else', () => {
    // The editor's own behaviour for a paragraph followed by a code block is to
    // merge the code's text into the paragraph, so the title does the same.
    const { editor } = open('AB', '<pre><code>const a = 1</code></pre>');
    editor.commands.setTextSelection(1 + 2);
    press(editor, 'Delete');

    expect(editor.state.doc.child(0).textContent).toBe('ABconst a = 1');
    expect(editor.state.doc.childCount).toBe(1);
  });

  it('a heading, being a textblock, merges too', () => {
    const { editor } = open('AB', '<h2>section</h2>');
    editor.commands.setTextSelection(1 + 2);
    press(editor, 'Delete');

    expect(editor.state.doc.child(0).textContent).toBe('ABsection');
    expect(editor.state.doc.childCount).toBe(1);
  });

  it('a divider, having no interior at all, is removed', () => {
    // Measured in the body on this build: caret at the end of a paragraph
    // followed by a divider, Delete pressed, and the divider goes. There is
    // nothing to fold in and nothing to lift out, so removing it is the only
    // reading of the key that leaves it doing anything at all.
    const { editor } = open('AB', '<hr><p>after</p>');
    editor.commands.setTextSelection(1 + 2);
    press(editor, 'Delete');

    expect(editor.state.doc.child(0).textContent).toBe('AB');
    expect(editor.state.doc.childCount).toBe(2);
    expect(editor.state.doc.child(1).type.name).toBe('paragraph');
    expect(editor.state.doc.child(1).textContent).toBe('after');
  });

  it('a divider that is the only body block goes too, leaving the title alone', () => {
    const { body, editor } = open('AB', '<hr>');
    editor.commands.setTextSelection(1 + 2);
    press(editor, 'Delete');

    expect(editor.state.doc.childCount).toBe(1);
    expect(editor.state.doc.child(0).type.name).toBe('title');
    expect(body.length).toBe(1);
  });
});

describe('a soft line break in the block being merged', () => {
  it('becomes a space rather than vanishing', () => {
    // The title holds text and nothing else, so a line break cannot survive the
    // merge — but dropping it silently runs the two lines into one word. The
    // body keeps the break outright when merging paragraph into paragraph, so
    // losing the word boundary as well is ours alone.
    const { editor } = open('AB', '<p>one<br>two</p>');
    editor.commands.setTextSelection(1 + 2);
    press(editor, 'Delete');

    expect(editor.state.doc.child(0).textContent).toBe('ABone two');
  });

  it('the same from the Backspace side', () => {
    const { editor } = open('AB', '<p>one<br>two</p>');
    editor.commands.setTextSelection(editor.state.doc.child(0).nodeSize + 1);
    press(editor, 'Backspace');

    expect(editor.state.doc.child(0).textContent).toBe('ABone two');
  });
});

describe('a selection that spans the boundary', () => {
  it('clears the selected text but leaves the title block standing', () => {
    const { body, editor } = open('ABCDE', '<p>12345</p><p>keep me</p>');
    const titleSize = editor.state.doc.child(0).nodeSize;
    // From inside the title through into the first body block.
    editor.commands.setTextSelection({ from: 1 + 2, to: titleSize + 4 });
    editor.commands.deleteSelection();

    expect(editor.state.doc.child(0).type.name).toBe('title');
    expect(body.toString()).toContain('<title>');
    expect(editor.getText()).not.toContain('CDE');
    expect(editor.getText()).toContain('keep me');
  });
});
