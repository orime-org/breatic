// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * The two placeholders, and why they are drawn here rather than by the
 * placeholder extension every other editor uses.
 *
 * That extension decorates textblocks that EXIST in the document, and by
 * default only the one holding the caret. Neither fits this document. A body
 * with no blocks has nothing to decorate, so the body's placeholder could
 * never be drawn at all; and a fresh document wants both placeholders visible
 * at once, which one decoration cannot do. Verified in the installed source:
 * `@tiptap/extensions` skips anything that is not a textblock, and its
 * defaults are `showOnlyCurrent: true` / `includeChildren: false`.
 *
 * So the document marks its own state and the stylesheet draws the text. What
 * is asserted here is the marking — the class and the string that goes with
 * it. Whether the text is actually painted is a CSS question and is checked in
 * the browser.
 *
 * The rule the generate prompt relies on is untouched; the case at the bottom
 * is here so that stays true.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { Editor } from '@tiptap/core';
import * as Y from 'yjs';
import { documentBodyFragment, encodeInitialSpaceContent } from '@breatic/shared';

import { buildDocumentExtensions } from '@web/spaces/document/document-extensions';
import {
  DOCUMENT_BODY_EMPTY_CLASS,
  DOCUMENT_TITLE_EMPTY_CLASS,
} from '@web/spaces/document/document-placeholders';

const editors: Editor[] = [];

afterEach(() => {
  editors.splice(0).forEach((e) => {
    e.destroy();
  });
});

/**
 * A seeded document with a live editor over it.
 * @param title - The title's text; empty for a document nobody has named.
 * @param bodyHtml - HTML for the blocks after the title, if any.
 * @returns The editor bound to it.
 */
function open(title: string, bodyHtml = ''): Editor {
  const doc = new Y.Doc();
  Y.applyUpdate(doc, encodeInitialSpaceContent('document', title));
  const editor = new Editor({
    extensions: buildDocumentExtensions({ fragment: documentBodyFragment(doc) }),
  });
  editors.push(editor);
  if (bodyHtml) {
    editor.commands.setContent(
      `<h1 class="doc-title">${title}</h1>${bodyHtml}`,
    );
  }
  return editor;
}

/**
 * The rendered title element.
 * @param editor - The editor to read.
 * @returns The element the title renders as.
 */
function titleEl(editor: Editor): Element {
  const el = editor.view.dom.firstElementChild;
  if (!el) throw new Error('the document rendered without a title');
  return el;
}

describe('the title placeholder', () => {
  it('is marked when the title has no text', () => {
    const editor = open('');
    expect(titleEl(editor).classList.contains(DOCUMENT_TITLE_EMPTY_CLASS)).toBe(true);
    expect(titleEl(editor).getAttribute('data-placeholder')).toBeTruthy();
  });

  it('is not marked once the title says something', () => {
    const editor = open('Storyboard v3');
    expect(titleEl(editor).classList.contains(DOCUMENT_TITLE_EMPTY_CLASS)).toBe(false);
  });

  it('comes back the moment the title is cleared again', () => {
    const editor = open('Storyboard v3');
    editor.commands.setTextSelection({ from: 1, to: 1 + 13 });
    editor.commands.deleteSelection();
    expect(titleEl(editor).classList.contains(DOCUMENT_TITLE_EMPTY_CLASS)).toBe(true);
  });
});

describe('the body placeholder', () => {
  it('is marked when the body holds no blocks', () => {
    const editor = open('Storyboard v3');
    expect(editor.view.dom.classList.contains(DOCUMENT_BODY_EMPTY_CLASS)).toBe(true);
    expect(editor.view.dom.getAttribute('data-body-placeholder')).toBeTruthy();
  });

  it('goes away as soon as the body holds one', () => {
    const editor = open('Storyboard v3', '<p>written</p>');
    expect(editor.view.dom.classList.contains(DOCUMENT_BODY_EMPTY_CLASS)).toBe(false);
  });

  it('comes back when the last body block is removed', () => {
    const editor = open('Storyboard v3', '<p>written</p>');
    const titleSize = editor.state.doc.child(0).nodeSize;
    editor.commands.deleteRange({ from: titleSize, to: editor.state.doc.content.size });
    expect(editor.view.dom.classList.contains(DOCUMENT_BODY_EMPTY_CLASS)).toBe(true);
  });
});

describe('both at once', () => {
  it('a document nobody has named or written in shows both', () => {
    const editor = open('');
    expect(titleEl(editor).classList.contains(DOCUMENT_TITLE_EMPTY_CLASS)).toBe(true);
    expect(editor.view.dom.classList.contains(DOCUMENT_BODY_EMPTY_CLASS)).toBe(true);
  });

  it('and they carry different text', () => {
    const editor = open('');
    expect(titleEl(editor).getAttribute('data-placeholder')).not.toBe(
      editor.view.dom.getAttribute('data-body-placeholder'),
    );
  });
});
