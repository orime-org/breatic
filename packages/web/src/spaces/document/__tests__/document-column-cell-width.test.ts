// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * inner#1314 design §5.1: columns made in a cell write down the table's drawn
 * widths in the transaction that made them, widening the cell's column when
 * the cell is too narrow; a body written as it was saved keeps its widths.
 */

import { afterEach, describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import type { Node as PMNode } from '@tiptap/pm/model';

import { documentBodyFragment } from '@breatic/shared';

import { buildDocumentEditor } from '@web/spaces/document/build-document-editor';
import { dropRowBeside } from '@web/spaces/document/document-column-drop';
import { SAVED_BODY } from '@web/spaces/document/document-column-repair';
import { columnsBlock, para } from '@web/spaces/document/__tests__/column-fixtures';
import { tableBlock } from '@web/spaces/document/__tests__/table-fixtures';

type Editor = ReturnType<typeof buildDocumentEditor>;

const mounted: Editor[] = [];
const restores: (() => void)[] = [];

afterEach(() => {
  for (const editor of mounted.splice(0)) editor.unmount();
  for (const restore of restores.splice(0)) restore();
  document.body.innerHTML = '';
});

/**
 * An editor holding the given blocks.
 * @param blocks - The top-level blocks.
 * @returns The editor.
 */
function open(blocks: readonly unknown[]): Editor {
  const editor = buildDocumentEditor({ fragment: documentBodyFragment(new Y.Doc()) });
  const host = document.createElement('div');
  document.body.appendChild(host);
  editor.mount(host);
  mounted.push(editor);
  editor.replaceBlocks(editor.document, blocks as never);
  return editor;
}

/**
 * The id of the first row whose words are these.
 * @param editor - The editor.
 * @param words - The words.
 * @returns The id.
 */
function idOf(editor: Editor, words: string): string {
  let found: string | undefined;
  editor.prosemirrorState.doc.descendants((node: PMNode) => {
    if (found === undefined && node.type.name === 'blockContainer' && node.firstChild?.textContent === words) {
      found = String(node.attrs['id']);
    }
    return found === undefined;
  });
  if (found === undefined) throw new Error(`no row "${words}"`);
  return found;
}

/**
 * Each cell's stored widths, in document order.
 * @param editor - The editor.
 * @returns One entry per cell.
 */
function storedWidths(editor: Editor): unknown[] {
  const widths: unknown[] = [];
  editor.prosemirrorState.doc.descendants((node: PMNode) => {
    if (node.type.name === 'docTableCell') widths.push(node.attrs['colwidth']);
    return true;
  });
  return widths;
}

/**
 * Draws every element this wide, inside and out.
 * @param width - The width.
 */
function drawEverythingAt(width: number): void {
  for (const property of ['clientWidth', 'offsetWidth'] as const) {
    const saved = Object.getOwnPropertyDescriptor(HTMLElement.prototype, property);
    Object.defineProperty(HTMLElement.prototype, property, { configurable: true, get: () => width });
    restores.push(() => {
      if (saved === undefined) delete (HTMLElement.prototype as unknown as Record<string, unknown>)[property];
      else Object.defineProperty(HTMLElement.prototype, property, saved);
    });
  }
}

describe('columns made in a cell (design §5.1)', () => {
  it('widen a narrow cell\'s column in the transaction that made them', () => {
    drawEverythingAt(120);
    const editor = open([tableBlock({ rows: [{ cells: [{ blocks: [para('a'), para('b')] }, 'z'] }] })]);
    dropRowBeside(editor as never, idOf(editor, 'b'), idOf(editor, 'a'), 'right');
    // 120 + (2 × 96 + 72) − 118: the cell's 1px padding each side leaves 118.
    expect(storedWidths(editor)).toEqual([[266], [120]]);
  });

  it('write down the drawn widths when the cell already holds them', () => {
    drawEverythingAt(300);
    const editor = open([tableBlock({ rows: [{ cells: [{ blocks: [para('a'), para('b')] }, 'z'] }] })]);
    dropRowBeside(editor as never, idOf(editor, 'b'), idOf(editor, 'a'), 'right');
    expect(storedWidths(editor)).toEqual([[300], [300]]);
  });

  it('leave a body written as it was saved with the widths it was saved with', async () => {
    drawEverythingAt(120);
    const editor = open([tableBlock({ rows: [{ cells: ['a', 'z'] }] })]);
    const saved = open([tableBlock({ rows: [{ cells: [{ blocks: [columnsBlock(['a'], ['b'])] }, 'z'] }] })]);
    const view = editor.prosemirrorView;
    const body = view.state.schema.nodeFromJSON(saved.prosemirrorState.doc.toJSON()).content;
    view.dispatch(view.state.tr.replaceWith(0, view.state.doc.content.size, body).setMeta(SAVED_BODY, true));
    await Promise.resolve();
    expect(storedWidths(editor)).toEqual([null, null]);
  });
});
