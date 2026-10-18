// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * inner#1350 A8 (design §5.7): a page selection whose end lands on an element
 * that wraps a node's content — the table's wrappers, the code block's `pre` —
 * maps to the side of the node the offset points at. Unpatched
 * prosemirror-view 1.42.6 sends every point on the elements between a node's
 * own element and its content (the table's wrappers, the code block's `pre`)
 * to the node's end, whatever the offset, and on the node's own element
 * compares the offset with the content's index in another parent. So a
 * drag-select ending in the table's top padding keeps the whole table while
 * the browser drew none of it.
 */

import { afterEach, describe, expect, it } from 'vitest';
import * as Y from 'yjs';

import { documentBodyFragment } from '@breatic/shared';

import { buildDocumentEditor } from '@web/spaces/document/build-document-editor';
import { tableBlock } from '@web/spaces/document/__tests__/table-fixtures';

type Editor = ReturnType<typeof buildDocumentEditor>;

const mounted: Editor[] = [];

afterEach(() => {
  for (const editor of mounted.splice(0)) editor.unmount();
  document.body.innerHTML = '';
});

/**
 * Opens an editor holding a paragraph, a 1 × 2 table, a code block and a paragraph.
 * @returns The editor.
 */
function open(): Editor {
  const editor = buildDocumentEditor({ fragment: documentBodyFragment(new Y.Doc()) });
  const host = document.createElement('div');
  document.body.appendChild(host);
  editor.mount(host);
  mounted.push(editor);
  editor.replaceBlocks(editor.document, [
    { type: 'paragraph', content: 'above' },
    tableBlock({ rows: [{ cells: ['a1', 'b1'] }] }),
    { type: 'codeBlock', content: 'x = 1' },
    { type: 'paragraph', content: 'below' },
  ] as never);
  return editor;
}

/**
 * The positions just inside a node's start and end.
 * @param editor - The editor.
 * @param type - The node's type name.
 * @returns Its inner start and end.
 */
function inside(editor: Editor, type: string): { start: number; end: number } {
  let found: { start: number; end: number } | null = null;
  editor.prosemirrorState.doc.descendants((node, pos) => {
    if (!found && node.type.name === type) found = { start: pos + 1, end: pos + node.nodeSize - 1 };
    return !found;
  });
  if (!found) throw new Error(`no ${type}`);
  return found;
}

/**
 * The one element a selector names in the body.
 * @param editor - The editor.
 * @param selector - The selector.
 * @returns The element.
 */
function el(editor: Editor, selector: string): Element {
  const found = editor.prosemirrorView!.dom.querySelector(selector);
  if (!found) throw new Error(`no ${selector}`);
  return found;
}

describe('posAtDOM on an element wrapping a node content (patched prosemirror-view)', () => {
  it.each([
    ['the table wrapper, before its inner wrapper', '.tableWrapper', 0, 'start'],
    ['the table wrapper, after its inner wrapper', '.tableWrapper', 1, 'end'],
    ['the inner wrapper, before the table', '.tableWrapper-inner', 0, 'start'],
    ['the inner wrapper, after the table', '.tableWrapper-inner', 1, 'end'],
    ['the table, before its colgroup', 'table', 0, 'start'],
    ['the table, between colgroup and tbody', 'table', 1, 'start'],
    ['the table, after its tbody', 'table', 2, 'end'],
    ['the colgroup, which comes before the rows', 'colgroup', 0, 'start'],
    ['the widgets container, which comes after the rows', '.table-widgets-container', 0, 'end'],
  ] as const)('maps %s to the table %s', (_name, selector, offset, side) => {
    const editor = open();
    const view = editor.prosemirrorView!;
    expect(view.posAtDOM(el(editor, selector), offset)).toBe(inside(editor, 'table')[side]);
  });

  it.each([
    ['before its code element', 0, 'start'],
    ['after its code element', 1, 'end'],
  ] as const)('maps the code block pre %s to the code block %s', (_name, offset, side) => {
    const editor = open();
    const view = editor.prosemirrorView!;
    const pre = el(editor, '.bn-block-content[data-content-type="codeBlock"] pre');
    expect(view.posAtDOM(pre, offset)).toBe(inside(editor, 'codeBlock')[side]);
  });

  it('maps the table block content element after its only child to the table end', () => {
    const editor = open();
    const view = editor.prosemirrorView!;
    const content = el(editor, '.bn-block-content[data-content-type="table"]');
    expect(view.posAtDOM(content, 0)).toBe(inside(editor, 'table').start);
    expect(view.posAtDOM(content, content.childNodes.length)).toBe(inside(editor, 'table').end);
  });
});
