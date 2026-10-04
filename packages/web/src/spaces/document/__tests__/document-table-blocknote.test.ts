// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { afterEach, describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { CellSelection, TableMap, mergeCells } from '@tiptap/pm/tables';
import type { Node as PMNode } from '@tiptap/pm/model';

import { documentBodyFragment } from '@breatic/shared';

import { buildDocumentEditor } from '@web/spaces/document/build-document-editor';

type Editor = ReturnType<typeof buildDocumentEditor>;

const mounted: Editor[] = [];

afterEach(() => {
  for (const editor of mounted.splice(0)) {
    editor.unmount();
  }
  document.body.innerHTML = '';
});

/**
 * Opens a mounted editor holding one 3 × 3 table.
 * @param props - Props for the table block.
 * @returns The editor.
 */
function openTable(props: Record<string, unknown> = {}): Editor {
  const editor = buildDocumentEditor({ fragment: documentBodyFragment(new Y.Doc()) });
  const host = document.createElement('div');
  document.body.appendChild(host);
  editor.mount(host);
  mounted.push(editor);
  const rows = [0, 1, 2].map((r) => ({ cells: [0, 1, 2].map((c) => `r${r}c${c}`) }));
  editor.replaceBlocks(editor.document, [
    { type: 'table', props, content: { type: 'tableContent', rows } },
  ] as never);
  return editor;
}

/**
 * Finds the table node and where it starts.
 * @param editor - The editor.
 * @returns The node and its position.
 */
function tableIn(editor: Editor): { node: PMNode; pos: number } {
  let found: { node: PMNode; pos: number } | null = null;
  editor.prosemirrorState.doc.descendants((node, pos) => {
    if (found === null && node.type.name === 'table') {
      found = { node, pos };
    }
    return found === null;
  });
  if (found === null) {
    throw new Error('no table in the document');
  }
  return found;
}

/**
 * The table's block element.
 * @returns The element BlockNote marks as the table's content.
 */
function tableElement(): HTMLElement {
  const el = document.querySelector<HTMLElement>('[data-content-type="table"]');
  if (el === null) {
    throw new Error('no table element');
  }
  return el;
}

describe('the table block', () => {
  it('carries `quoted` on the ProseMirror node and in the block', () => {
    const editor = openTable({ quoted: true });
    expect(tableIn(editor).node.attrs['quoted']).toBe(true);
    expect((editor.document[0] as { props: Record<string, unknown> }).props['quoted']).toBe(true);
    expect(tableElement().getAttribute('data-quoted')).toBe('true');
  });

  it('repaints `quoted` when it changes after the table was drawn', () => {
    const editor = openTable();
    const before = tableElement();
    expect(before.getAttribute('data-quoted')).toBeNull();
    const { pos } = tableIn(editor);
    const view = editor.prosemirrorView;
    view.dispatch(view.state.tr.setNodeAttribute(pos, 'quoted', true));
    expect(tableElement()).toBe(before);
    expect(before.getAttribute('data-quoted')).toBe('true');
    view.dispatch(view.state.tr.setNodeAttribute(pos, 'quoted', false));
    expect(before.getAttribute('data-quoted')).toBeNull();
  });

  it('puts the table inside a horizontal scroll area', () => {
    openTable();
    const block = tableElement();
    const viewport = block.querySelector(
      ':scope > .doc-table-scroller [data-radix-scroll-area-viewport]',
    );
    expect(viewport).not.toBeNull();
    expect(viewport?.querySelector('.tableWrapper table')).not.toBeNull();
    expect(block.querySelector(':scope > .tableWrapper')).toBeNull();
  });

  it('keeps its width when every cell is merged into one (upstream #1993)', () => {
    const editor = openTable();
    const view = editor.prosemirrorView;
    const { node, pos } = tableIn(editor);
    const map = TableMap.get(node);
    const start = pos + 1;
    view.dispatch(
      view.state.tr.setSelection(
        CellSelection.create(
          view.state.doc,
          start + map.map[0]!,
          start + map.map[map.map.length - 1]!,
        ),
      ),
    );
    expect(mergeCells(view.state, view.dispatch)).toBe(true);

    const merged = tableIn(editor).node;
    const after = TableMap.get(merged);
    expect([after.width, after.height]).toEqual([3, 3]);
    expect(merged.firstChild?.childCount).toBe(1);
    expect(merged.firstChild?.firstChild?.attrs).toMatchObject({ colspan: 3, rowspan: 3 });
  });
});
