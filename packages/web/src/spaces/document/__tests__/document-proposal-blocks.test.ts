// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/** Actual root IDs and preservation properties of new proposal output. */

import { blockToNode } from '@blocknote/core';
import { act } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import fc from 'fast-check';
import * as Y from 'yjs';
import { deriveId, documentBodyFragment } from '@breatic/shared';

import { buildDocumentEditor } from '@web/spaces/document/build-document-editor';
import type { WrittenBlock } from '@web/spaces/document/document-external-media';
import { proposalBlocks, writtenBlockId } from '@web/spaces/document/document-proposal-blocks';
import { tableBlock } from '@web/spaces/document/__tests__/table-fixtures';

interface PayloadBlock extends WrittenBlock {
  readonly id: string;
  readonly content?: unknown;
  children?: PayloadBlock[];
}

interface Seed {
  readonly kind: 'paragraph' | 'heading' | 'list' | 'table' | 'code';
  readonly text: string;
  readonly bold: boolean;
  readonly italic: boolean;
  readonly level: number;
  readonly header: boolean;
}

interface Unit {
  readonly block: PayloadBlock;
  readonly unfolded: readonly PayloadBlock[];
}

const mounted: Array<{ editor: ReturnType<typeof buildDocumentEditor>; doc: Y.Doc }> = [];
const seed = fc.record({
  kind: fc.constantFrom<Seed['kind']>('paragraph', 'heading', 'list', 'table', 'code'),
  text: fc.array(fc.constantFrom('a', 'b', 'c', ' ', '0'), { maxLength: 12 }).map((letters) => letters.join('')),
  bold: fc.boolean(),
  italic: fc.boolean(),
  level: fc.integer({ min: 1, max: 3 }),
  header: fc.boolean(),
});

/**
 * Builds the real schema once for each property test without committing output.
 * @returns The mounted editor supplying the current document.
 * @throws {Error} If the editor cannot be built or mounted.
 */
function open(): ReturnType<typeof buildDocumentEditor> {
  const doc = new Y.Doc();
  let editor!: ReturnType<typeof buildDocumentEditor>;
  act(() => {
    editor = buildDocumentEditor({ fragment: documentBodyFragment(doc) });
    const host = document.createElement('div');
    document.body.append(host);
    editor.mount(host);
    editor.replaceBlocks(editor.document, [{ id: 'existing', type: 'paragraph', content: 'EXISTING' }] as never);
  });
  mounted.push({ editor, doc });
  return editor;
}

/**
 * Fixes every input ID before planning so random converter IDs cannot affect comparisons.
 * @param block - One generated input block.
 * @param prefix - The unique source ID for its tree.
 * @returns The block with fixed IDs on every descendant.
 */
function withIds(block: WrittenBlock, prefix: string): PayloadBlock {
  const { children, ...value } = block;
  return {
    ...value,
    id: prefix,
    ...(children === undefined ? {} : { children: children.map((child, index) => withIds(child, `${prefix}-${String(index)}`)) }),
  };
}

/**
 * Builds a generated rich block, with the exact roots a cell should retain.
 * @param value - The generated semantic values.
 * @param index - The input's index, providing a unique ID prefix.
 * @returns The input and its expected roots in a cell.
 */
function materialize(value: Seed, index: number): Unit {
  const id = `source-${String(index)}`;
  const content = value.text === '' ? [] : [{ type: 'text', text: value.text, styles: { bold: value.bold, italic: value.italic } }];
  const paragraph = { id: `${id}-paragraph`, type: 'paragraph', content };
  const heading = { id: `${id}-heading`, type: 'heading', props: { level: value.level }, content };
  const code = { id: `${id}-code`, type: 'codeBlock', props: { language: 'javascript' }, content: value.text };
  const list = { id: `${id}-list`, type: 'bulletListItem', content, children: [paragraph] };
  if (value.kind === 'table') {
    const block = withIds(tableBlock({
      rows: [{ cells: [{ blocks: [heading] }, { blocks: [list, code] }] }],
      headerRows: value.header ? 1 : 0,
      columnWidths: [120, 180],
    }) as WrittenBlock, id);
    const cells = block.children![0]!.children!;
    return { block, unfolded: [...cells[0]!.children!, ...cells[1]!.children!] };
  }
  const block = value.kind === 'heading' ? heading : value.kind === 'list' ? list : value.kind === 'code' ? code : paragraph;
  return { block, unfolded: [block] };
}

afterEach(() => {
  act(() => mounted.splice(0).forEach(({ editor, doc }) => {
    editor.unmount();
    doc.destroy();
  }));
  document.body.innerHTML = '';
});

describe('proposal output planning', () => {
  it('assigns the existing proposal trace format to actual root indexes', () => {
    expect([0, 1, 2].map((index) => writtenBlockId('proposal', index))).toEqual([
      deriveId('document-proposal:proposal:0'),
      deriveId('document-proposal:proposal:1'),
      deriveId('document-proposal:proposal:2'),
    ]);
  });

  it.each([false, true])('preserves order, attributes and descendant IDs with inCell=%s', (inCell) => {
    const editor = open();
    const doc = editor.prosemirrorState.doc;
    const beforeDocument = doc.toJSON();
    fc.assert(fc.property(fc.array(seed, { maxLength: 8 }), (seeds) => {
      const units = seeds.map(materialize);
      const input = units.map((unit) => unit.block);
      const beforeInput = structuredClone(input);
      const expected = inCell ? units.flatMap((unit) => unit.unfolded) : input;

      const output = proposalBlocks(input, doc, inCell, 'property-proposal');

      expect(output.map((block) => block.id)).toEqual(expected.map((_, index) => deriveId(`document-proposal:property-proposal:${String(index)}`)));
      const actualNodes = output.map((block) => blockToNode(block as never, doc.type.schema).toJSON());
      const expectedNodes = expected.map((block, index) => blockToNode({
        ...block,
        id: deriveId(`document-proposal:property-proposal:${String(index)}`),
      } as never, doc.type.schema).toJSON());
      expect(actualNodes).toEqual(expectedNodes);
      if (inCell) {
        output.forEach((block) => {
          const node = blockToNode(block as never, doc.type.schema);
          const tables: string[] = [];
          if (node.type.name === 'docTable') tables.push(node.type.name);
          node.descendants((child) => {
            if (child.type.name === 'docTable') tables.push(child.type.name);
            return true;
          });
          expect(tables).toEqual([]);
        });
      }
      expect(input).toEqual(beforeInput);
      expect(doc.toJSON()).toEqual(beforeDocument);
      expect(proposalBlocks(input, doc, inCell, 'property-proposal')).toEqual(output);
      expect(proposalBlocks(output, doc, inCell, 'property-proposal')).toEqual(output);
    }));
  });
});
