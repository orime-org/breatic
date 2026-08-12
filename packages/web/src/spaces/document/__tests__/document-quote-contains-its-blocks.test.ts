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
