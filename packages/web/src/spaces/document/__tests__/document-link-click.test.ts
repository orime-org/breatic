// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * #904 验收 A21: a press on a link in the body selects that link.
 *
 * Selecting it is what opens our own panel over it, so the span this resolves
 * decides which link the reader is about to edit. Two links with nothing
 * between them share a position — one ends where the next begins — and a
 * search that accepts both ends of a run answers with the first of the two.
 */

import { describe, it, expect, afterEach } from 'vitest';
import * as Y from 'yjs';

import { documentBodyFragment } from '@breatic/shared';

import { buildDocumentEditor } from '@web/spaces/document/build-document-editor';

const mounted: ReturnType<typeof buildDocumentEditor>[] = [];

afterEach(() => {
  mounted.splice(0).forEach((editor) => {
    editor.unmount();
  });
});

/**
 * Opens an editor over one paragraph.
 * @param content - The paragraph's inline content.
 * @returns The editor.
 */
function open(content: unknown[]): ReturnType<typeof buildDocumentEditor> {
  const editor = buildDocumentEditor({
    fragment: documentBodyFragment(new Y.Doc()),
  });
  const root = document.createElement('div');
  document.body.appendChild(root);
  editor.mount(root);
  mounted.push(editor);
  editor.replaceBlocks(editor.document, [
    { type: 'paragraph', content },
  ] as never);
  return editor;
}

/**
 * Presses the anchor at the given index.
 * @param editor - The editor.
 * @param index - Which anchor, in document order.
 * @returns The text the selection covers afterwards.
 */
function pressLink(
  editor: ReturnType<typeof buildDocumentEditor>,
  index: number,
): string {
  const view = editor.prosemirrorView!;
  const anchor = [...view.dom.querySelectorAll('a')][index]!;
  const event = new MouseEvent('click', { bubbles: true, button: 0 });
  Object.defineProperty(event, 'target', { value: anchor });
  view.someProp('handleClick', (handler) =>
    handler(view, view.posAtDOM(anchor, 0), event),
  );
  const { from, to } = view.state.selection;
  return view.state.doc.textBetween(from, to);
}

/** A link run. */
function link(text: string, href: string): Record<string, unknown> {
  return { type: 'link', href, content: text };
}

describe('pressing a link', () => {
  it('selects the one that was pressed, with a space between them', () => {
    const editor = open([
      link('ONE', 'https://one.example'),
      { type: 'text', text: ' ', styles: {} },
      link('TWO', 'https://two.example'),
    ]);

    expect(pressLink(editor, 0)).toBe('ONE');
    expect(pressLink(editor, 1)).toBe('TWO');
  });

  it('selects the one that was pressed when they touch', () => {
    // `ONE` runs 3..6 and `TWO` opens at 6. A search that takes a position at
    // either end of a run finds `ONE` first and stops there, so the reader
    // pressing the second link edited the first one's address.
    const editor = open([
      link('ONE', 'https://one.example'),
      link('TWO', 'https://two.example'),
    ]);

    expect(pressLink(editor, 0)).toBe('ONE');
    expect(pressLink(editor, 1)).toBe('TWO');
  });
});

describe('a link whose text is not all one style', () => {
  it('selects the whole link, not the run under the pointer', () => {
    // ProseMirror splits a text node on its marks, so a link holding a bold
    // word is two nodes carrying one link mark. The link is what the reader
    // pressed, and the panel that opens edits the link.
    const editor = open([
      { type: 'text', text: 'go ', styles: {} },
      {
        type: 'link',
        href: 'https://example.test',
        content: [
          { type: 'text', text: 'hello ', styles: {} },
          { type: 'text', text: 'world', styles: { bold: true } },
        ],
      },
      { type: 'text', text: ' now', styles: {} },
    ]);

    expect(pressLink(editor, 0)).toBe('hello world');
  });
});
