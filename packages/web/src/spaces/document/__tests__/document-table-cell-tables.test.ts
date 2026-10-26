// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * inner#1619 R6: a cell never contains a table at any depth. A block API
 * insertion or a peer's older client can put one below a list item, where
 * the schema's direct-child exclusion does not reach. Its cells become
 * blocks in reading order, keeping their identities, marks and structure.
 */

import { afterEach, describe, expect, it } from 'vitest';
import fc from 'fast-check';
import * as Y from 'yjs';
import type { Node as PMNode } from '@tiptap/pm/model';
import { prosemirrorToYXmlFragment } from 'y-prosemirror';

import { documentBodyFragment } from '@breatic/shared/document-body';

import { buildDocumentEditor } from '@web/spaces/document/build-document-editor';
import { rowById } from '@web/spaces/document/document-row-by-id';
import { tableBlock } from '@web/spaces/document/__tests__/table-fixtures';

type Editor = ReturnType<typeof buildDocumentEditor>;
type CellType = 'docTableCell' | 'docTableHeader';

const mounted: Editor[] = [];

afterEach(() => {
  for (const editor of mounted.splice(0)) editor.unmount();
  document.body.innerHTML = '';
});

/**
 * Mounts a real collaborative editor on the supplied document.
 * @param doc - The Yjs document.
 * @returns The editor.
 */
function open(doc: Y.Doc = new Y.Doc()): Editor {
  const editor = buildDocumentEditor({ fragment: documentBodyFragment(doc) });
  const host = document.createElement('div');
  document.body.appendChild(host);
  editor.mount(host);
  mounted.push(editor);
  return editor;
}

/** The cells' blocks in row-major reading order, retaining their children. */
const SOURCE_BLOCK_IDS = ['incoming-heading', 'incoming-list', 'incoming-code', 'incoming-image', 'incoming-tail'];

/** A multi-row table whose cell blocks have visible structure and marks. */
const SOURCE = {
  ...tableBlock({
    rows: [
      { cells: [
        { blocks: [
          {
            id: 'incoming-heading',
            type: 'heading',
            props: { level: 2 },
            content: [{ type: 'text', text: 'Heading', styles: { bold: true, italic: true } }],
          },
          {
            id: 'incoming-list',
            type: 'bulletListItem',
            content: 'List',
            children: [{ id: 'incoming-todo', type: 'checkListItem', props: { checked: true }, content: 'Nested todo' }],
          },
        ] },
        { blocks: [{ id: 'incoming-code', type: 'codeBlock', props: { language: 'ts' }, content: 'const answer = 42;' }] },
      ] },
      { cells: [
        { blocks: [{ id: 'incoming-image', type: 'image', props: { url: 'https://example.com/a.png', caption: 'An image' } }] },
        { blocks: [{ id: 'incoming-tail', type: 'paragraph', content: [{ type: 'text', text: 'Tail', styles: { underline: true } }] }] },
      ] },
    ],
  }),
  id: 'incoming-table',
};

/** A second table catches repairs that stop after their first replacement. */
const SECOND_SOURCE = {
  ...tableBlock({ rows: [{ cells: [{ blocks: [{ id: 'second-cell-text', type: 'paragraph', content: 'Second table' }] }] }] }),
  id: 'second-table',
};

/**
 * A host cell with a list chain and two ordinary siblings at its deepest level.
 * @param depth - The number of list items enclosing the insertion point.
 * @param cellType - The host cell's kind.
 * @returns The host table block.
 */
function hostTable(depth: number, cellType: CellType): Record<string, unknown> {
  let blocks: unknown[] = [
    { id: 'before-insertion', type: 'paragraph', content: 'Before' },
    { id: 'after-insertion', type: 'paragraph', content: 'After' },
  ];
  for (let level = depth - 1; level >= 0; level -= 1) {
    blocks = [{ id: `cell-list-${level}`, type: 'bulletListItem', content: `Level ${level}`, children: blocks }];
  }
  return {
    ...tableBlock({ rows: [{ cells: [{ type: cellType, props: { backgroundColor: 'blue' }, blocks }, 'Untouched cell'] }] }),
    id: 'host-table',
  };
}

/**
 * The immediate children of a list item, read through the common id resolver.
 * @param editor - The editor.
 * @param id - The list item.
 * @returns Its children's ids in reading order.
 * @throws {Error} If the fixture's list item no longer exists.
 */
function childIds(editor: Editor, id: string): string[] {
  const parent = rowById(editor.prosemirrorState.doc, id);
  if (parent === undefined) throw new Error(`missing ${id}`);
  const ids: string[] = [];
  parent.node.lastChild!.forEach((node) => ids.push(String(node.attrs['id'])));
  return ids;
}

/**
 * Asserts the cell invariant independently of the repair's traversal.
 * @param doc - The document to inspect.
 */
function expectNoCellTables(doc: PMNode): void {
  const nested: string[] = [];
  doc.descendants((node) => {
    if (node.type.name !== 'docTableCell' && node.type.name !== 'docTableHeader') return true;
    node.descendants((descendant) => {
      if (descendant.type.name === 'docTable') nested.push(String(descendant.attrs['id']));
      return true;
    });
    return false;
  });
  expect(nested).toEqual([]);
  expect(() => doc.check()).not.toThrow();
}

/**
 * Snapshots the cell blocks while their table is still valid in the body.
 * @param editor - The editor holding the source tables.
 * @returns Each block's entire node JSON, including marks, props and children.
 */
function sourceBlocks(editor: Editor): unknown[] {
  return [...SOURCE_BLOCK_IDS, 'second-cell-text'].map((id) => rowById(editor.prosemirrorState.doc, id)!.node.toJSON());
}

/**
 * Checks reading order, full block preservation and the unaffected host cell.
 * @param editor - The editor after the nested tables were introduced.
 * @param depth - The host list depth.
 * @param expected - The original source blocks.
 * @param untouched - The adjacent cell before the insertion.
 */
function expectRepaired(editor: Editor, depth: number, expected: unknown[], untouched: unknown): void {
  expectNoCellTables(editor.prosemirrorState.doc);
  expect(childIds(editor, `cell-list-${depth - 1}`)).toEqual([
    'before-insertion', ...SOURCE_BLOCK_IDS, 'second-cell-text', 'after-insertion',
  ]);
  expect(sourceBlocks(editor)).toEqual(expected);
  const host = rowById(editor.prosemirrorState.doc, 'host-table')!.node;
  expect(host.child(0).child(1).toJSON()).toEqual(untouched);
  expect(host.child(0).child(0).attrs['backgroundColor']).toBe('blue');
  expect(rowById(editor.prosemirrorState.doc, 'incoming-table')).toBeUndefined();
  expect(rowById(editor.prosemirrorState.doc, 'second-table')).toBeUndefined();
}

describe('tables introduced below a cell block', () => {
  it.each(['docTableCell', 'docTableHeader'] as const)('keeps cell blocks, marks and ids when block insertion introduces tables under a list in a %s', (cellType) => {
    const editor = open();
    editor.replaceBlocks(editor.document, [hostTable(2, cellType), SOURCE, SECOND_SOURCE] as never);
    const expected = sourceBlocks(editor);
    const untouched = rowById(editor.prosemirrorState.doc, 'host-table')!.node.child(0).child(1).toJSON();
    editor.removeBlocks(['incoming-table', 'second-table']);

    editor.insertBlocks([SOURCE, SECOND_SOURCE] as never, 'before-insertion', 'after');

    expectRepaired(editor, 2, expected, untouched);
  });

  it('enforces the same cell invariant at arbitrary list depths', () => {
    fc.assert(fc.property(
      fc.integer({ min: 1, max: 8 }),
      fc.constantFrom<CellType>('docTableCell', 'docTableHeader'),
      fc.array(fc.constantFrom('a', 'b', 'c', ' '), { minLength: 1, maxLength: 12 }).map((letters) => letters.join('')),
      (depth, cellType, words) => {
        const editor = open();
        editor.replaceBlocks(editor.document, [
          hostTable(depth, cellType), SOURCE, SECOND_SOURCE,
          { ...tableBlock({ rows: [{ cells: ['Legal body table'] }] }), id: 'legal-body-table' },
          {
            id: 'legal-body-list', type: 'bulletListItem', content: 'Body list',
            children: [{ ...tableBlock({ rows: [{ cells: ['Legal list table'] }] }), id: 'legal-list-table' }],
          },
        ] as never);
        editor.updateBlock('incoming-heading', {
          content: [{ type: 'text', text: words, styles: { bold: true, italic: true } }],
        } as never);
        const source = editor.document.find((block) => (block as { id: string }).id === 'incoming-table');
        const expected = sourceBlocks(editor);
        const untouched = rowById(editor.prosemirrorState.doc, 'host-table')!.node.child(0).child(1).toJSON();
        const legalTables = ['legal-body-table', 'legal-list-table'].map((id) => rowById(editor.prosemirrorState.doc, id)!.node.toJSON());
        editor.removeBlocks(['incoming-table', 'second-table']);

        editor.insertBlocks([source, SECOND_SOURCE] as never, 'before-insertion', 'after');

        expectRepaired(editor, depth, expected, untouched);
        expect(['legal-body-table', 'legal-list-table'].map((id) => rowById(editor.prosemirrorState.doc, id)!.node.toJSON())).toEqual(legalTables);
        expect(childIds(editor, 'legal-body-list')).toEqual(['legal-list-table']);
      },
    ), { numRuns: 12, seed: 1619 });
  });

  it('repairs a peer update and converges with every cell block intact', () => {
    const oursDoc = new Y.Doc();
    const ours = open(oursDoc);
    ours.replaceBlocks(ours.document, [hostTable(3, 'docTableHeader'), SOURCE, SECOND_SOURCE] as never);
    const expected = sourceBlocks(ours);
    const untouched = rowById(ours.prosemirrorState.doc, 'host-table')!.node.child(0).child(1).toJSON();
    const peerDoc = new Y.Doc();
    Y.applyUpdate(peerDoc, Y.encodeStateAsUpdate(oursDoc));
    const peer = open(peerDoc);
    const tr = peer.prosemirrorState.tr;
    const source = rowById(tr.doc, 'incoming-table')!;
    const second = rowById(tr.doc, 'second-table')!;
    const target = rowById(tr.doc, 'after-insertion')!;
    tr.delete(second.from, second.to);
    tr.delete(source.from, source.to);
    tr.insert(tr.mapping.map(target.from), [source.node, second.node]);

    // An older client writes a schema-valid nested table without this build's
    // editor extensions. The receiving editors must repair the real Yjs update.
    prosemirrorToYXmlFragment(tr.doc, documentBodyFragment(peerDoc));
    for (let round = 0; round < 5; round += 1) {
      Y.applyUpdate(oursDoc, Y.encodeStateAsUpdate(peerDoc, Y.encodeStateVector(oursDoc)), 'peer');
      Y.applyUpdate(peerDoc, Y.encodeStateAsUpdate(oursDoc, Y.encodeStateVector(peerDoc)), 'peer');
    }

    expectRepaired(ours, 3, expected, untouched);
    expectRepaired(peer, 3, expected, untouched);
    expect(peer.prosemirrorState.doc.toJSON()).toEqual(ours.prosemirrorState.doc.toJSON());
    // A converged update still carries the delete set; snapshots compare both
    // that set and the clocks, independently of the update's encoded size.
    expect(Y.equalSnapshots(Y.snapshot(peerDoc), Y.snapshot(oursDoc))).toBe(true);
  });

  it('keeps legitimate tables in the body and below a body list unchanged', () => {
    const editor = open();
    editor.replaceBlocks(editor.document, [
      { id: 'lead', type: 'paragraph', content: 'Lead' },
      SOURCE,
      { id: 'body-list', type: 'bulletListItem', content: 'Body list', children: [SECOND_SOURCE] },
    ] as never);
    const expected = sourceBlocks(editor);
    const tables = ['incoming-table', 'second-table'].map((id) => rowById(editor.prosemirrorState.doc, id)!.node.toJSON());

    editor.updateBlock('lead', { content: 'Edited lead' } as never);

    expectNoCellTables(editor.prosemirrorState.doc);
    expect(sourceBlocks(editor)).toEqual(expected);
    expect(['incoming-table', 'second-table'].map((id) => rowById(editor.prosemirrorState.doc, id)!.node.toJSON())).toEqual(tables);
    expect(childIds(editor, 'body-list')).toEqual(['second-table']);
  });
});
