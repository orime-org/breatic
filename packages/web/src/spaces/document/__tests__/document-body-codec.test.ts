// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { afterEach, describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import fc from 'fast-check';
import type { Schema } from '@tiptap/pm/model';
import { TableMap } from '@tiptap/pm/tables';

import { documentBodyRecords, documentBodySource, registerBodyCut, registerDocumentBodyRecords, type BodyJsonObject } from '@breatic/shared';

import { projectBodyTree } from '@web/spaces/document/document-body-codec';
import type { BodyProjection } from '@web/spaces/document/document-body-codec-types';
import { bodyInlineOccurrences } from '@web/spaces/document/document-body-provenance';
import { cleanupCodecFixtures, codecDoc, codecFacts, codecFixture, codecNativeTokens, codecParagraph, codecSchema, codecTableFixture } from '@web/spaces/document/__tests__/document-body-codec-fixtures';

afterEach(cleanupCodecFixtures);

/**
 * Requires a complete real projection without deriving the expected document from it.
 * @param doc - The document being inspected.
 * @param schema - The actual installed editor schema.
 * @param epoch - The final projection epoch.
 * @returns The complete production projection.
 * @throws {Error} If projection is incomplete.
 */
function project(doc: Y.Doc, schema: Schema, epoch = 7): BodyProjection {
  const result = projectBodyTree(doc, schema, { document: 'document-one', epoch });
  expect(result.status).toBe('ready');
  if (result.status !== 'ready') throw new Error('Expected complete body projection');
  return result.projection;
}

describe('read-only body codec over the actual BlockNote schema', () => {
  it('projects complete legal JSON and indexes each original native occurrence exactly once', () => {
    const schema = codecSchema();
    const doc = codecFixture([{ id: 'A', text: 'A😀e\u0301' }, { id: 'B', text: 'AA', type: 'heading', attrs: { level: 2 } }]);
    const before = Y.encodeStateAsUpdate(doc);
    const aTokens = codecNativeTokens(doc, 'A', 5);
    const bTokens = codecNativeTokens(doc, 'B', 2);
    const result = project(doc, schema);
    const expected = schema.node('doc', null, schema.node('blockGroup', null, [codecParagraph(schema, 'A', 'A😀e\u0301'), codecParagraph(schema, 'B', 'AA', 'heading', { level: 2 })]));

    expect(result.doc.toJSON()).toEqual(expected.toJSON());
    expect(() => result.doc.check()).not.toThrow();
    expect(result.units).toEqual(bodyInlineOccurrences(expected).map((unit, index) => ({ ...unit, token: [...aTokens, ...bTokens][index], origin: 'existing' })));
    expect(result.index.units.map((unit) => [unit.token, unit.source, unit.index, unit.owner])).toEqual([...aTokens.map((token, index) => [token, 'S:A', index + 1, 'A']), ...bTokens.map((token, index) => [token, 'S:B', index + 1, 'B'])]);
    expect(new Set(result.units.map((unit) => unit.token)).size).toBe(7);
    expect(result.index.epoch).toBe(7);
    expect(result.index.sourceDoc).toBe(doc);
    expect(result.index.document).toBe('document-one');
    expect(result.synthetic).toBe(false);
    expect(Y.encodeStateAsUpdate(doc)).toEqual(before);
  });

  it('keeps permanent cuts zero-width and decodes the product-owned inline leaf', () => {
    const schema = codecSchema();
    const doc = codecFixture([{ id: 'A', text: 'AB' }]);
    const source = documentBodySource(doc, 'S:A');
    const original = codecNativeTokens(doc, 'A', 2);
    registerBodyCut(doc, 'S:A', 'middle', 2);
    source.insertEmbed(3, { bodyInline: { type: 'hardBreak', attrs: {} } }, { ctx: 'base' });
    const inlineToken = codecNativeTokens(doc, 'A', 1, 3)[0];
    const before = Y.encodeStateAsUpdate(doc);
    const result = project(doc, schema);
    const paragraph = schema.node('paragraph', null, [schema.text('A'), schema.node('hardBreak'), schema.text('B')]);
    const expected = schema.node('doc', null, schema.node('blockGroup', null, schema.node('blockContainer', { id: 'A' }, paragraph)));

    expect(result.doc.toJSON()).toEqual(expected.toJSON());
    expect(result.units.map((unit) => [unit.token, unit.pos, unit.value])).toEqual([[original[0], 3, 'A'], [inlineToken, 4, '<hardBreak>'], [original[1], 5, 'B']]);
    expect(result.index.units.map((unit) => unit.index)).toEqual([1, 3, 4]);
    expect(Y.encodeStateAsUpdate(doc)).toEqual(before);
  });

  it('projects known and unknown marks while preserving their exact native payload', () => {
    const schema = codecSchema();
    const doc = codecFixture([{ id: 'A', text: 'AB' }]);
    const payload = { mode: 'future', nested: { values: [1, 'x', null] } };
    registerDocumentBodyRecords(doc, { facts: [
      { id: 'bold-mark', kind: 'mark', group: 'marks', dependencies: [], payload: { type: 'bold', attrs: {} } },
      { id: 'future-mark', kind: 'mark', group: 'marks', dependencies: [], payload: { type: 'futurePaint', attrs: payload } },
    ], groups: [{ id: 'marks', facts: ['bold-mark', 'future-mark'], history: 'base' }] });
    documentBodySource(doc, 'S:A').format(1, 1, { 'mark:bold-mark': { factId: 'bold-mark' }, 'mark:future-mark': { factId: 'future-mark' } });
    const before = Y.encodeStateAsUpdate(doc);
    const result = project(doc, schema);
    const marks = result.doc.nodeAt(3)!.marks.map((mark) => mark.toJSON());

    expect(marks).toContainEqual({ type: 'bold' });
    expect(marks).toContainEqual({ type: 'unsupportedMark', attrs: { originalName: 'futurePaint', originalValue: payload } });
    expect(result.doc.nodeAt(4)!.marks).toEqual([]);
    expect(result.index.units[0].native.attributes).toMatchObject({ ctx: 'base', 'mark:bold-mark': { factId: 'bold-mark' }, 'mark:future-mark': { factId: 'future-mark' } });
    expect(Y.encodeStateAsUpdate(doc)).toEqual(before);
  });

  it('uses the actual plain-content allowedMarks without stripping native formatting', () => {
    const schema = codecSchema();
    const doc = codecFixture([{ id: 'A', text: 'CODE', type: 'codeBlock' }]);
    registerDocumentBodyRecords(doc, { facts: [{ id: 'bold', kind: 'mark', group: 'format', dependencies: [], payload: { type: 'bold', attrs: {} } }], groups: [{ id: 'format', facts: ['bold'], history: 'base' }] });
    const source = documentBodySource(doc, 'S:A');
    source.format(1, 4, { 'mark:bold': { factId: 'bold' } });
    const before = Y.encodeStateAsUpdate(doc);
    const expected = schema.node('doc', null, schema.node('blockGroup', null, codecParagraph(schema, 'A', 'CODE', 'codeBlock')));
    const result = project(doc, schema);

    expect(result.doc.toJSON()).toEqual(expected.toJSON());
    expect(result.doc.nodeAt(3)!.marks).toEqual([]);
    expect(result.index.units.every((unit) => (unit.native.attributes['mark:bold'] as { factId: string }).factId === 'bold')).toBe(true);
    expect(source.toDelta()).toContainEqual({ insert: 'CODE', attributes: { ctx: 'base', 'mark:bold': { factId: 'bold' } } });
    expect(Y.encodeStateAsUpdate(doc)).toEqual(before);
  });

  it('keeps opaque owner and descendant payload through known sibling edits and snapshot reload', () => {
    const schema = codecSchema();
    const payload = JSON.parse('{"__proto__":{"future":true},"config":{"items":[1,null,"x"]}}') as BodyJsonObject;
    const doc = codecFixture([{ id: 'unknown', text: 'hidden', type: 'futureBlock', attrs: payload }, { id: 'child', text: 'nested', parent: 'nested' }, { id: 'known', text: 'OK' }], [
      { id: 'nested', kind: 'container', type: 'blockGroup', attrs: {}, parent: 'unknown', order: 'zz' },
    ]);
    const oldRecord = documentBodyRecords(doc).records.get('unknown');
    const before = Y.encodeStateAsUpdate(doc);
    const initial = project(doc, schema);
    const placeholder = schema.node('blockContainer', { id: 'unknown' }, schema.node('unsupportedBlock', { originalName: 'futureBlock' }));
    const expected = schema.node('doc', null, schema.node('blockGroup', null, [placeholder, codecParagraph(schema, 'known', 'OK')]));

    expect(initial.doc.toJSON()).toEqual(expected.toJSON());
    expect(initial.index.opaque.get('unknown')!.record).toMatchObject({ id: 'unknown', type: 'futureBlock', attrs: payload });
    expect(initial.index.opaque.get('unknown')!.descendants.map((record) => record.id).sort()).toEqual(['F:child', 'F:unknown', 'child', 'nested']);
    expect(initial.index.opaque.get('unknown')!.units.map((unit) => unit.value).join('')).toBe('hiddennested');
    expect(Y.encodeStateAsUpdate(doc)).toEqual(before);

    documentBodySource(doc, 'S:known').insert(3, '!', { ctx: 'base' });
    const reloaded = codecDoc();
    Y.applyUpdate(reloaded, Y.encodeStateAsUpdate(doc));
    const next = project(reloaded, schema, 8);
    expect(next.doc.toJSON()).toEqual(schema.node('doc', null, schema.node('blockGroup', null, [placeholder, codecParagraph(schema, 'known', 'OK!')])).toJSON());
    expect(next.index.opaque.get('unknown')).toEqual(initial.index.opaque.get('unknown'));
    expect(documentBodyRecords(reloaded).records.get('unknown')).toBe(oldRecord);
  });

  it('retains an unknown inline leaf as one native unit and complete original value', () => {
    const schema = codecSchema();
    const doc = codecFixture([{ id: 'A', text: 'AB' }]);
    const value = { bodyInline: { type: 'futureChip', attrs: { id: 'chip', values: [1, false] } } };
    documentBodySource(doc, 'S:A').insertEmbed(2, value, { ctx: 'base' });
    const token = codecNativeTokens(doc, 'A', 1, 2)[0];
    const before = Y.encodeStateAsUpdate(doc);
    const result = project(doc, schema);

    expect(result.doc.nodeAt(4)!.toJSON()).toEqual({ type: 'unsupportedInline', attrs: { originalName: 'futureChip' } });
    expect(result.units.map((unit) => unit.value)).toEqual(['A', '<unsupportedInline>', 'B']);
    expect(result.index.units.find((unit) => unit.token === token)!.native.value).toEqual(value);
    expect(Y.encodeStateAsUpdate(doc)).toEqual(before);
  });

  it('projects real layout table cells with correct common node boundaries', () => {
    const schema = codecSchema();
    const doc = codecTableFixture();
    const before = Y.encodeStateAsUpdate(doc);
    const result = project(doc, schema);
    const expected = schema.node('doc', null, schema.node('blockGroup', null, schema.node('docTable', { id: 'table' }, schema.node('docTableRow', { id: 'row' }, [
      schema.node('docTableCell', { id: 'left' }, codecParagraph(schema, 'L', 'left')),
      schema.node('docTableCell', { id: 'right' }, codecParagraph(schema, 'R', 'right')),
    ]))));

    expect(result.doc.toJSON()).toEqual(expected.toJSON());
    expect(TableMap.get(result.doc.nodeAt(1)!).problems).toBeNull();
    expect(() => result.doc.check()).not.toThrow();
    expect(result.index.nodes.get('left')).toEqual({ id: 'left', type: 'docTableCell', from: 3, to: 13, contentFrom: 4, contentTo: 12 });
    expect(result.index.owners.get('L')).toEqual({ id: 'L', type: 'paragraph', from: 4, to: 12, contentFrom: 6, contentTo: 10 });
    expect(result.index.units[0].pos).toBe(6);
    expect(Y.encodeStateAsUpdate(doc)).toEqual(before);
  });

  it('keeps a complete empty body synthetic and distinguishes an incomplete source', () => {
    const schema = codecSchema();
    const empty = codecFixture([]);
    const before = Y.encodeStateAsUpdate(empty);
    const projection = project(empty, schema);
    expect(projection.synthetic).toBe(true);
    expect(projection.doc.textContent).toBe('');
    expect(projection.doc.firstChild!.childCount).toBe(1);
    expect(projection.doc.firstChild!.firstChild!.firstChild!.type.name).toBe('paragraph');
    expect(projection.units).toEqual([]);
    expect(projection.index.owners.size).toBe(0);
    expect(() => projection.doc.check()).not.toThrow();
    expect(Y.encodeStateAsUpdate(empty)).toEqual(before);

    const incomplete = codecFixture([{ id: 'A', text: 'X' }]);
    documentBodySource(incomplete, 'S:A').format(1, 1, { ctx: 'not-arrived' });
    const incompleteBefore = Y.encodeStateAsUpdate(incomplete);
    expect(projectBodyTree(incomplete, schema, { document: 'document-one', epoch: 8 })).toEqual({ status: 'pending', missing: ['context:not-arrived'] });
    expect(Y.encodeStateAsUpdate(incomplete)).toEqual(incompleteBefore);
    expect(projectBodyTree(codecDoc(), schema, { document: 'new', epoch: 0 })).toEqual({ status: 'uninitialized' });
  });

  it('keeps every native UTF-16 occurrence through arbitrary base text and extra cuts', () => {
    const schema = codecSchema();
    fc.assert(fc.property(fc.array(fc.constantFrom('A', 'B', '😀', 'e\u0301'), { minLength: 1, maxLength: 12 }), (parts) => {
      const text = parts.join('');
      const doc = codecFixture([{ id: 'A', text }]);
      const tokens = codecNativeTokens(doc, 'A', text.length);
      let index = 1;
      for (const [ordinal, part] of parts.entries()) {
        registerBodyCut(doc, 'S:A', `cut:${ordinal}`, index);
        index += part.length + 1;
      }
      const before = Y.encodeStateAsUpdate(doc);
      const result = project(doc, schema);
      expect(result.doc.textContent).toBe(text);
      expect(result.units.map((unit) => unit.token)).toEqual(tokens);
      expect(result.units.map((unit) => unit.value).join('')).toBe(text);
      expect(new Set(result.units.map((unit) => unit.token)).size).toBe(text.length);
      expect(Y.encodeStateAsUpdate(doc)).toEqual(before);
    }), { seed: 1619, numRuns: 30 });
  });

  it('expands remaining child blocks transparently after an owner facet moves away', () => {
    const schema = codecSchema();
    const doc = codecFixture([{ id: 'A', text: 'A' }, { id: 'child', text: 'C', parent: 'nested' }, { id: 'B', text: 'B' }], [
      { id: 'nested', kind: 'container', type: 'blockGroup', attrs: {}, parent: 'A', order: 'zz' },
    ]);
    codecFacts(doc, 'move', [{ id: 'move-facet', kind: 'structure', group: 'move', dependencies: [], edges: [{ child: 'F:A', parent: 'F:B', counter: 1, order: '\uffff' }] }]);
    const result = project(doc, schema);
    const expected = schema.node('doc', null, schema.node('blockGroup', null, [codecParagraph(schema, 'child', 'C'), codecParagraph(schema, 'B', 'BA')]));
    expect(result.doc.toJSON()).toEqual(expected.toJSON());
    expect(result.index.owners.has('A')).toBe(false);
    expect(result.index.units.filter((unit) => unit.owner === 'B').map((unit) => unit.source)).toEqual(['S:B', 'S:A']);
  });
});
