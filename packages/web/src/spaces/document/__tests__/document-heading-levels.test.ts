// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * The body carries three heading levels, not six.
 *
 * StarterKit's Heading ships with `levels: [1..6]`, an input rule per level and
 * a `Mod-Alt-N` shortcut per level, so a fourth level is reachable today. The
 * body only has room for three: `h3` is already 17px against a 15px paragraph,
 * and a fourth would have nowhere left to sit. Notion and Feishu stop at three
 * for the same reason.
 *
 * Narrowing `levels` does NOT delete anything already stored — the option
 * governs input rules, shortcuts and rendering, not the range of the `level`
 * attribute. What it does change is how an out-of-range heading RENDERS:
 * Heading's own `renderHTML` falls back to `levels[0]`, which would show a
 * fourth-level heading as the largest text on the page. A document can hold
 * such a node today, because pasting from another editor produces one, so that
 * fallback is overridden to land on the smallest level we keep instead.
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
 * A document with a title and an editor bound to its body fragment.
 * @param bodyHtml - HTML for the blocks after the title.
 * @returns The editor.
 */
function open(bodyHtml = ''): Editor {
  const doc = new Y.Doc();
  Y.applyUpdate(doc, encodeInitialSpaceContent('document', 'T'));
  const editor = new Editor({
    extensions: buildDocumentExtensions({ fragment: documentBodyFragment(doc) }),
  });
  editors.push(editor);
  if (bodyHtml) {
    editor.commands.setContent(`<h1 class="doc-title">T</h1>${bodyHtml}`);
  }
  return editor;
}

/**
 * Type text one character at a time, the way the editor receives it.
 *
 * Through `handleTextInput`, which is the path the input rules listen on —
 * `insertContent` bypasses them, so a rule that never fires would look like a
 * rule that fired and was refused.
 * @param editor - The editor to type into.
 * @param text - What to type.
 */
function type(editor: Editor, text: string): void {
  for (const ch of text) {
    const { from, to } = editor.state.selection;
    const handled = editor.view.someProp('handleTextInput', (f) =>
      f(editor.view, from, to, ch, () => editor.state.tr.insertText(ch, from, to)),
    );
    if (!handled) editor.commands.insertContent(ch);
  }
}

/**
 * The body blocks, as `type` plus `level` where a block has one.
 * @param editor - The editor to read.
 * @returns One entry per block after the title.
 */
function blocks(editor: Editor): Array<{ type: string; level?: number }> {
  const out: Array<{ type: string; level?: number }> = [];
  editor.state.doc.forEach((node, _offset, index) => {
    if (index === 0) return; // the title
    const level = node.attrs.level as number | undefined;
    out.push(level === undefined ? { type: node.type.name } : { type: node.type.name, level });
  });
  return out;
}

/**
 * Put the caret in the body's first block.
 * @param editor - The editor to place the caret in.
 */
function caretInBody(editor: Editor): void {
  editor.commands.setTextSelection(editor.state.doc.child(0).nodeSize + 1);
}

describe('what the body can be typed into', () => {
  it('turns `### ` into a third-level heading', () => {
    const editor = open('<p></p>');
    caretInBody(editor);
    type(editor, '### ');

    expect(blocks(editor)).toEqual([{ type: 'heading', level: 3 }]);
  });

  it('leaves `#### ` as the characters typed — the body stops at three levels', () => {
    const editor = open('<p></p>');
    caretInBody(editor);
    type(editor, '#### ');

    expect(blocks(editor)).toEqual([{ type: 'paragraph' }]);
    expect(editor.getText()).toContain('####');
  });
});

describe('what the heading command accepts', () => {
  it('accepts the three levels the body keeps', () => {
    const editor = open('<p>x</p>');
    caretInBody(editor);

    for (const level of [1, 2, 3] as const) {
      expect(editor.can().toggleHeading({ level })).toBe(true);
    }
  });

  it('refuses a fourth level', () => {
    const editor = open('<p>x</p>');
    caretInBody(editor);

    expect(editor.can().toggleHeading({ level: 4 })).toBe(false);
  });
});

describe('a fourth-level heading that is already stored', () => {
  // The node a paste from another editor produces.
  const STORED = '<p>before</p><h4>FOURTH</h4><p>after</p>';

  it('is kept, not dropped', () => {
    const editor = open(STORED);

    expect(blocks(editor)).toEqual([
      { type: 'paragraph' },
      { type: 'heading', level: 4 },
      { type: 'paragraph' },
    ]);
    expect(editor.getText()).toContain('FOURTH');
  });

  it('renders as h3 rather than as the largest heading on the page', () => {
    const editor = open(STORED);

    // Heading's stock renderHTML falls back to `levels[0]` — h1 — which would
    // show a minor heading as the biggest text in the document.
    expect(editor.getHTML()).toContain('<h3>FOURTH</h3>');
  });
});
