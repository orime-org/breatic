// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * R7: no control that looks usable and does nothing when pressed.
 *
 * The table below RECORDS what the six buttons say for each shape of cursor
 * or selection in the untitled document; the rows are not a judgement on how
 * the body ought to behave, which belongs to the slice that owns editing.
 * Whole-document selection rows (the two-tier select-all's second stage) are
 * deliberately absent — the availability rules for those are task #85's to
 * define against the untitled structure.
 *
 * Two assertions:
 *
 * 1. Each shape of cursor or selection gets the exact answer the table names,
 *    for all six buttons.
 * 2. Every live button does something when pressed. A collapsed cursor counts
 *    marks armed for the next keystroke as "something", because arming IS the
 *    effect there.
 *
 * The reverse of the first — that a dark button would also do nothing — is NOT
 * asserted. The dry run is conservative for the list commands over a body
 * heading or code block, and R7 does not forbid a dark button that would have
 * worked.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { Editor } from '@tiptap/core';
import { NodeSelection } from '@tiptap/pm/state';
import * as Y from 'yjs';
import { documentBodyFragment, encodeInitialSpaceContent } from '@breatic/shared';

import { buildDocumentExtensions } from '@web/spaces/document/document-extensions';
import {
  MARK_TOOLS,
  BLOCK_TOOLS,
  INLINE_TOOLS,
} from '@web/spaces/document/document-tools';

const editors: Editor[] = [];

afterEach(() => {
  editors.splice(0).forEach((e) => {
    e.destroy();
  });
});

/**
 * A document with the given content.
 * @param bodyHtml - The document's HTML.
 * @returns The editor.
 */
function open(bodyHtml: string): Editor {
  const doc = new Y.Doc();
  Y.applyUpdate(doc, encodeInitialSpaceContent('document'));
  const editor = new Editor({
    extensions: buildDocumentExtensions({ fragment: documentBodyFragment(doc) }),
  });
  editors.push(editor);
  if (bodyHtml) {
    editor.commands.setContent(bodyHtml);
  }
  return editor;
}

/** Where the caret or selection sits, and what the six buttons must say. */
interface Case {
  readonly name: string;
  readonly body: string;
  readonly place: (e: Editor) => void;
  readonly marks: boolean;
  /** Both list buttons. */
  readonly lists: boolean;
  readonly quote: boolean;
}

const CASES: readonly Case[] = [
  {
    name: 'the caret in a paragraph',
    body: '<p>body</p>',
    place: (e) => e.commands.setTextSelection(2),
    marks: true,
    lists: true,
    quote: true,
  },
  {
    name: 'the caret in a heading',
    body: '<h2>sec</h2>',
    place: (e) => e.commands.setTextSelection(2),
    marks: true,
    lists: false,
    quote: true,
  },
  {
    name: 'the caret in a code block',
    body: '<pre><code>x</code></pre>',
    place: (e) => e.commands.setTextSelection(2),
    // A code block refuses marks — the editor's own rule.
    marks: false,
    lists: false,
    quote: true,
  },
  {
    // A whole block selected rather than a range inside one. `Mod`-clicking a
    // paragraph is how a user gets here: `prosemirror-view` builds a
    // `NodeSelection` when the platform's select-node modifier is held, and
    // `document-click-to-write` passes modified clicks through. The selection
    // then sits OUTSIDE the block, at document level, which is a shape none of
    // the caret-in-a-textblock cases above covers.
    name: 'a whole paragraph selected as a node',
    body: '<p>body</p><p>more</p>',
    place: (e) => {
      e.view.dispatch(
        e.state.tr.setSelection(NodeSelection.create(e.state.doc, 0)),
      );
    },
    marks: true,
    lists: true,
    quote: true,
  },
  {
    // A plain list item takes the list commands (they toggle it off) and not
    // the quote.
    name: 'the caret in a plain list item',
    body: '<ul><li><p>a</p></li></ul>',
    place: (e) => e.commands.setTextSelection(e.state.doc.content.size - 3),
    marks: true,
    lists: true,
    quote: false,
  },
  {
    // A heading nested one level down. The dry run is conservative here for
    // the same reason as the plain heading above, and for the same reason it
    // is out of this slice.
    name: 'the caret in a heading inside a quote',
    body: '<blockquote><h2>h</h2></blockquote>',
    place: (e) => e.commands.setTextSelection(e.state.doc.content.size - 2),
    marks: true,
    lists: false,
    quote: true,
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
        const expected = tool.id === 'quote' ? c.quote : c.lists;
        expect(`${tool.id}=${tool.canRun(editor)}`).toBe(`${tool.id}=${expected}`);
      });
      // 行内组装的也是 mark，答案跟 MARK_TOOLS 那一列同源。
      INLINE_TOOLS.forEach((tool) => {
        expect(`${tool.id}=${tool.canRun(editor)}`).toBe(`${tool.id}=${c.marks}`);
      });
    });
  });
});

describe('and what actually happens when they are pressed', () => {
  CASES.forEach((c) => {
    it(`with ${c.name}, every live button does something`, () => {
      [...MARK_TOOLS, ...INLINE_TOOLS, ...BLOCK_TOOLS].forEach((tool) => {
        const editor = open(c.body);
        c.place(editor);
        if (!tool.canRun(editor)) return;
        const before = editor.getHTML();
        const marksBefore = JSON.stringify(editor.state.storedMarks ?? null);
        tool.run(editor);
        const changed =
          before !== editor.getHTML() ||
          marksBefore !== JSON.stringify(editor.state.storedMarks ?? null);

        // Either to the document or to the marks the next keystroke carries.
        expect(`${tool.id}: live and changed=${changed}`).toBe(
          `${tool.id}: live and changed=true`,
        );
      });
    });
  });
});
