// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * A quote holds other blocks, and their margins have to stay inside it.
 *
 * `index.css` does that with `display: flow-root` plus a zeroed outer margin on
 * the first and last BLOCK, so the text still meets the quote's edges. It says
 * block rather than child because ProseMirror draws a caret by inserting an
 * element, and one on a block boundary becomes a direct child of the quote
 * ahead of the block. Two facts underneath those rules are invisible in the
 * stylesheet, and this file pins both:
 *
 * - a gap cursor beside a divider opening a quote really does put a
 *   `.ProseMirror-widget` in the first child slot, and a second caret really
 *   can join it — `@tiptap/y-tiptap` gives every remote client its own widget
 *   at its own head position, so a collaborator resting in the same gap adds
 *   one. Selecting the block by counting non-widgets holds for both;
 *   `.ProseMirror-widget:first-child + *`, which this replaced, held only for
 *   the first.
 * - the schema this body ships can put a divider first inside a quote at all,
 *   which is what makes the gap cursor reachable.
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
import { GapCursor } from '@tiptap/pm/gapcursor';
import type { ResolvedPos } from '@tiptap/pm/model';
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
 * `GapCursor.valid` decides where the caret can rest, and upstream marks it
 * `@internal`, so it is absent from the published types. Called through a
 * narrow declaration rather than skipped: without it these cases would place a
 * cursor somewhere no user can reach and still see the widget render, which
 * would make them pass on a situation that never happens.
 */
const gapCursorReaches = GapCursor as unknown as {
  valid(pos: ResolvedPos): boolean;
};

/**
 * Put a gap cursor at a position, having checked the caret can get there.
 * @param editor - The editor to place the cursor in.
 * @param pos - The position to place it at.
 */
function placeGapCursor(editor: Editor, pos: number): void {
  const $pos = editor.state.doc.resolve(pos);
  expect(gapCursorReaches.valid($pos), `no gap cursor rests at ${pos}`).toBe(true);
  editor.view.dispatch(editor.state.tr.setSelection(new GapCursor($pos)));
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

// A divider before the quote is what makes the gap inside it reachable:
// `GapCursor.valid` walks outwards and refuses a position whose preceding
// sibling holds inline content, and the title alone would refuse it.
const BODY = '<hr><blockquote><hr><p>x</p><hr></blockquote>';

describe('a widget decoration inside a quote', () => {
  it('takes the first child slot from the block that opens the quote', () => {
    const editor = open(BODY);
    placeGapCursor(editor, insideTheQuote(editor).start);

    const first = editor.view.dom.querySelector('blockquote')?.firstElementChild;
    expect(first?.tagName).toBe('DIV');
    expect(first?.classList.contains('ProseMirror-widget')).toBe(true);
  });

  it('takes the last child slot from the block that closes it', () => {
    const editor = open(BODY);
    placeGapCursor(editor, insideTheQuote(editor).end);

    const last = editor.view.dom.querySelector('blockquote')?.lastElementChild;
    expect(last?.tagName).toBe('DIV');
    expect(last?.classList.contains('ProseMirror-widget')).toBe(true);
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
