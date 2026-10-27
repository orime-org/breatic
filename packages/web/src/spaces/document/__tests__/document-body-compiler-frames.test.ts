// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { EditorState } from '@tiptap/pm/state';
import { afterEach, describe, expect, it } from 'vitest';
import type { BodyRecord } from '@breatic/shared';

import { projectBodyTree } from '@web/spaces/document/document-body-codec';
import { compilerFrames } from '@web/spaces/document/document-body-compiler-frames';
import { replayBodyJournal } from '@web/spaces/document/document-body-journal';
import { cleanupCodecFixtures, codecFixture, codecSchema } from '@web/spaces/document/__tests__/document-body-codec-fixtures';

afterEach(cleanupCodecFixtures);

describe('structural identities at complete compiler boundaries', () => {
  for (const axis of ['row', 'cell'] as const) {
    for (const slot of [0, 1, 2]) {
      for (const explicit of [false, true]) {
        it(`allocates a fresh ${axis} before sibling slot ${slot}, explicit ${explicit}`, () => {
          const schema = codecSchema();
          const containers: BodyRecord[] = [
            { id: 'table', kind: 'container', type: 'docTable', attrs: { id: 'table' }, parent: 'group', order: 'A' },
            ...[0, 1].map((row): BodyRecord => ({ id: `row:${row}`, kind: 'container', type: 'docTableRow', attrs: { id: `row:${row}` }, parent: 'table', order: String(row) })),
            ...['A', 'B', 'C', 'D'].map((id, index): BodyRecord => ({
              id: `cell:${id}`, kind: 'container', type: 'docTableCell',
              attrs: { id: `cell:${id}`, colspan: 1, rowspan: 1, colwidth: null },
              parent: `row:${Math.floor(index / 2)}`, order: String(index % 2),
            })),
          ];
          const doc = codecFixture(['A', 'B', 'C', 'D'].map((id) => ({ id, text: id, parent: `cell:${id}` })), containers);
          const read = projectBodyTree(doc, schema, { document: 'frame-identities', epoch: 1 });
          if (read.status !== 'ready') throw new Error('Expected complete frame fixture');
          const projection = read.projection;
          const state = EditorState.create({ doc: projection.doc });
          const cell = schema.node('docTableCell', { id: explicit ? 'fresh:cell' : null },
            schema.node('blockContainer', { id: explicit ? 'fresh:owner' : null }, schema.node('paragraph')),
          );
          const inserted = axis === 'cell' ? cell : schema.node('docTableRow', { id: explicit ? 'fresh:row' : null }, cell);
          const parent = projection.index.nodes.get(axis === 'row' ? 'table' : 'row:0');
          if (parent === undefined) throw new Error('Expected insertion parent');
          const parentNode = projection.doc.nodeAt(parent.from);
          if (parentNode === null) throw new Error('Expected native insertion node');
          let at = parent.from + 1;
          for (let index = 0; index < slot; index += 1) at += parentNode.child(index).nodeSize;
          const root = state.tr.insert(at, inserted);
          const afterRoot = state.apply(root);
          const append = afterRoot.tr;
          append.doc.descendants((node, pos) => {
            if (Object.hasOwn(node.attrs, 'id') && node.attrs['id'] === null) {
              const name = node.type.name === 'docTableRow' ? 'row' : node.type.name === 'docTableCell' ? 'cell' : 'owner';
              append.setNodeMarkup(pos, undefined, { ...node.attrs, id: `fresh:${name}` });
            }
          });
          const transactions = explicit ? [root] : [root, append];
          const journal = replayBodyJournal(projection.doc, projection.units, transactions, { batchId: 'new-frame' });
          const frames = compilerFrames({ doc, projection, journal, batchId: 'new-frame' });
          const final = frames.at(-1)!;
          expect(final.document.toJSON()).toEqual((explicit ? root.doc : append.doc).toJSON());
          expect(final.nodes.size).toBe(frames[0].nodes.size + (axis === 'row' ? 3 : 2));
          expect(final.children.get(axis === 'row' ? 'table' : 'row:0')).toEqual([
            ...(axis === 'row' ? ['row:0', 'row:1'] : ['cell:A', 'cell:B']).slice(0, slot),
            `fresh:${axis}`,
            ...(axis === 'row' ? ['row:0', 'row:1'] : ['cell:A', 'cell:B']).slice(slot),
          ]);
          for (const [id, original] of frames[0].nodes) {
            expect(final.nodes.get(id)).toMatchObject({ id, type: original.type, attrs: original.attrs, wrapperAttrs: original.wrapperAttrs, parent: original.parent });
          }
          expect(final.nodes.get('fresh:cell')).toMatchObject({ id: 'fresh:cell', attrs: { id: 'fresh:cell' } });
          expect(final.nodes.get('fresh:owner')).toMatchObject({ id: 'fresh:owner', wrapperAttrs: { id: 'fresh:owner' } });
          expect([...final.nodes.keys()].some((id) => id.includes(':unnamed:'))).toBe(false);
        });
      }
    }
  }
});
