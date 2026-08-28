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
import { AllSelection, NodeSelection } from '@tiptap/pm/state';
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

/**
 * Select the first node of the given type, the way Cmd+click does.
 * @param editor - The editor.
 * @param nodeName - The node type to pick.
 */
function selectNode(editor: Editor, nodeName: string): void {
  let at = -1;
  editor.state.doc.descendants((node, pos) => {
    if (at < 0 && node.type.name === nodeName) at = pos;
    return true;
  });
  const { doc: d, tr } = editor.state;
  editor.view.dispatch(tr.setSelection(NodeSelection.create(d, at)));
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

  // Cmd+click (Ctrl elsewhere) selects the node under the pointer and steps
  // outward on each further click (`prosemirror-view`'s `selectClickedNode`, `:3269-3294`). Such a
  // selection anchors at the position BEFORE the node, which resolves into
  // whatever holds it — so asking the anchor for its wrappers answers for the
  // ancestors rather than for the node the reader picked.
  it.each([
    ['bullet-list', '<blockquote><ul><li><p>the text</p></li></ul></blockquote>', 'bulletList'],
    ['ordered-list', '<ul><li><p>a</p><ol><li><p>b</p></li></ol></li></ul>', 'orderedList'],
  ])('names %s for a node selection on that list', (blockType, body, nodeName) => {
    const editor = open(body);
    selectNode(editor, nodeName);

    expect(currentBlockType(editor)).toBe(blockType);
  });

  // A wrapper picked this way holds another one, and the walk below reads the
  // innermost — which is the one INSIDE what the reader picked. The node the
  // click landed on is the answer, so it is asked first.
  it('names the picked quote rather than the list it holds', () => {
    const editor = open('<blockquote><ul><li><p>the text</p></li></ul></blockquote>');
    selectNode(editor, 'blockquote');

    expect(currentBlockType(editor)).toBe('quote');
  });

  // Which block a paragraph counts as does not depend on how it was selected:
  // a caret resting in this line answers `bullet-list` too.
  it.each([['listItem'], ['paragraph']])(
    'names the list a picked %s belongs to',
    (nodeName) => {
      const editor = open('<ul><li><p>an item</p></li></ul>');
      selectNode(editor, nodeName);

      expect(currentBlockType(editor)).toBe('bullet-list');
    },
  );
});
