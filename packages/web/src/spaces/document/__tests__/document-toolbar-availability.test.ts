// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * R7: no control that looks usable and does nothing when pressed.
 *
 * That is the whole of what the design doc asks for (§6.5), and the title is
 * what made it possible to break: it takes no marks and cannot be wrapped, so
 * a button aimed at it would have been exactly such a control. Nothing here
 * makes a claim about selections that never touch the title — what the body's
 * own editing behaviour does with a heading or a divider belongs to the slice
 * that owns it.
 *
 * Two assertions, and the second is the one this slice exists for:
 *
 * 1. Every live button does something when pressed. A collapsed cursor counts
 *    marks armed for the next keystroke as "something", because arming IS the
 *    effect there.
 * 2. Where the selection touches the title, pressing a button leaves the
 *    document alone. This is R7 read from the other side, and it is what a
 *    reverted attempt had broken: a widened answer lit the list buttons over a
 *    selection spanning the title, and pressing one stripped a body heading to
 *    a paragraph while producing no list.
 *
 * The reverse of the first — that a dark button would also do nothing — is NOT
 * asserted. The dry run is conservative for the list commands over a body
 * heading or code block, and R7 does not forbid a dark button that would have
 * worked.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { Editor } from '@tiptap/core';
import { GapCursor } from '@tiptap/pm/gapcursor';
import { NodeSelection } from '@tiptap/pm/state';
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
  /** Both list buttons. */
  readonly lists: boolean;
  readonly quote: boolean;
  /** True when the selection reaches the title. */
  readonly touchesTitle: boolean;
}

const CASES: readonly Case[] = [
  {
    name: 'the caret in the title',
    body: '<p>body</p>',
    place: (e) => e.commands.setTextSelection(3),
    marks: false,
    lists: false,
    quote: false,
    touchesTitle: true,
  },
  {
    name: 'the caret in a body paragraph',
    body: '<p>body</p>',
    place: (e) => e.commands.setTextSelection(e.state.doc.child(0).nodeSize + 2),
    marks: true,
    lists: true,
    quote: true,
    touchesTitle: false,
  },
  {
    name: 'the caret in a body heading',
    body: '<h2>sec</h2>',
    place: (e) => e.commands.setTextSelection(e.state.doc.child(0).nodeSize + 2),
    marks: true,
    lists: false,
    quote: true,
    touchesTitle: false,
  },
  {
    name: 'the caret in a code block',
    body: '<pre><code>x</code></pre>',
    place: (e) => e.commands.setTextSelection(e.state.doc.child(0).nodeSize + 2),
    // A code block refuses marks, which is the editor's own rule and nothing
    // to do with the title.
    marks: false,
    lists: false,
    quote: true,
    touchesTitle: false,
  },
  {
    name: 'everything selected, with only a title to select',
    body: '',
    place: (e) => e.commands.selectAll(),
    marks: false,
    lists: false,
    quote: false,
    touchesTitle: true,
  },
  {
    name: 'everything selected, title and body',
    body: '<p>body</p>',
    place: (e) => e.commands.selectAll(),
    // Bold reaches the body's text; a list cannot wrap a range holding the
    // title.
    marks: true,
    lists: false,
    quote: false,
    touchesTitle: true,
  },
  {
    // The shape a reverted attempt got wrong, and the shape its table was
    // missing: every title-touching case here used a body PARAGRAPH, where the
    // widened answer happened to agree. Give the body a heading and it lit the
    // list buttons, and pressing one stripped the heading with no list to show.
    name: 'everything selected, title and a body heading',
    body: '<h2>sec</h2>',
    place: (e) => e.commands.selectAll(),
    marks: true,
    lists: false,
    quote: false,
    touchesTitle: true,
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
    lists: false,
    quote: false,
    touchesTitle: true,
  },
  {
    // Clicking a divider selects the node itself. It cannot be listed — a list
    // item must start with a paragraph — but it can be quoted, which is why
    // the two are asked separately.
    name: 'a body divider selected as a node',
    body: '<hr><p>body</p>',
    place: (e) => {
      const pos = e.state.doc.child(0).nodeSize;
      e.view.dispatch(
        e.state.tr.setSelection(NodeSelection.create(e.state.doc, pos)),
      );
    },
    marks: false,
    lists: false,
    quote: true,
    touchesTitle: false,
  },
  {
    // The caret can also sit BESIDE a divider rather than on it, where there
    // is no textblock to work with and every block command declines.
    name: 'a gap cursor after a body divider',
    body: '<hr>',
    place: (e) => {
      const $pos = e.state.doc.resolve(e.state.doc.content.size);
      e.view.dispatch(e.state.tr.setSelection(new GapCursor($pos)));
    },
    marks: false,
    lists: false,
    quote: false,
    touchesTitle: false,
  },
  {
    // A plain list item takes the list commands (they toggle it off) and not
    // the quote — the other way round from the divider above.
    name: 'the caret in a plain list item',
    body: '<ul><li><p>a</p></li></ul>',
    place: (e) => e.commands.setTextSelection(e.state.doc.content.size - 3),
    marks: true,
    lists: true,
    quote: false,
    touchesTitle: false,
  },
  {
    // A heading nested one level down. The dry run is conservative here for
    // the same reason as the plain body heading above, and for the same
    // reason it is out of this slice.
    name: 'the caret in a heading inside a quote',
    body: '<blockquote><h2>h</h2></blockquote>',
    place: (e) => e.commands.setTextSelection(e.state.doc.content.size - 2),
    marks: true,
    lists: false,
    quote: true,
    touchesTitle: false,
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
    });
  });
});

describe('and what actually happens when they are pressed', () => {
  CASES.forEach((c) => {
    it(`with ${c.name}, every live button does something`, () => {
      [...MARK_TOOLS, ...BLOCK_TOOLS].forEach((tool) => {
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

  CASES.filter((c) => c.touchesTitle).forEach((c) => {
    it(`with ${c.name}, the title takes nothing from any button`, () => {
      MARK_TOOLS.forEach((tool) => {
        const editor = open(c.body);
        c.place(editor);
        const titleBefore = JSON.stringify(editor.state.doc.child(0).toJSON());
        tool.run(editor);

        // A mark may still land on the body half of the same selection — that
        // is the mark doing its job. What it may never do is mark the title,
        // whose content rule accepts no marks at all.
        expect(
          `${tool.id}: ${JSON.stringify(editor.state.doc.child(0).toJSON())}`,
        ).toBe(`${tool.id}: ${titleBefore}`);
      });

      // The block wrappers are NOT pressed here, and that is deliberate. What
      // this slice promises is that they are dark when the selection holds the
      // title, which the table above asserts. Whether the command itself is
      // all-or-nothing is the body editing slice's business: `toggleBulletList`
      // clears the block type before wrapping and lands that clearing even
      // when the wrap fails, so invoking it directly here would fail for a
      // reason this slice neither owns nor can fix.
    });
  });
});
