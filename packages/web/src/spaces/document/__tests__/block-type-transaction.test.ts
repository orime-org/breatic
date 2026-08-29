// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * One press builds one transaction, and every selection shape reaches it.
 *
 * Counting dispatches rather than staging a failure: `chain().run()` dispatches
 * before it reports success (`@tiptap/core@3.29.2` `dist/index.js:82-87`), so
 * a single dispatch is what makes a press all-or-nothing in the first place.
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import { AllSelection, NodeSelection } from '@tiptap/pm/state';
import type { Editor } from '@tiptap/core';

import { runBlockType } from '@web/spaces/document/document-block-model';
import type { BlockTypeId } from '@web/spaces/document/document-block-model';

import { openBody, closeAll, selectBlock, selectWholeBody } from './block-type-fixtures';

afterEach(() => {
  closeAll();
  vi.restoreAllMocks();
});

/**
 * How many transactions a press dispatches.
 * @param editor - The editor.
 * @param id - Which row.
 * @returns The count.
 */
function dispatchesOf(editor: Editor, id: BlockTypeId): number {
  let count = 0;
  const spy = vi.spyOn(editor.view, 'dispatch');
  spy.mockImplementation((...args) => {
    count += 1;
    return Object.getPrototypeOf(editor.view).dispatch.apply(editor.view, args);
  });
  runBlockType(editor, id);
  spy.mockRestore();
  return count;
}

describe('one press, one transaction', () => {
  it.each([
    ['heading-1', '<ul><li><p>x</p></li></ul>'],
    ['bullet-list', '<blockquote><h1>x</h1></blockquote>'],
    ['quote', '<ol><li><p>one</p></li><li><p>two</p></li></ol>'],
  ] as const)('pressing %s dispatches once', (id, start) => {
    const editor = openBody(start);
    selectWholeBody(editor);
    expect(dispatchesOf(editor, id)).toBe(1);
  });

  it.each([
    ['heading-1', '<ul><li><p>x</p></li></ul>'],
    ['bullet-list', '<blockquote><h1>x</h1></blockquote>'],
    ['quote', '<ol><li><p>one</p></li><li><p>two</p></li></ol>'],
  ] as const)('one undo puts the document back after pressing %s', (id, start) => {
    const editor = openBody(start);
    selectWholeBody(editor);
    const before = editor.getHTML();
    runBlockType(editor, id);
    expect(editor.getHTML()).not.toBe(before);
    editor.commands.undo();
    expect(editor.getHTML()).toBe(before);
  });
});

describe('selection shapes other than a plain range', () => {
  it('gives an AllSelection the same result as the equivalent text selection', () => {
    const start = '<h1>one</h1><ol><li><p>two</p></li></ol>';
    const viaText = openBody(start);
    selectWholeBody(viaText);
    runBlockType(viaText, 'bullet-list');

    const viaAll = openBody(start);
    viaAll.view.dispatch(
      viaAll.state.tr.setSelection(new AllSelection(viaAll.state.doc)),
    );
    runBlockType(viaAll, 'bullet-list');

    expect(viaAll.getHTML()).toBe(viaText.getHTML());
  });

  it('gives a node selection the same result as selecting that block', () => {
    const start = '<p>one</p><p>two</p>';
    const viaText = openBody(start);
    selectBlock(viaText, 'two');
    runBlockType(viaText, 'heading-1');

    const viaNode = openBody(start);
    let at = 0;
    viaNode.state.doc.descendants((node, pos) => {
      if (node.isTextblock && node.textContent === 'two') at = pos;
      return true;
    });
    viaNode.view.dispatch(
      viaNode.state.tr.setSelection(NodeSelection.create(viaNode.state.doc, at)),
    );
    runBlockType(viaNode, 'heading-1');

    expect(viaNode.getHTML()).toBe(viaText.getHTML());
  });
});

describe('a selection holding no text block', () => {
  it.each([
    ['paragraph'],
    ['heading-1'],
    ['heading-2'],
    ['heading-3'],
    ['bullet-list'],
    ['ordered-list'],
    ['task-list'],
    ['code-block'],
    ['quote'],
  ] as const)('pressing %s on an empty document changes nothing', (id) => {
    const editor = openBody('');
    const before = editor.getHTML();
    editor.commands.setTextSelection({ from: 0, to: 0 });
    expect(() => {
      runBlockType(editor, id);
    }).not.toThrow();
    expect(editor.getHTML()).toBe(before);
  });
});

describe('a stored heading below level three', () => {
  it('does not throw when a row is pressed on it', () => {
    const editor = openBody('<h1>x</h1>');
    const heading = editor.state.schema.nodes.heading;
    if (!heading) throw new Error('no heading node in the schema');
    editor.view.dispatch(editor.state.tr.setNodeMarkup(0, heading, { level: 4 }));
    selectBlock(editor, 'x');
    expect(() => {
      runBlockType(editor, 'heading-1');
    }).not.toThrow();
    expect(editor.getHTML()).toBe('<h1>x</h1>');
  });
});
