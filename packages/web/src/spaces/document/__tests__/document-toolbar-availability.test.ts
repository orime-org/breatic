// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * A formatting button is live exactly when pressing it would do something.
 *
 * That is R7's promise, and it is the whole of it: a control that looks usable
 * and answers nothing is worse than no control, because the user cannot tell a
 * missed click from a broken feature.
 *
 * Getting it right needs two different questions, because the two kinds of
 * control do different things. A mark applies to text, so its question is
 * whether anything in the selection accepts the mark — and with a collapsed
 * cursor, arming the mark for the next keystroke IS the effect, so the document
 * not changing does not make the button a liar. A block wrapper replaces the
 * structure, so its question is whether the blocks under the selection can be
 * wrapped at all.
 *
 * Both questions are asserted here against every shape a selection can take in
 * this document, and each case says what actually happens as well as what the
 * button claims. Two earlier answers were each wrong somewhere in this table:
 * "is the caret in the title" lit all six for a select-all that could do
 * nothing, and asking the editor to dry-run the command darkened the list
 * buttons over a heading or a code block, where the command works perfectly
 * well — its first step clears the block type, and a dry run performs no steps.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { Editor } from '@tiptap/core';
import * as Y from 'yjs';
import { documentBodyFragment, encodeInitialSpaceContent } from '@breatic/shared';

import { buildDocumentExtensions } from '@web/spaces/document/document-extensions';
import { MARK_TOOLS, BLOCK_TOOLS } from '@web/spaces/document/DocumentToolbar';

const editors: Editor[] = [];

afterEach(() => {
  editors.splice(0).forEach((e) => {
    e.destroy();
  });
});

/**
 * A document with a title and the given body.
 * @param bodyHtml - Body HTML after the title.
 * @returns The editor.
 */
function open(bodyHtml: string): Editor {
  const doc = new Y.Doc();
  Y.applyUpdate(doc, encodeInitialSpaceContent('document', 'TITLE'));
  const editor = new Editor({
    extensions: buildDocumentExtensions({ fragment: documentBodyFragment(doc) }),
  });
  editors.push(editor);
  if (bodyHtml) {
    editor.commands.setContent(`<h1 class="doc-title">TITLE</h1>${bodyHtml}`);
  }
  return editor;
}

/** Where the caret or selection sits, and what the six buttons must say. */
interface Case {
  readonly name: string;
  readonly body: string;
  readonly place: (e: Editor) => void;
  readonly marks: boolean;
  readonly blocks: boolean;
}

const CASES: readonly Case[] = [
  {
    name: 'the caret in the title',
    body: '<p>body</p>',
    place: (e) => e.commands.setTextSelection(3),
    marks: false,
    blocks: false,
  },
  {
    name: 'the caret in a body paragraph',
    body: '<p>body</p>',
    place: (e) => e.commands.setTextSelection(e.state.doc.child(0).nodeSize + 2),
    marks: true,
    blocks: true,
  },
  {
    name: 'the caret in a body heading',
    body: '<h2>sec</h2>',
    place: (e) => e.commands.setTextSelection(e.state.doc.child(0).nodeSize + 2),
    marks: true,
    blocks: true,
  },
  {
    name: 'the caret in a code block',
    body: '<pre><code>x</code></pre>',
    place: (e) => e.commands.setTextSelection(e.state.doc.child(0).nodeSize + 2),
    // A code block refuses marks, which is the editor's own rule and nothing
    // to do with the title.
    marks: false,
    blocks: true,
  },
  {
    name: 'everything selected, with only a title to select',
    body: '',
    place: (e) => e.commands.selectAll(),
    marks: false,
    blocks: false,
  },
  {
    name: 'everything selected, title and body',
    body: '<p>body</p>',
    place: (e) => e.commands.selectAll(),
    // Bold reaches the body's text; a list cannot wrap a range holding the
    // title.
    marks: true,
    blocks: false,
  },
  {
    name: 'a selection running from the title into the body',
    body: '<p>body</p>',
    place: (e) =>
      e.commands.setTextSelection({
        from: 2,
        to: e.state.doc.child(0).nodeSize + 3,
      }),
    marks: true,
    blocks: false,
  },
];

describe('what the buttons claim', () => {
  CASES.forEach((c) => {
    it(`with ${c.name}`, () => {
      const editor = open(c.body);
      c.place(editor);

      MARK_TOOLS.forEach((tool) => {
        expect(`${tool.id}=${tool.canRun(editor)}`).toBe(`${tool.id}=${c.marks}`);
      });
      BLOCK_TOOLS.forEach((tool) => {
        expect(`${tool.id}=${tool.canRun(editor)}`).toBe(`${tool.id}=${c.blocks}`);
      });
    });
  });
});

describe('and what actually happens when they are pressed', () => {
  CASES.forEach((c) => {
    it(`with ${c.name}, every live button changes something`, () => {
      [...MARK_TOOLS, ...BLOCK_TOOLS].forEach((tool) => {
        const editor = open(c.body);
        c.place(editor);
        const live = tool.canRun(editor);
        const before = editor.getHTML();
        const marksBefore = JSON.stringify(editor.state.storedMarks ?? null);
        tool.run(editor);
        const changed =
          before !== editor.getHTML() ||
          marksBefore !== JSON.stringify(editor.state.storedMarks ?? null);

        // A dark button must do nothing. A live one must do something —
        // either to the document or to the marks the next keystroke carries.
        expect(`${tool.id}: live=${live} changed=${changed}`).toBe(
          `${tool.id}: live=${live} changed=${live}`,
        );
      });
    });
  });
});
