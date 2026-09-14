// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Which link the pointer is over, and which one the caret is in.
 *
 * The two questions the toolbar asks of the document. They were asked of
 * BlockNote's `LinkToolbarExtension`, whose answers the toolbar could not
 * change and whose one-character case had to be patched; they are asked here
 * now, against the same resolver every other link path uses.
 */

import { describe, it, expect, afterEach } from 'vitest';
import * as Y from 'yjs';
import { TextSelection } from '@tiptap/pm/state';

import { documentBodyFragment } from '@breatic/shared';

import { buildDocumentEditor } from '@web/spaces/document/build-document-editor';
import {
  linkAtElement,
  linkAtCaret,
} from '@web/spaces/document/document-link-at';

const HREF = 'https://one.example/';
const OTHER = 'https://two.example/';
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

/** A link run. */
function link(text: string, href: string): Record<string, unknown> {
  return { type: 'link', href, content: text };
}

/** Plain text. */
function text(value: string): Record<string, unknown> {
  return { type: 'text', text: value, styles: {} };
}

/** Where each link in the body sits, in document order. */
function spans(
  editor: ReturnType<typeof buildDocumentEditor>,
): { from: number; to: number }[] {
  const found: { from: number; to: number }[] = [];
  const { doc, schema } = editor.prosemirrorState;
  doc.descendants((node, pos) => {
    if (node.isText && node.marks.some((m) => m.type === schema.marks.link)) {
      found.push({ from: pos, to: pos + (node.text?.length ?? 0) });
    }
    return true;
  });
  return found;
}

/** Put the caret at one position and ask what link it is in. */
function caretAt(
  editor: ReturnType<typeof buildDocumentEditor>,
  at: number,
): ReturnType<typeof linkAtCaret> {
  editor.transact((tr) => {
    tr.setSelection(TextSelection.create(tr.doc, at));
  });
  return linkAtCaret(editor.prosemirrorState);
}

describe('the link an element holds', () => {
  it('answers with the run the anchor wraps', () => {
    const editor = open([text('see '), link('ONE', HREF), text(' now')]);
    const anchor = editor.prosemirrorView!.dom.querySelector('a')!;

    const found = linkAtElement(editor, anchor);

    expect(found.href).toBe(HREF);
    expect(found.range).toEqual(spans(editor)[0]);
  });

  it('answers for a run one character long', () => {
    // The element IS the link, so its length is nobody's business: what made
    // this case hard was deriving a position from the element and asking the
    // marks there, which drop a non-inclusive mark at either boundary.
    const editor = open([text('see '), link('A', HREF), text(' now')]);
    const anchor = editor.prosemirrorView!.dom.querySelector('a')!;

    const found = linkAtElement(editor, anchor);

    expect(found.href).toBe(HREF);
    expect(found.range).toEqual(spans(editor)[0]);
  });

  it('answers with the link the pressed anchor holds when two touch', () => {
    const editor = open([link('ONE', HREF), link('TWO', OTHER)]);
    const second = [...editor.prosemirrorView!.dom.querySelectorAll('a')][1]!;

    expect(linkAtElement(editor, second).href).toBe(OTHER);
  });

  it('answers with nothing for an element holding no link', () => {
    const editor = open([text('see '), link('ONE', HREF)]);
    const paragraph = editor.prosemirrorView!.dom.querySelector('p')!;

    expect(linkAtElement(editor, paragraph).range).toBeNull();
  });
});

describe('the link the caret is in', () => {
  it('answers inside a run', () => {
    const editor = open([text('see '), link('ONE', HREF), text(' now')]);
    const { from } = spans(editor)[0]!;

    const found = caretAt(editor, from + 1);

    expect(found.href).toBe(HREF);
    expect(found.range).toEqual(spans(editor)[0]);
  });

  it('answers with nothing where a run longer than a character ends', () => {
    // The end of such a run is outside it. Answering there raises the toolbar
    // over a link the caret has just finished typing.
    const editor = open([text('see '), link('ONE', HREF), text(' now')]);
    const { to } = spans(editor)[0]!;

    expect(caretAt(editor, to).range).toBeNull();
  });

  it('answers with nothing where a run longer than a character starts', () => {
    const editor = open([text('see '), link('ONE', HREF), text(' now')]);
    const { from } = spans(editor)[0]!;

    expect(caretAt(editor, from).range).toBeNull();
  });

  it('answers at either boundary of a run one character long', () => {
    // Such a run has no interior: both of its boundaries are all there is of
    // it, so a caret that reaches it at all reaches it at a boundary.
    const editor = open([text('see '), link('A', HREF), text(' now')]);
    const span = spans(editor)[0]!;

    expect(caretAt(editor, span.to).range).toEqual(span);
    expect(caretAt(editor, span.from).range).toEqual(span);
  });

  it('answers with nothing outside every link', () => {
    const editor = open([text('see '), link('ONE', HREF), text(' now')]);

    expect(caretAt(editor, 1).range).toBeNull();
  });

  it('answers with nothing while the selection holds text', () => {
    // The panel over a selection owns that case, and two floating controls
    // over one piece of text is the thing being kept away.
    const editor = open([text('see '), link('ONE', HREF), text(' now')]);
    const span = spans(editor)[0]!;
    editor.transact((tr) => {
      tr.setSelection(TextSelection.create(tr.doc, span.from, span.to));
    });

    expect(linkAtCaret(editor.prosemirrorState).range).toBeNull();
  });

  it('answers with one link where two touch', () => {
    // `ONE` ends where `TWO` opens. Both sides of that position carry a link,
    // and they are not the same one — the caret is inside neither.
    const editor = open([link('ONE', HREF), link('TWO', OTHER)]);
    const [first] = spans(editor);

    expect(caretAt(editor, first!.to).range).toBeNull();
  });
});
