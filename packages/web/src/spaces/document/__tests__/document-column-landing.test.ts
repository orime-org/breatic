// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * inner#1314 design §5.2: where a side drop is, and when there is none.
 *
 * The side is read from what the user sees of the target: within 24px of its
 * visible left edge or further left is its left, within 24px of its visible
 * right edge or further right is its right, and 24px is at most a quarter of
 * the visible width. A side drop is refused when the dragged row would land
 * on itself or leave the layout as it is, when the group is full, when a new
 * column in the body would be under 96px, when a table would go into a cell,
 * when a table holding columns would go into a column, when the target is a
 * nested child, and when the target's cell stands in a column.
 */

import { afterEach, describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import type { Node as PMNode } from '@tiptap/pm/model';

import { documentBodyFragment } from '@breatic/shared';

import { buildDocumentEditor } from '@web/spaces/document/build-document-editor';
import { weightsFit } from '@web/spaces/document/document-column-geometry';
import { columnDropHook, sideDropAllowed, sideOfPointer, takeSideDrop } from '@web/spaces/document/document-column-landing';
import { rowIsFlying } from '@web/spaces/document/document-drag-drop';
import { columnsBlock, para } from '@web/spaces/document/__tests__/column-fixtures';
import { tableBlock } from '@web/spaces/document/__tests__/table-fixtures';

type Editor = ReturnType<typeof buildDocumentEditor>;

const mounted: Editor[] = [];

afterEach(() => {
  for (const editor of mounted.splice(0)) {
    editor.unmount();
  }
  document.body.innerHTML = '';
});

/**
 * An editor holding the given blocks.
 * @param blocks - The top-level blocks.
 * @returns The editor.
 */
function editorWith(blocks: readonly unknown[]): Editor {
  const editor = buildDocumentEditor({ fragment: documentBodyFragment(new Y.Doc()) });
  const host = document.createElement('div');
  document.body.appendChild(host);
  editor.mount(host);
  mounted.push(editor);
  editor.replaceBlocks(editor.document, blocks as never);
  return editor;
}

/**
 * The id of the first row whose words are these, or of the n-th table.
 * @param editor - The editor.
 * @param words - The words, or 'table:n'.
 * @returns The id.
 */
function idOf(editor: Editor, words: string): string {
  let found: string | undefined;
  let tables = 0;
  editor.prosemirrorState.doc.descendants((node: PMNode) => {
    if (found !== undefined) return false;
    if (node.type.name === 'docTable' && words === `table:${tables++}`) {
      found = String(node.attrs.id);
      return false;
    }
    if (node.type.name === 'blockContainer' && node.firstChild?.textContent === words) {
      found = String(node.attrs.id);
      return false;
    }
    return true;
  });
  if (found === undefined) throw new Error(`no row "${words}"`);
  return found;
}

describe('the side of a target the pointer is on (design §5.2)', () => {
  const box = { left: 100, right: 580 };

  it('is the left within 24px of the visible left edge, back to the edge of the container', () => {
    expect(sideOfPointer(100 + 23, box, 100)).toBe('left');
    expect(sideOfPointer(100, box, 100)).toBe('left');
  });

  it('is the left across the room between a narrow target and its container', () => {
    expect(sideOfPointer(40, box, 20)).toBe('left');
    expect(sideOfPointer(20, box, 20)).toBe('left');
  });

  it('is no side left of the container, where the handle sits', () => {
    expect(sideOfPointer(99, box, 100)).toBeNull();
    expect(sideOfPointer(40, box, 100)).toBeNull();
  });

  it('is the right within 24px of the visible right edge and anywhere further right', () => {
    expect(sideOfPointer(580 - 23, box, 100)).toBe('right');
    expect(sideOfPointer(580 + 200, box, 100)).toBe('right');
  });

  it('is no side in between', () => {
    expect(sideOfPointer(100 + 25, box, 100)).toBeNull();
    expect(sideOfPointer(340, box, 100)).toBeNull();
  });

  it('narrows the zone to a quarter of a narrow target', () => {
    const narrow = { left: 0, right: 40 };
    expect(sideOfPointer(9, narrow, 0)).toBe('left');
    expect(sideOfPointer(11, narrow, 0)).toBeNull();
    expect(sideOfPointer(31, narrow, 0)).toBe('right');
  });
});

describe('when a side drop is refused (design §5.2)', () => {
  const room = { bodyWidth: 768 };

  it('allows two plain body rows to become two columns', () => {
    const editor = editorWith([para('a'), para('b')]);
    expect(sideDropAllowed(editor.prosemirrorState.doc, idOf(editor, 'b'), idOf(editor, 'a'), 'right', room)).toBe(true);
  });

  it('refuses the dragged row itself', () => {
    const editor = editorWith([para('a'), para('b')]);
    expect(sideDropAllowed(editor.prosemirrorState.doc, idOf(editor, 'a'), idOf(editor, 'a'), 'right', room)).toBe(false);
  });

  it('refuses a drop that leaves the layout as it is', () => {
    const editor = editorWith([columnsBlock(['a'], ['b'])]);
    expect(sideDropAllowed(editor.prosemirrorState.doc, idOf(editor, 'a'), idOf(editor, 'b'), 'left', room)).toBe(false);
  });

  it('refuses a fifth column', () => {
    const editor = editorWith([columnsBlock(['a'], ['b'], ['c'], ['d']), para('e')]);
    expect(sideDropAllowed(editor.prosemirrorState.doc, idOf(editor, 'e'), idOf(editor, 'd'), 'right', room)).toBe(false);
  });

  it('allows moving a lone block within a full group', () => {
    const editor = editorWith([columnsBlock(['a'], ['b'], ['c'], ['d'])]);
    expect(sideDropAllowed(editor.prosemirrorState.doc, idOf(editor, 'a'), idOf(editor, 'd'), 'right', room)).toBe(true);
  });

  it('refuses a new body column under 96px', () => {
    const editor = editorWith([columnsBlock(['a'], ['b'], ['c']), para('d')]);
    expect(sideDropAllowed(editor.prosemirrorState.doc, idOf(editor, 'd'), idOf(editor, 'c'), 'right', { bodyWidth: 500 })).toBe(false);
  });

  it('refuses a new body column that the stored widths would squeeze under 96px', () => {
    const editor = editorWith([columnsBlock({ blocks: [para('a')], width: 5 }, { blocks: [para('b')], width: 1 }), para('d')]);
    // Widths 5, 1 and the new column's mean 3 share 768 - 2 * 72: the thin one gets 69px.
    expect(sideDropAllowed(editor.prosemirrorState.doc, idOf(editor, 'd'), idOf(editor, 'b'), 'right', { bodyWidth: 768 })).toBe(false);
  });

  it('allows the same new column when the stored widths leave every column 96px or more', () => {
    const editor = editorWith([columnsBlock({ blocks: [para('a')], width: 2 }, { blocks: [para('b')], width: 1 }), para('d')]);
    expect(sideDropAllowed(editor.prosemirrorState.doc, idOf(editor, 'd'), idOf(editor, 'b'), 'right', { bodyWidth: 768 })).toBe(true);
  });

  it('allows a new column in a cell however narrow, since the table column widens', () => {
    const editor = editorWith([tableBlock({ rows: [{ cells: [{ blocks: [para('a'), para('b')] }, 'z'] }] })]);
    expect(sideDropAllowed(editor.prosemirrorState.doc, idOf(editor, 'b'), idOf(editor, 'a'), 'right', { bodyWidth: 100 })).toBe(true);
  });

  it('refuses a table going into a cell', () => {
    const editor = editorWith([
      tableBlock({ rows: [{ cells: ['a', 'z'] }] }),
      tableBlock({ rows: [{ cells: ['t'] }] }),
    ]);
    expect(sideDropAllowed(editor.prosemirrorState.doc, idOf(editor, 'table:1'), idOf(editor, 'a'), 'right', room)).toBe(false);
  });

  it('refuses a row holding a nested table going into a cell', () => {
    const editor = editorWith([
      tableBlock({ rows: [{ cells: ['a', 'z'] }] }),
      { type: 'bulletListItem', content: 'item', children: [tableBlock({ rows: [{ cells: ['t'] }] })] },
    ]);
    expect(sideDropAllowed(editor.prosemirrorState.doc, idOf(editor, 'item'), idOf(editor, 'a'), 'right', room)).toBe(false);
  });

  it('refuses a table holding columns going into a column, as dragged or as target', () => {
    const editor = editorWith([
      tableBlock({ rows: [{ cells: [{ blocks: [columnsBlock(['x'], ['y'])] }] }] }),
      para('p'),
    ]);
    const doc = editor.prosemirrorState.doc;
    expect(sideDropAllowed(doc, idOf(editor, 'table:0'), idOf(editor, 'p'), 'right', room)).toBe(false);
    expect(sideDropAllowed(doc, idOf(editor, 'p'), idOf(editor, 'table:0'), 'right', room)).toBe(false);
  });

  it('refuses a nested child as the target', () => {
    const editor = editorWith([
      { type: 'bulletListItem', content: 'parent', children: [{ type: 'bulletListItem', content: 'child' }] },
      para('p'),
    ]);
    expect(sideDropAllowed(editor.prosemirrorState.doc, idOf(editor, 'p'), idOf(editor, 'child'), 'right', room)).toBe(false);
  });

  it('refuses a target in a cell of a table that stands in a column', () => {
    const editor = editorWith([
      columnsBlock({ blocks: [para('left')] }, { blocks: [tableBlock({ rows: [{ cells: ['c1', 'c2'] }] })] }),
      para('p'),
    ]);
    expect(sideDropAllowed(editor.prosemirrorState.doc, idOf(editor, 'p'), idOf(editor, 'c1'), 'right', room)).toBe(false);
  });

  it('allows a table in the body to go beside a body row, into a column', () => {
    const editor = editorWith([tableBlock({ rows: [{ cells: ['t'] }] }), para('p')]);
    expect(sideDropAllowed(editor.prosemirrorState.doc, idOf(editor, 'table:0'), idOf(editor, 'p'), 'right', room)).toBe(true);
  });
});

describe('whether a container holds its columns side by side (design §5.1)', () => {
  it('needs 96px a column and 72px a gap', () => {
    expect(weightsFit(264, [1, 1])).toBe(true);
    expect(weightsFit(263, [1, 1])).toBe(false);
    expect(weightsFit(600, [1, 1, 1, 1])).toBe(true);
    expect(weightsFit(599, [1, 1, 1, 1])).toBe(false);
  });

  it('needs 96px for the thinnest column at its weight', () => {
    // 72px of gap, then the thin column's sixth of the rest: (552 - 72) / 6 = 80.
    expect(weightsFit(552, [5, 1])).toBe(false);
    expect(weightsFit(648, [5, 1])).toBe(true);
  });
});

describe('the side drop a line showed (design §5.2)', () => {
  it('is forgotten when the next row drag starts', () => {
    const editor = editorWith([para('a'), para('b')]);
    const view = editor.prosemirrorView;
    let inA = -1;
    view.state.doc.descendants((node: PMNode, pos: number) => {
      if (inA < 0 && node.isTextblock && node.textContent === 'a') inA = pos + 1;
      return inA < 0;
    });
    // The pointer at a's left edge, in a body wide enough for two columns.
    view.posAtCoords = () => ({ pos: inA, inside: -1 });
    Object.defineProperty(view.dom, 'clientWidth', { configurable: true, value: 768 });
    const dragged = idOf(editor, 'b');
    const hook = columnDropHook(() => null as never, () => dragged);
    const orientation = hook({ view, event: new MouseEvent('dragover', { clientX: 0, clientY: 0 }) } as never);
    expect(orientation).toMatchObject({ orientation: 'block-vertical-left' });
    // That drag ends with no drop (Escape); the next one starts.
    rowIsFlying(dragged, undefined);
    expect(takeSideDrop(dragged)).toBeUndefined();
  });
});
