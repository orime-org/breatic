// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * A quote holds other blocks, and their margins have to stay inside it.
 *
 * `index.css` does that with `display: flow-root` plus a zeroed margin on the
 * first and last child, so the text still meets the quote's edges. Two things
 * that rule depends on are not visible in the stylesheet, and this file pins
 * both:
 *
 * - the FIRST CHILD ELEMENT is not always the first block. ProseMirror renders
 *   a widget decoration as an element of its own, and one sitting on a block
 *   boundary becomes a direct child of the quote, ahead of the block. The
 *   stylesheet answers for that with a second selector per pair; what it needs
 *   from the DOM is the class prosemirror-view puts on every widget, and the
 *   fact that a gap cursor beside a divider produces one HERE.
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
 * Put a gap cursor at the given document position.
 * @param editor - The editor to place the cursor in.
 * @param pos - A position `GapCursor.valid` accepts.
 */
function placeGapCursor(editor: Editor, pos: number): void {
  const $pos = editor.state.doc.resolve(pos);
  expect(GapCursor.valid($pos), `no gap cursor is valid at ${pos}`).toBe(true);
  editor.view.dispatch(editor.state.tr.setSelection(new GapCursor($pos)));
}

/**
 * Every position in the document a gap cursor can occupy.
 * @param editor - The editor to scan.
 * @returns The valid positions, in document order.
 */
function gapPositions(editor: Editor): number[] {
  const out: number[] = [];
  for (let pos = 0; pos <= editor.state.doc.content.size; pos++) {
    if (GapCursor.valid(editor.state.doc.resolve(pos))) out.push(pos);
  }
  return out;
}

// A divider before the quote is what makes the gap inside it reachable:
// `GapCursor.valid` walks outwards and refuses a position whose preceding
// sibling holds inline content, and the title alone would refuse it.
const BODY = '<hr><blockquote><hr><p>x</p><hr></blockquote>';

describe('a widget decoration inside a quote', () => {
  it('takes the first child slot from the block that opens the quote', () => {
    const editor = open(BODY);
    const [, insideQuoteStart] = gapPositions(editor);
    placeGapCursor(editor, insideQuoteStart);

    const first = editor.view.dom.querySelector('blockquote')?.firstElementChild;
    expect(first?.tagName).toBe('DIV');
    expect(first?.classList.contains('ProseMirror-widget')).toBe(true);
  });

  it('takes the last child slot from the block that closes it', () => {
    const editor = open(BODY);
    const positions = gapPositions(editor);
    placeGapCursor(editor, positions[positions.length - 2]);

    const last = editor.view.dom.querySelector('blockquote')?.lastElementChild;
    expect(last?.tagName).toBe('DIV');
    expect(last?.classList.contains('ProseMirror-widget')).toBe(true);
  });

  it('is answered for by index.css at both ends', () => {
    const css = readFileSync(resolve(__dirname, '../../../index.css'), 'utf8');

    // Without these the block keeps its own margin on the frames above, and
    // the quote springs open while the caret rests beside the divider.
    expect(css).toContain(
      '.doc-body-editor .ProseMirror blockquote > .ProseMirror-widget:first-child + *',
    );
    expect(css).toContain(
      '.doc-body-editor .ProseMirror blockquote > :has(+ .ProseMirror-widget:last-child)',
    );
  });
});
