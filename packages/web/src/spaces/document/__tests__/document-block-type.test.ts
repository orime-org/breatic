// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Which block the selection counts as.
 *
 * The wiring — what icon gets drawn, which row is marked — is pinned in
 * `selection-bubble-shell.test.tsx`, over selections that a slot in jsdom can
 * be given. What is here is the answer that wiring reads, over the selection
 * shapes the bar cannot be raised on without a pointer.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Editor } from '@tiptap/react';
import { AllSelection } from '@tiptap/pm/state';
import * as Y from 'yjs';

import { documentBodyFragment, encodeInitialSpaceContent } from '@breatic/shared';
import { buildDocumentExtensions } from '@web/spaces/document/document-extensions';
import { currentBlockType } from '@web/spaces/document/document-block-type';

const editors: Editor[] = [];
let doc: Y.Doc;

beforeEach(() => {
  doc = new Y.Doc();
  Y.applyUpdate(doc, encodeInitialSpaceContent('document'));
});

afterEach(() => {
  editors.splice(0).forEach((e) => {
    e.destroy();
  });
  doc.destroy();
  vi.restoreAllMocks();
});

/**
 * An editor holding the given body, bound to a real Y.Doc.
 * @param bodyHtml - The body's HTML.
 * @returns The editor.
 */
function open(bodyHtml: string): Editor {
  const editor = new Editor({
    extensions: buildDocumentExtensions({ fragment: documentBodyFragment(doc) }),
  });
  editors.push(editor);
  editor.commands.setContent(bodyHtml);
  return editor;
}

/**
 * Put the whole document in the selection, the way the second Mod-a tier does.
 * @param editor - The editor.
 */
function selectAll(editor: Editor): void {
  const { doc: d, tr } = editor.state;
  editor.view.dispatch(tr.setSelection(new AllSelection(d)));
}

describe('currentBlockType', () => {
  // An `AllSelection` anchors at 0, which resolves to the document node
  // itself rather than to any text block. The face still has to name a block,
  // and the one the anchor end sits at is the first the selection covers.
  it.each([
    ['heading-1', '<h1>a heading</h1><ul><li><p>an item</p></li></ul>'],
    ['quote', '<blockquote><p>a line</p></blockquote><p>a paragraph</p>'],
    ['bullet-list', '<ul><li><p>an item</p></li></ul><h2>a heading</h2>'],
  ])('names the first block, %s, under a select-all', (blockType, body) => {
    const editor = open(body);
    selectAll(editor);

    expect(currentBlockType(editor)).toBe(blockType);
  });

  it('names the only block type when a select-all covers one kind', () => {
    const editor = open('<h1>one heading</h1><h1>and another</h1>');
    selectAll(editor);

    expect(currentBlockType(editor)).toBe('heading-1');
  });
});
