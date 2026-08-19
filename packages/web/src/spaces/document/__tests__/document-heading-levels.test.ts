// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * The body carries three heading levels, not six.
 *
 * StarterKit's Heading ships with `levels: [1..6]`, an input rule per level and
 * a `Mod-Alt-N` shortcut per level, so on stock StarterKit a fourth level
 * would be reachable. The body only has room for three: `h3` is already 17px against a 15px paragraph,
 * and a fourth would have nowhere left to sit. Notion and Feishu stop at three
 * for the same reason.
 *
 * Narrowing `levels` does NOT delete anything already stored — the option
 * governs input rules, shortcuts and rendering, not the range of the `level`
 * attribute. What it does change is how an out-of-range heading RENDERS:
 * Heading's own `renderHTML` falls back to `levels[0]`, which would show a
 * fourth-level heading as the largest text on the page, so that fallback is
 * overridden to land on the smallest level we keep instead.
 *
 * Both halves are asserted below, and so is the reason each is needed: a
 * pasted `<h4>` no longer parses as a heading at all, while one that arrives
 * over the wire from a six-level peer stays a heading and has to render small.
 *
 * The cases that enumerate the levels read them from `BODY_HEADING_LEVELS`; the
 * out-of-range ones say `4` outright, on purpose. IF WIDENING THE CAP TURNS
 * THOSE RED, THE FIX IS NOT TO BUMP THE NUMBER — `index.css` needs a rule for
 * the level being added first, since preflight resets `h1..h6` to inherit and a
 * level with no rule of its own renders at the paragraph's size and weight.
 * `gives each level it keeps a size and a weight in index.css` reads the
 * stylesheet off disk and says so, so widening the array on its own turns that
 * one red too rather than passing quietly.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, it, expect, afterEach } from 'vitest';
import { Editor, getSchema, type Extensions } from '@tiptap/core';
import { Document } from '@tiptap/extension-document';
import { Heading, type Level } from '@tiptap/extension-heading';
import { Paragraph } from '@tiptap/extension-paragraph';
import { Text } from '@tiptap/extension-text';
import { DOMSerializer } from '@tiptap/pm/model';
import * as Y from 'yjs';
import { documentBodyFragment, encodeInitialSpaceContent } from '@breatic/shared';

import { buildDocumentExtensions } from '@web/spaces/document/document-extensions';
import { BODY_HEADING_LEVELS, BodyHeading } from '@web/spaces/document/document-heading';

const editors: Editor[] = [];

afterEach(() => {
  editors.splice(0).forEach((e) => {
    e.destroy();
  });
});

/**
 * An editor bound to a freshly-seeded document's body fragment.
 * @param bodyHtml - HTML for the document's blocks.
 * @returns The editor.
 */
function open(bodyHtml = ''): Editor {
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
 * @returns One entry per block.
 */
function blocks(editor: Editor): Array<{ type: string; level?: number }> {
  const out: Array<{ type: string; level?: number }> = [];
  editor.state.doc.forEach((node) => {
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
  editor.commands.setTextSelection(1);
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

    for (const level of BODY_HEADING_LEVELS) {
      expect(editor.can().toggleHeading({ level })).toBe(true);
    }
  });

  it('refuses a fourth level', () => {
    const editor = open('<p>x</p>');
    caretInBody(editor);

    expect(editor.can().toggleHeading({ level: 4 })).toBe(false);
  });
});

describe('how the levels the body keeps render', () => {
  it('gives each level it keeps its own tag', () => {
    // The override in `document-heading` answers for two cases, and only the
    // out-of-range one is asserted below. Without this, rendering EVERY heading
    // at the fallback level passes the whole suite — while `h1` and `h2` stop
    // matching their stylesheet rules and all three levels collapse to one size.
    //
    // Driven off the constant rather than a literal list, so that widening the
    // cap fails here on the level that has no rule yet instead of passing.
    const written = BODY_HEADING_LEVELS.map((level) => `<h${level}>T${level}</h${level}>`);
    const editor = open(written.join(''));
    const html = editor.getHTML();

    for (const level of BODY_HEADING_LEVELS) {
      expect(html).toContain(`<h${level}>T${level}</h${level}>`);
    }
  });

  // Preflight resets `h1..h6` to `font-size: inherit; font-weight: inherit`, so
  // a level with no rule of its own is not a smaller heading — it is a
  // paragraph wearing a heading's tag, which is the defect this slice removes.
  // Nothing in the language connects the array to the stylesheet, but a test
  // can read both, and four already do it elsewhere in this package.
  it('gives each level it keeps a size and a weight in index.css', () => {
    // Comments first. A selector cannot contain one, and this stylesheet
    // quotes selectors in its prose constantly — leaving them in lets a
    // sentence mentioning `h4` be read as the start of an h4 rule, with
    // `[^{]*` running past the comment's end to swallow the NEXT rule's body.
    // Measured: adding a comment that says h4 has no rule yet makes this case
    // green on all four levels, which is the one edit it exists to catch.
    const css = readFileSync(resolve(__dirname, '../../../index.css'), 'utf8').replace(
      /\/\*[\s\S]*?\*\//g,
      '',
    );

    for (const level of BODY_HEADING_LEVELS) {
      const rule = new RegExp(
        String.raw`\.doc-body-editor\s+\.ProseMirror\s+h${level}[^{]*\{[^}]*\}`,
      ).exec(css)?.[0];

      expect(rule, `no rule selects h${level} in the document body`).toBeDefined();
      expect(rule).toMatch(/font-size:/);
      expect(rule).toMatch(/font-weight:/);
    }
  });
});

describe('narrowing the levels a second time', () => {
  /**
   * What `BodyHeading` renders a stored level as, under a given `levels`.
   *
   * Serialised straight from the schema rather than round-tripped through
   * `setContent`, which would parse an out-of-range tag as a paragraph and
   * never reach `renderHTML` at all.
   * @param levels - What to configure the extension with, or undefined to ship as-is.
   * @param stored - The `level` attribute on the node being rendered.
   * @returns The heading's serialised HTML.
   */
  function renderAt(levels: Level[] | undefined, stored: number): string {
    const heading = levels ? BodyHeading.configure({ levels }) : BodyHeading;
    const schema = getSchema([Document, Text, Paragraph, heading]);
    const node = schema.nodes.heading.create({ level: stored }, schema.text('X'));
    const box = document.createElement('div');
    box.appendChild(DOMSerializer.fromSchema(schema).serializeNode(node));
    return box.innerHTML;
  }

  // The override answers for a level outside the range by re-rendering it at
  // the SMALLEST level kept. Which levels are kept is a runtime option, so the
  // fallback has to be read from the same place — Heading's own renderHTML
  // consults `this.options.levels`, and a fallback derived from anywhere else
  // can land outside it, where that code sends the node to `levels[0]`, the
  // largest heading on the page.
  //
  // Nothing configures this extension a second time today. That is why this
  // case exists: it holds the property rather than the current call graph.
  it('still lands on the smallest level kept, not the largest', () => {
    expect(renderAt([1, 2], 3)).toBe('<h2>X</h2>');
    expect(renderAt([1, 2], 4)).toBe('<h2>X</h2>');
    expect(renderAt([1], 3)).toBe('<h1>X</h1>');
  });

  it('leaves the shipped configuration where it was', () => {
    expect(renderAt(undefined, 4)).toBe('<h3>X</h3>');
    expect(renderAt(undefined, 6)).toBe('<h3>X</h3>');
    for (const level of BODY_HEADING_LEVELS) {
      expect(renderAt(undefined, level)).toBe(`<h${level}>X</h${level}>`);
    }
  });
});

describe('pasting a fourth-level heading', () => {
  it('lands as a paragraph, because nothing parses an h4 any more', () => {
    const editor = open('<p>before</p><h4>PASTED</h4><p>after</p>');

    expect(blocks(editor)).toEqual([
      { type: 'paragraph' },
      { type: 'paragraph' },
      { type: 'paragraph' },
    ]);
    // The words survive; only the heading-ness is gone.
    expect(editor.getText()).toContain('PASTED');
  });
});

describe('a fourth-level heading already stored in the document', () => {
  /**
   * The extension list as it stood before the body capped headings at three.
   *
   * Used to author the other side of the wire — a peer still running the
   * six-level bundle, or the same document as it was written before the cap.
   * StarterKit's heading is already off, so swapping ours out and putting stock
   * Heading back reproduces exactly the schema that shipped before.
   * @param fragment - The body fragment that editor binds to.
   * @returns The extension list, with six heading levels instead of three.
   */
  function sixLevelExtensions(fragment: Y.XmlFragment): Extensions {
    return buildDocumentExtensions({ fragment })
      .filter((extension) => extension.name !== 'heading')
      .concat(Heading.configure({ levels: [1, 2, 3, 4, 5, 6] }));
  }

  /**
   * A body holding a `level: 4` heading that arrived over the wire.
   *
   * The heading is authored by a SIX-level editor, encoded out of its Y.Doc and
   * applied to a second one, which a three-level editor then binds to — the
   * path a document written before the cap actually takes to reach this client.
   *
   * BE CLEAR ABOUT WHAT THIS HOLDS AND WHAT IT DOES NOT. Narrowing `levels` can
   * never drop a heading: `levels` governs input rules, shortcuts and rendering,
   * not the attribute's range. Heading declares `level` with no `validate`, and
   * the path Yjs loads through (`NodeType.create` -> `computeAttrs`) would not
   * run one anyway. So this case is green on stock six-level Heading too, and it
   * pins nothing about the cap — the sibling case below is the one that does.
   *
   * What it does hold is the loss that WOULD be silent: y-tiptap drops whatever
   * the receiving schema fails to recognise and commits the deletion as an
   * ordinary local change, so it syncs to every peer and persists. Verified by
   * mutation — filter the heading extension out of the receiving list and three
   * blocks become two, with both assertions red. That is the guard, against a
   * future change to this schema or an upstream one, not against this slice.
   * @returns An editor on the three-level schema, bound to the received body.
   */
  function withStoredFourth(): Editor {
    const authored = new Y.Doc();
    Y.applyUpdate(authored, encodeInitialSpaceContent('document'));
    const olderPeer = new Editor({
      extensions: sixLevelExtensions(documentBodyFragment(authored)),
    });
    editors.push(olderPeer);
    olderPeer.commands.setContent(
      '<p>before</p><h4>FOURTH</h4><p>after</p>',
    );

    const received = new Y.Doc();
    Y.applyUpdate(received, Y.encodeStateAsUpdate(authored));
    const editor = new Editor({
      extensions: buildDocumentExtensions({ fragment: documentBodyFragment(received) }),
    });
    editors.push(editor);
    return editor;
  }

  it('survives the trip to a client that keeps three levels', () => {
    const editor = withStoredFourth();

    expect(blocks(editor)).toEqual([
      { type: 'paragraph' },
      { type: 'heading', level: 4 },
      { type: 'paragraph' },
    ]);
    expect(editor.getText()).toContain('FOURTH');
  });

  it('renders as h3 rather than as the largest heading on the page', () => {
    const editor = withStoredFourth();

    // Heading's stock renderHTML falls back to `levels[0]` — h1 — which would
    // show a minor heading as the biggest text in the document.
    expect(editor.getHTML()).toContain('<h3>FOURTH</h3>');
    expect(editor.getHTML()).not.toContain('<h1>FOURTH</h1>');
  });
});
