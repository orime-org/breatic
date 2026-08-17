// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * A quote holds other blocks, and their margins have to stay inside it.
 *
 * `index.css` does that with `display: flow-root` plus a zeroed outer margin on
 * the first and last BLOCK, so the text still meets the quote's edges. It says
 * block rather than child because ProseMirror draws a caret by inserting an
 * element, and one on a block boundary becomes a direct child of the quote
 * ahead of the block. That is the fact underneath those rules that is invisible
 * in the stylesheet, and this file pins it: a widget decoration at either
 * boundary inside a quote really does take the first or last child slot.
 *
 * WHO PUTS A WIDGET THERE, in production, is a remote collaborator's caret:
 * `@tiptap/y-tiptap` gives every remote client its own widget at its own head,
 * and several can stack up. Mounting a caret provider is more than these cases
 * need, so they register a decoration directly — the same `Decoration.widget`
 * that both a caret and a gap cursor are built from, and the reason
 * `prosemirror-view` stamps `.ProseMirror-widget` on any of them. Two carets at
 * once was verified in the browser instead, and that measurement is recorded
 * with the rules in `index.css`.
 *
 * THESE CASES USED TO REACH THE WIDGET THROUGH A GAP CURSOR beside a divider.
 * That route is gone with the divider (#111), and it could not be repaired by
 * swapping the fixture: measured 2026-08-15, no position in any body this
 * schema can now hold satisfies `GapCursor.valid` — paragraphs, headings,
 * quotes, lists and code blocks were each tried, and every one returned an
 * empty list. `closedBefore` wants a neighbour that is an atom, isolating or
 * empty-and-not-inline, and the only node left answering that is
 * `unsupportedBlock`, which no user reaches. Registering the decoration
 * directly is also the closer test: it is what production actually does.
 *
 * Geometry is not asserted here — jsdom lays nothing out. What the stylesheet
 * does with these elements was measured in a browser and is recorded with the
 * rules themselves; this file holds the DOM facts those rules are written
 * against, so a change in either goes red rather than quiet.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, it, expect, afterEach } from 'vitest';
import { Editor } from '@tiptap/core';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';
import * as Y from 'yjs';
import { documentBodyFragment, encodeInitialSpaceContent } from '@breatic/shared';

import { buildDocumentExtensions } from '@web/spaces/document/document-extensions';

const mounted: Array<{ editor: Editor; host: HTMLElement }> = [];

afterEach(() => {
  mounted.splice(0).forEach(({ editor, host }) => {
    editor.destroy();
    host.remove();
  });
});

/**
 * A mounted editor holding the given body, so decorations reach the DOM.
 * @param bodyHtml - HTML for the blocks after the title.
 * @returns The editor.
 */
function open(bodyHtml: string): Editor {
  const doc = new Y.Doc();
  Y.applyUpdate(doc, encodeInitialSpaceContent('document', 'T'));
  const host = document.createElement('div');
  document.body.appendChild(host);
  const editor = new Editor({
    element: host,
    extensions: buildDocumentExtensions({ fragment: documentBodyFragment(doc) }),
  });
  mounted.push({ editor, host });
  editor.commands.setContent(`<h1 class="doc-title">T</h1>${bodyHtml}`);
  return editor;
}

/**
 * Put a widget decoration at a position, as a remote caret does.
 *
 * The element handed to `Decoration.widget` is a bare `div` with nothing on it:
 * `prosemirror-view` is what adds `ProseMirror-widget` and `contenteditable`,
 * to every widget that does not ask to be raw. Building one here with the class
 * already set would assert the class this file wrote rather than the one
 * production gets.
 * @param editor - The editor to decorate.
 * @param pos - The position to place it at.
 */
function placeWidget(editor: Editor, pos: number): void {
  editor.registerPlugin(
    new Plugin({
      key: new PluginKey(`test-widget-${pos}`),
      props: {
        decorations: (state) =>
          DecorationSet.create(state.doc, [
            Decoration.widget(pos, () => document.createElement('div')),
          ]),
      },
    }),
  );
}

/**
 * Where the quote's own content starts and ends, in document positions.
 * @param editor - The editor holding the quote.
 * @returns The position before its first block and the one after its last.
 */
function insideTheQuote(editor: Editor): { start: number; end: number } {
  let found: { start: number; end: number } | null = null;
  editor.state.doc.descendants((node, pos) => {
    if (found || node.type.name !== 'blockquote') return true;
    found = { start: pos + 1, end: pos + node.nodeSize - 1 };
    return false;
  });
  if (!found) throw new Error('the body holds no quote');
  return found;
}

// Two blocks, so that "first child" and "last child" are different elements
// and a case cannot pass by landing on the same one.
const BODY = '<blockquote><p>x</p><p>y</p></blockquote>';

describe('a widget decoration inside a quote', () => {
  it('takes the first child slot from the block that opens the quote', () => {
    const editor = open(BODY);
    placeWidget(editor, insideTheQuote(editor).start);

    const quote = editor.view.dom.querySelector('blockquote');
    const first = quote?.firstElementChild;
    expect(first?.tagName).toBe('DIV');
    expect(first?.classList.contains('ProseMirror-widget')).toBe(true);
    // The block it displaced is still there, second: the widget takes the slot
    // rather than replacing anything.
    expect(quote?.children[1]?.tagName).toBe('P');
  });

  it('takes the last child slot from the block that closes it', () => {
    const editor = open(BODY);
    placeWidget(editor, insideTheQuote(editor).end);

    const quote = editor.view.dom.querySelector('blockquote');
    const last = quote?.lastElementChild;
    expect(last?.tagName).toBe('DIV');
    expect(last?.classList.contains('ProseMirror-widget')).toBe(true);
    expect(quote?.children[quote.children.length - 2]?.tagName).toBe('P');
  });
});

/**
 * The selector `index.css` uses to zero one of the quote's outer margins.
 *
 * Read out of the stylesheet rather than repeated here, so what the cases below
 * exercise is the rule that ships. Asserting the declaration too is the point:
 * a selector that still reads the same while its `margin` no longer says `0`
 * leaves the quote exactly as broken, and a test that only looks for the
 * selector text would call that green.
 * @param property - `margin-top` or `margin-bottom`.
 * @returns The selector, without the rule body.
 * @throws {Error} If no rule in the file zeroes that margin on a quote's child.
 */
function quoteMarginSelector(property: 'margin-top' | 'margin-bottom'): string {
  // Comments first: they discuss selectors at length, and a selector cannot
  // contain one, so leaving them in only lets a paragraph of prose be read as
  // part of the rule that follows it.
  const css = readFileSync(resolve(__dirname, '../../../index.css'), 'utf8').replace(
    /\/\*[\s\S]*?\*\//g,
    '',
  );
  // Matched on what the rule DOES, not on the scope it is written in. Putting
  // the scope in the search would make the case below — that the scope is
  // still there — true by construction: drop `.doc-body-editor` from the
  // stylesheet and the rule would simply stop being found, which reads as
  // "no such rule" rather than "the scope is gone".
  const rule = /([^{}]*blockquote\s*>[^{}]+?)\{([^}]*)\}/g;
  for (const [, selector, body] of css.matchAll(rule)) {
    if (new RegExp(String.raw`${property}\s*:\s*0\s*;`).test(body)) {
      return selector.trim();
    }
  }
  throw new Error(`no rule in index.css zeroes a quote child's ${property}`);
}

describe('how index.css picks the first and last block in a quote', () => {
  // WHAT THIS DOES NOT DO IS RUN THE SELECTOR, and that is not an omission to
  // be tidied up later. jsdom's selector engine gets `:nth-child(N of S)`
  // wrong: measured on jsdom 29.1.1, `first.matches('blockquote > :nth-child(1
  // of :not(.ProseMirror-widget))')` returns false for an element that the
  // same engine's `querySelectorAll` correctly returns for that selector, and
  // adding an ancestor to the selector makes `querySelectorAll` miss it too.
  // A case built on either would assert the opposite of the truth. What the
  // selector does was measured in a real browser instead — zero, one and two
  // widgets, computed margin 0px on the real block every time — and is
  // recorded with the rules and in the smoke log.
  //
  // So these two hold the SHAPE, which is what a later edit is likely to get
  // wrong: dropping back to `:first-child` (which the caret takes), or keeping
  // the selector while the declaration stops saying `0`.
  it('counts past the carets rather than taking the first child', () => {
    expect(quoteMarginSelector('margin-top')).toContain(
      ':nth-child(1 of :not(.ProseMirror-widget))',
    );
    expect(quoteMarginSelector('margin-bottom')).toContain(
      ':nth-last-child(1 of :not(.ProseMirror-widget))',
    );
  });

  // Without the scope these two would reach the generate panel's prompt editor
  // and the canvas text node, whose quotes this slice never measured.
  it('scopes both to the document body', () => {
    for (const property of ['margin-top', 'margin-bottom'] as const) {
      expect(quoteMarginSelector(property)).toMatch(
        /^\.doc-body-editor\s+\.ProseMirror\s+blockquote\s*>/,
      );
    }
  });
});
