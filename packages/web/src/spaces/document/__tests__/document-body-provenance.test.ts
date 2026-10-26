// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { describe, expect, it } from 'vitest';
import { Fragment, Schema, Slice } from '@tiptap/pm/model';
import { EditorState } from '@tiptap/pm/state';
import { TextSelection } from '@tiptap/pm/state';
import { joinBackward } from '@tiptap/pm/commands';
import fc from 'fast-check';

import { replayBodyJournal } from '@web/spaces/document/document-body-journal';
import {
  BODY_OPERATION_META,
  BODY_TRACE_MARK,
  BodyOriginMirror,
  auditBodyMirrorSchema,
  type BodyTransferOperation,
} from '@web/spaces/document/document-body-provenance';
import {
  bodyDocument,
  bodyJournalSchema,
  bodyLabels,
  bodyParagraph,
  initialBodyUnits,
} from '@web/spaces/document/__tests__/document-body-provenance-fixtures';

describe('body source-preserving mirror', () => {
  it('moves the exact selected native interval and leaves both suffixes in place', () => {
    const before = bodyDocument(bodyParagraph('a', 'ABCDEF'), bodyParagraph('b', 'xyz'));
    const initial = initialBodyUnits(before);
    const tr = EditorState.create({ schema: bodyJournalSchema, doc: before }).tr;
    const mirror = new BodyOriginMirror(tr, { sourceAt: new Map(initial.map((unit) => [unit.pos, unit.token])) });

    mirror.moveRange(2, 5, 10);
    mirror.verify();
    const result = replayBodyJournal(before, initial, [tr], { batchId: 'move' });

    expect(tr.doc.child(0).textContent).toBe('AEF');
    expect(tr.doc.child(1).textContent).toBe('xBCDyz');
    expect(result.units.filter((unit) => unit.block === 'a').map((unit) => unit.token)).toEqual(['native:0', 'native:4', 'native:5']);
    expect(result.units.filter((unit) => unit.block === 'b').map((unit) => unit.token)).toEqual(['native:6', 'native:1', 'native:2', 'native:3', 'native:7', 'native:8']);
    expect(result.units.map((unit) => [unit.token, unit.pos])).toEqual(mirror.readUnits().map((unit) => [unit.token, unit.pos]));
    expect(JSON.stringify(tr.doc.toJSON()).includes(BODY_TRACE_MARK)).toBe(false);
    expect(result.deleted).toEqual([]);
  });

  it('fits cross-block repeated text while retaining each occurrence identity', () => {
    const before = bodyDocument(bodyParagraph('a', 'AAAA'), bodyParagraph('b', 'AAAA'), bodyParagraph('c', 'AAAA'));
    const initial = initialBodyUnits(before);
    const tr = EditorState.create({ schema: bodyJournalSchema, doc: before }).tr;
    const mirror = new BodyOriginMirror(tr, { sourceAt: new Map(initial.map((unit) => [unit.pos, unit.token])) });

    mirror.moveRange(2, 10, 15);
    const result = replayBodyJournal(before, initial, [tr], { batchId: 'open-slice' });

    expect(result.units.map((unit) => [unit.token, unit.pos])).toEqual(mirror.readUnits().map((unit) => [unit.token, unit.pos]));
    expect(bodyLabels(result.units).sort()).toEqual(bodyLabels(initial).sort());
    expect(result.units.map((unit) => unit.value)).toEqual(Array.from({ length: 12 }, () => 'A'));
    expect(new Set(bodyLabels(result.units)).size).toBe(12);
    expect(result.doc.toJSON()).toEqual(tr.doc.toJSON());
  });

  it('keeps inline leaf identities when the fitter splits and merges text around them', () => {
    const first = bodyJournalSchema.node('paragraph', { id: 'a' }, [
      bodyJournalSchema.text('AB'), bodyJournalSchema.node('hardBreak'),
      bodyJournalSchema.node('chip', { id: 'chip' }), bodyJournalSchema.text('CD'),
    ]);
    const before = bodyDocument(first, bodyParagraph('b', 'xy'));
    const initial = initialBodyUnits(before);
    const tr = EditorState.create({ schema: bodyJournalSchema, doc: before }).tr;
    const mirror = new BodyOriginMirror(tr, { sourceAt: new Map(initial.map((unit) => [unit.pos, unit.token])) });

    mirror.moveRange(2, 6, 10);
    const result = replayBodyJournal(before, initial, [tr], { batchId: 'inline' });

    expect(bodyLabels(result.units).sort()).toEqual(bodyLabels(initial).sort());
    expect(result.units.filter((unit) => unit.value === '<chip>').map((unit) => unit.token)).toEqual(['native:3']);
    expect(result.units.filter((unit) => unit.value === '<hardBreak>').map((unit) => unit.token)).toEqual(['native:2']);
    expect(result.units.map((unit) => [unit.token, unit.pos])).toEqual(mirror.readUnits().map((unit) => [unit.token, unit.pos]));
  });

  it('allocates independent labels for an identical copied slice', () => {
    const before = bodyDocument(bodyParagraph('a', 'AAAA'));
    const initial = initialBodyUnits(before);
    const tr = EditorState.create({ schema: bodyJournalSchema, doc: before }).tr;
    const mirror = new BodyOriginMirror(tr, { sourceAt: new Map(initial.map((unit) => [unit.pos, unit.token])) });

    mirror.insertCopy(5, new Slice(Fragment.from(bodyJournalSchema.text('AAAA')), 0, 0));
    const result = replayBodyJournal(before, initial, [tr], { batchId: 'fresh-copy' });

    expect(tr.doc.textContent).toBe('AAAAAAAA');
    expect(bodyLabels(result.units.slice(0, 4))).toEqual(bodyLabels(initial));
    expect(result.units.slice(4).map((unit) => unit.origin)).toEqual(['fresh', 'fresh', 'fresh', 'fresh']);
    expect(new Set(bodyLabels(result.units)).size).toBe(8);
    expect(result.units.map((unit) => [unit.token, unit.pos])).toEqual(mirror.readUnits().map((unit) => [unit.token, unit.pos]));
  });

  it('detects a missing or corrupt handoff using independently replayed labels', () => {
    const before = bodyDocument(bodyParagraph('a', 'ABCDEF'), bodyParagraph('b', 'xyz'));
    const initial = initialBodyUnits(before);
    const tr = EditorState.create({ schema: bodyJournalSchema, doc: before }).tr;
    const mirror = new BodyOriginMirror(tr, { sourceAt: new Map(initial.map((unit) => [unit.pos, unit.token])) });
    mirror.moveRange(2, 5, 10);
    const operations = structuredClone(tr.getMeta(BODY_OPERATION_META)) as BodyTransferOperation[];
    const original = operations[0];
    const corrupted = {
      ...original,
      handoffs: original.handoffs.map((handoff, index) => index === 0
        ? { ...handoff, source: { ...handoff.source, from: handoff.source.from + 1 } }
        : handoff),
    };
    tr.setMeta(BODY_OPERATION_META, [corrupted]);

    expect(() => replayBodyJournal(before, initial, [tr], { batchId: 'corrupt' })).toThrow(/source/);
    expect(() => mirror.verify()).toThrow(/source/);

    tr.setMeta(BODY_OPERATION_META, [{ ...original, handoffs: original.handoffs.slice(1) }]);
    const incomplete = replayBodyJournal(before, initial, [tr], { batchId: 'missing' });
    expect(incomplete.units.map((unit) => [unit.token, unit.pos])).not.toEqual(mirror.readUnits().map((unit) => [unit.token, unit.pos]));
    expect(() => mirror.verify()).toThrow(/source/);
  });

  it('rejects a mirror schema whose text cardinality changes after unit splitting', () => {
    const schema = new Schema({ nodes: { doc: { content: 'paragraph' }, paragraph: { content: 'text?' }, text: {} } });

    expect(() => auditBodyMirrorSchema(schema)).toThrow(/text cardinality/);

    expect(auditBodyMirrorSchema(bodyJournalSchema).map((entry) => entry.type)).toEqual(['paragraph']);
  });

  it('preserves opaque attribute payloads and user text that contain the private tag name', () => {
    const schema = new Schema({
      nodes: {
        doc: { content: 'paragraph+' },
        paragraph: { content: 'text*', attrs: { id: { default: null }, payload: { default: null } } },
        text: {},
      },
    });
    const payload = { attrs: { [BODY_TRACE_MARK]: 'opaque value' }, marks: [{ type: BODY_TRACE_MARK, attrs: { token: 'opaque token' } }] };
    const before = schema.node('doc', null, [
      schema.node('paragraph', { id: 'a', payload }, schema.text(BODY_TRACE_MARK)),
      schema.node('paragraph', { id: 'b' }, schema.text('xy')),
    ]);
    const initial = initialBodyUnits(before);
    const tr = EditorState.create({ schema, doc: before }).tr;
    const mirror = new BodyOriginMirror(tr, { sourceAt: new Map(initial.map((unit) => [unit.pos, unit.token])) });

    mirror.moveRange(1, 2, before.child(0).nodeSize + 2);
    mirror.verify();

    expect(tr.doc.child(0).attrs['payload']).toEqual(payload);
    expect(tr.doc.textContent).toBe(`${BODY_TRACE_MARK.slice(1)}x${BODY_TRACE_MARK.charAt(0)}y`);
    expect(bodyLabels(mirror.readUnits()).sort()).toEqual(bodyLabels(initial).sort());
  });

  it('adopts a forked move after a copied prefix with the same staged source names', () => {
    const before = bodyDocument(bodyParagraph('a', 'ABCD'), bodyParagraph('b', 'xy'));
    const initial = initialBodyUnits(before);
    const tr = EditorState.create({ schema: bodyJournalSchema, doc: before }).tr;
    const mirror = new BodyOriginMirror(tr, { sourceAt: new Map(initial.map((unit) => [unit.pos, unit.token])) });
    mirror.insertCopy(1, new Slice(Fragment.from(bodyJournalSchema.text('!')), 0, 0));
    const child = mirror.fork();
    child.moveRange(3, 5, 9);

    mirror.adopt(child);
    const result = replayBodyJournal(before, initial, [tr], { batchId: 'fork' });

    expect(result.doc.child(0).textContent).toBe('!AD');
    expect(result.doc.child(1).textContent).toBe('xBCy');
    expect(result.operations.map((operation) => [operation.source.step, operation.target.step])).toEqual([[0, 1], [1, 3]]);
    expect(result.units.map((unit) => [unit.token, unit.pos, unit.origin])).toEqual(mirror.readUnits().map((unit) => [unit.token, unit.pos, unit.origin]));
    expect(result.units.filter((unit) => unit.origin === 'existing').map((unit) => unit.token)).toEqual(['native:0', 'native:3', 'native:4', 'native:1', 'native:2', 'native:5']);
  });

  it('runs the same installed join command with actual and private states', () => {
    const before = bodyDocument(bodyParagraph('a', 'AB'), bodyParagraph('b', 'CD'));
    const initial = initialBodyUnits(before);
    const tr = EditorState.create({ schema: bodyJournalSchema, doc: before }).tr;
    const mirror = new BodyOriginMirror(tr, { sourceAt: new Map(initial.map((unit) => [unit.pos, unit.token])) });

    mirror.nativeMove('join paragraphs', 5, 7, TextSelection.create(before, 5), (state, dispatch) => joinBackward(state, dispatch));
    const result = replayBodyJournal(before, initial, [tr], { batchId: 'native-join' });

    expect(result.doc.toJSON()).toEqual(bodyDocument(bodyParagraph('a', 'ABCD')).toJSON());
    expect(bodyLabels(result.units)).toEqual(bodyLabels(initial));
    expect(result.units.map((unit) => unit.block)).toEqual(['a', 'a', 'a', 'a']);
    expect(result.units.map((unit) => [unit.token, unit.pos])).toEqual(mirror.readUnits().map((unit) => [unit.token, unit.pos]));
  });

  it('preserves exact native labels for generated scalar-safe partial moves', () => {
    const scalars = fc.array(fc.constantFrom('A', 'B', '😀', '\u0301', '中'), { minLength: 1, maxLength: 7 });
    fc.assert(fc.property(scalars, scalars, fc.nat(), fc.nat(), fc.nat(), (left, right, first, length, landing) => {
      const start = first % left.length;
      const count = 1 + length % (left.length - start);
      const target = landing % (right.length + 1);
      const leftText = left.join('');
      const rightText = right.join('');
      const from = left.slice(0, start).join('').length;
      const to = left.slice(0, start + count).join('').length;
      const targetOffset = right.slice(0, target).join('').length;
      const before = bodyDocument(bodyParagraph('a', leftText), bodyParagraph('b', rightText));
      const initial = initialBodyUnits(before);
      const leftLabels = bodyLabels(initial.slice(0, leftText.length));
      const rightLabels = bodyLabels(initial.slice(leftText.length));
      const selected = leftLabels.slice(from, to);
      const tr = EditorState.create({ schema: bodyJournalSchema, doc: before }).tr;
      const mirror = new BodyOriginMirror(tr, { sourceAt: new Map(initial.map((unit) => [unit.pos, unit.token])) });

      mirror.moveRange(from + 1, to + 1, leftText.length + 3 + targetOffset);
      const result = replayBodyJournal(before, initial, [tr], { batchId: 'generated' });

      expect(result.doc.child(0).textContent).toBe(leftText.slice(0, from) + leftText.slice(to));
      expect(result.doc.child(1).textContent).toBe(rightText.slice(0, targetOffset) + leftText.slice(from, to) + rightText.slice(targetOffset));
      expect(bodyLabels(result.units.filter((unit) => unit.block === 'a'))).toEqual([...leftLabels.slice(0, from), ...leftLabels.slice(to)]);
      expect(bodyLabels(result.units.filter((unit) => unit.block === 'b'))).toEqual([...rightLabels.slice(0, targetOffset), ...selected, ...rightLabels.slice(targetOffset)]);
      expect(result.deleted).toEqual([]);
      expect(new Set(bodyLabels(result.units)).size).toBe(initial.length);
    }), { numRuns: 100, seed: 161931 });
  });
});
