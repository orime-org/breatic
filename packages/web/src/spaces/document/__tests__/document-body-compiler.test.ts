// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import type { Node as PMNode, Schema } from '@tiptap/pm/model';
import { EditorState, Plugin, type Transaction } from '@tiptap/pm/state';
import fc from 'fast-check';
import { afterEach, describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { documentBodySource } from '@breatic/shared';

import { projectBodyTree } from '@web/spaces/document/document-body-codec';
import type { BodyProjection } from '@web/spaces/document/document-body-codec-types';
import { compileBodyBatch } from '@web/spaces/document/document-body-compiler';
import type { CompileBodyBatchOptions } from '@web/spaces/document/document-body-compiler-types';
import { replayBodyJournal, type BodyJournalSnapshot } from '@web/spaces/document/document-body-journal';
import { commitPreparedBodyBatch, prepareBodyBatch } from '@web/spaces/document/document-body-plan';
import type { BodyBatchEnvironment, BodyBatchPlan, BodyBatchResult } from '@web/spaces/document/document-body-plan-types';
import { BodyOriginMirror } from '@web/spaces/document/document-body-provenance';
import { createDocumentBodyRuntime } from '@web/spaces/document/document-body-runtime';
import type { DocumentBodyRuntime } from '@web/spaces/document/document-body-runtime-types';
import {
  cleanupCodecFixtures,
  codecFixture,
  codecNativeTokens,
  codecParagraph,
  codecSchema,
} from '@web/spaces/document/__tests__/document-body-codec-fixtures';

interface Fixture {
  readonly doc: Y.Doc;
  readonly schema: Schema;
  readonly projection: BodyProjection;
  readonly env: BodyBatchEnvironment;
  readonly history: Y.UndoManager;
  readonly a: readonly string[];
  readonly b: readonly string[];
}

interface ContentRange {
  readonly node: PMNode;
  readonly before: number;
  readonly from: number;
  readonly to: number;
}

const histories: Y.UndoManager[] = [];
const runtimes: DocumentBodyRuntime[] = [];

afterEach(() => {
  histories.splice(0).forEach((history) => history.destroy());
  runtimes.splice(0).forEach((runtime) => runtime.dispose());
  cleanupCodecFixtures();
});

/** Reads the actual production codec without supplying its expected JSON. @throws {Error} If source dependencies are incomplete. */
function project(doc: Y.Doc, schema: Schema): BodyProjection {
  const read = projectBodyTree(doc, schema, { document: 'compiler-document', epoch: 1 });
  if (read.status !== 'ready') throw new Error(`Incomplete compiler fixture: ${read.status}`);
  return read.projection;
}

/** Creates real native records, the installed editor schema and origin-scoped history. @throws {Error} If fixture construction fails. */
function fixture(left = 'ABCD', right = 'xy', schema = codecSchema()): Fixture {
  const doc = codecFixture([{ id: 'A', text: left }, { id: 'B', text: right }]);
  const projection = project(doc, schema);
  const userOrigin = {};
  const runtime = createDocumentBodyRuntime(doc, () => undefined);
  runtimes.push(runtime);
  const history = new Y.UndoManager(doc, { trackedOrigins: new Set([userOrigin]) });
  histories.push(history);
  return {
    doc, schema, projection, history,
    a: codecNativeTokens(doc, 'A', left.length),
    b: codecNativeTokens(doc, 'B', right.length),
    env: { doc, runtime, userOrigin, canWrite: () => true, project: (source) => project(source, schema) },
  };
}

/** Finds a current owner by its explicit fixture handle, never by its words. @throws {Error} If the owner is absent. */
function content(doc: PMNode, id: string): ContentRange {
  let found: ContentRange | undefined;
  doc.descendants((node, before) => {
    if (node.type.name === 'blockContainer' && node.attrs['id'] === id) {
      if (node.firstChild === null) throw new Error('A fixture owner has no content');
      found = { node, before, from: before + 2, to: before + 2 + node.firstChild.content.size };
    }
  });
  if (found === undefined) throw new Error(`Missing fixture owner ${id}`);
  return found;
}

/** Uses the installed schema's ordinary depth-two split with a test-owned new handle. @throws {RangeError} If the split is invalid. */
function split(transaction: Transaction, owner: string, offset: number, created: string): void {
  const range = content(transaction.doc, owner);
  const paragraph = range.node.firstChild!;
  transaction.split(range.from + offset, 2, [
    { type: range.node.type, attrs: { ...range.node.attrs, id: created } },
    { type: paragraph.type, attrs: paragraph.attrs },
  ]);
}

/** Reads all current labels before executing the same real/private move fitter. @throws {Error} If provenance or fitting is inconsistent. */
function mirrorAt(transaction: Transaction, body: Fixture, batchId: string): BodyOriginMirror {
  const current = replayBodyJournal(body.projection.doc, body.projection.units, [transaction], { batchId });
  return new BodyOriginMirror(transaction, {
    sourceAt: new Map(current.units.map((unit) => [unit.pos, unit.token])),
    sourceOrigins: new Map(current.units.map((unit) => [unit.token, unit.origin])),
  });
}

/** Builds an independently specified complete BlockNote document. @throws {RangeError} If expected content violates the actual schema. */
function expectedDoc(schema: Schema, owners: readonly (readonly [string, string])[]): PMNode {
  return schema.node('doc', null, schema.node('blockGroup', null, owners.map(([id, text]) => codecParagraph(schema, id, text))));
}

/** Keeps the compiler's intended typed contract explicit while its module is introduced by TDD. @throws {Error} If compilation rejects the journal. */
function compile(input: CompileBodyBatchOptions): BodyBatchPlan {
  return compileBodyBatch(input);
}

/** Compiles and rehearses without allowing either operation to mutate the real source. @throws {Error} If compilation or preflight fails. */
function compileAndCommit(body: Fixture, journal: BodyJournalSnapshot, batchId: string): { readonly plan: BodyBatchPlan; readonly result: BodyBatchResult } {
  const before = Y.encodeStateAsUpdate(body.doc);
  const plan = compile({ doc: body.doc, projection: body.projection, journal, batchId });
  expect(Y.encodeStateAsUpdate(body.doc)).toEqual(before);
  expect(plan.expected.doc.toJSON()).toEqual(journal.doc.toJSON());
  expect(plan.expected.units).toEqual(journal.units);
  const prepared = prepareBodyBatch(body.env, plan);
  expect(Y.encodeStateAsUpdate(body.doc)).toEqual(before);
  expect(body.history.undoStack).toHaveLength(0);
  const result = commitPreparedBodyBatch(body.env, prepared);
  expect(body.history.undoStack).toHaveLength(1);
  return { plan, result };
}

/** Checks old native identities against a test-owned order and owner assignment. @throws {never} */
function expectNative(body: Fixture, projection: BodyBatchResult['projection'], owners: readonly (readonly [string, readonly string[]])[]): void {
  const originals = new Set([...body.a, ...body.b]);
  expect(projection.units.filter((unit) => originals.has(unit.token)).map((unit) => [unit.block, unit.token])).toEqual(
    owners.flatMap(([owner, tokens]) => tokens.map((token) => [owner, token])),
  );
}

describe('complete accepted-journal body compiler', () => {
  it('commits input split fresh transfer and appended formatting as one user transaction', () => {
    const body = fixture();
    const batchId = 'mixed-journal';
    const state = EditorState.create({ doc: body.projection.doc, plugins: [new Plugin({
      appendTransaction: (transactions, _previous, current) => {
        if (!transactions.some((transaction) => transaction.getMeta('compiler-root') === true)) return null;
        const append = current.tr;
        append.insertText('!', content(append.doc, 'H').to);
        const boldAt = content(append.doc, 'B').from + 1;
        return append.addMark(boldAt, boldAt + 2, body.schema.mark('bold'));
      },
    })] });
    const root = state.tr.setMeta('compiler-root', true);
    root.insertText('1234', content(root.doc, 'A').from + 2);
    split(root, 'A', 4, 'H');
    const moved = content(root.doc, 'H');
    const destination = content(root.doc, 'B');
    mirrorAt(root, body, batchId).moveRange(moved.from, moved.from + 2, destination.from + 1);
    const accepted = state.applyTransaction(root);
    const journal = replayBodyJournal(body.projection.doc, body.projection.units, accepted.transactions, { batchId });
    const expected = body.schema.node('doc', null, body.schema.node('blockGroup', null, [
      codecParagraph(body.schema, 'A', 'AB12'),
      codecParagraph(body.schema, 'H', 'CD!'),
      body.schema.node('blockContainer', { id: 'B' }, body.schema.node('paragraph', null, [
        body.schema.text('x'), body.schema.text('34', [body.schema.mark('bold')]), body.schema.text('y'),
      ])),
    ]));
    expect(accepted.state.doc.toJSON()).toEqual(expected.toJSON());
    expect(journal.doc.toJSON()).toEqual(expected.toJSON());
    expect(journal.transactions).toHaveLength(2);
    expect(journal.units.filter((unit) => unit.origin === 'existing').map((unit) => unit.token)).toEqual([...body.a, ...body.b]);
    const before = Y.encodeStateAsUpdate(body.doc);
    const plan = compile({ doc: body.doc, projection: body.projection, journal, batchId });
    expect(Y.encodeStateAsUpdate(body.doc)).toEqual(before);
    expect(plan.expected.doc.toJSON()).toEqual(expected.toJSON());
    expect(plan.expected.units).toEqual(journal.units);
    const prepared = prepareBodyBatch(body.env, plan);
    expect(Y.encodeStateAsUpdate(body.doc)).toEqual(before);
    expect(body.history.undoStack).toHaveLength(0);
    const observations: { readonly user: boolean; readonly projection: BodyProjection; readonly history: number; readonly newSources: readonly number[] }[] = [];
    body.doc.on('update', (_update, origin) => {
      observations.push({
        user: origin === body.env.userOrigin,
        projection: project(body.doc, body.schema),
        history: body.history.undoStack.length,
        newSources: (plan.registration.sources ?? []).map((source) => documentBodySource(body.doc, source.id).length),
      });
    });

    const result = commitPreparedBodyBatch(body.env, prepared);

    expect(observations.filter((entry) => entry.user)).toHaveLength(1);
    const registrations = observations.filter((entry) => !entry.user);
    expect(registrations.length).toBeGreaterThan(0);
    for (const entry of registrations) {
      expect(entry.projection.doc.toJSON()).toEqual(body.projection.doc.toJSON());
      expect(entry.projection.units).toEqual(body.projection.units);
      expect(entry.history).toBe(0);
      expect(entry.newSources.every((length) => length === 2)).toBe(true);
    }
    expect(result.projection.doc.toJSON()).toEqual(expected.toJSON());
    expectNative(body, result.projection, [['A', body.a.slice(0, 2)], ['H', body.a.slice(2)], ['B', body.b]]);
    const fresh = journal.units.filter((unit) => unit.origin === 'fresh');
    expect(fresh.map((unit) => unit.value)).toEqual(['1', '2', '!', '3', '4']);
    expect(result.aliases.size).toBe(5);
    expect(result.projection.units.map((unit) => unit.token)).toEqual(journal.units.map((unit) => result.aliases.get(unit.token) ?? unit.token));
    expect(body.history.undoStack).toHaveLength(1);
    body.history.undo();
    expect(project(body.doc, body.schema).doc.toJSON()).toEqual(body.projection.doc.toJSON());
    expect(project(body.doc, body.schema).units.map((unit) => unit.token)).toEqual([...body.a, ...body.b]);
    body.history.redo();
    expect(project(body.doc, body.schema).doc.toJSON()).toEqual(expected.toJSON());
  });

  it('splits the existing suffix after filtering fresh input from its native offset', () => {
    const body = fixture();
    const batchId = 'native-suffix';
    const root = EditorState.create({ doc: body.projection.doc }).tr;
    root.insertText('12', content(root.doc, 'A').from + 2);
    split(root, 'A', 4, 'H');
    const journal = replayBodyJournal(body.projection.doc, body.projection.units, [root], { batchId });
    const expected = expectedDoc(body.schema, [['A', 'AB12'], ['H', 'CD'], ['B', 'xy']]);
    expect(journal.doc.toJSON()).toEqual(expected.toJSON());

    const { plan, result } = compileAndCommit(body, journal, batchId);

    expect(result.projection.doc.toJSON()).toEqual(expected.toJSON());
    expectNative(body, result.projection, [['A', body.a.slice(0, 2)], ['H', body.a.slice(2)], ['B', body.b]]);
    expect(plan.fresh.flatMap((run) => run.units.map((unit) => unit.value))).toEqual(['1', '2']);
    body.history.undo();
    expect(project(body.doc, body.schema).doc.toJSON()).toEqual(body.projection.doc.toJSON());
  });

  it('joins the complete right native facet after fresh content at the left boundary', () => {
    const body = fixture('AB', 'CD');
    const batchId = 'native-join';
    const root = EditorState.create({ doc: body.projection.doc }).tr;
    root.insertText('12', content(root.doc, 'A').to);
    root.join(content(root.doc, 'B').before, 2);
    const journal = replayBodyJournal(body.projection.doc, body.projection.units, [root], { batchId });
    const expected = expectedDoc(body.schema, [['A', 'AB12CD']]);
    expect(journal.doc.toJSON()).toEqual(expected.toJSON());

    const { result } = compileAndCommit(body, journal, batchId);

    expect(result.projection.doc.toJSON()).toEqual(expected.toJSON());
    expectNative(body, result.projection, [['A', [...body.a, ...body.b]]]);
    body.history.undo();
    expect(project(body.doc, body.schema).doc.toJSON()).toEqual(body.projection.doc.toJSON());
  });

  it('moves a mixed existing and fresh interval without moving its unselected native suffix', () => {
    const body = fixture();
    const batchId = 'mixed-range';
    const root = EditorState.create({ doc: body.projection.doc }).tr;
    root.insertText('12', content(root.doc, 'A').from + 2);
    const source = content(root.doc, 'A');
    const destination = content(root.doc, 'B');
    mirrorAt(root, body, batchId).moveRange(source.from + 1, source.from + 5, destination.from + 1);
    const journal = replayBodyJournal(body.projection.doc, body.projection.units, [root], { batchId });
    const expected = expectedDoc(body.schema, [['A', 'AD'], ['B', 'xB12Cy']]);
    expect(journal.doc.toJSON()).toEqual(expected.toJSON());

    const { result } = compileAndCommit(body, journal, batchId);

    expect(result.projection.doc.toJSON()).toEqual(expected.toJSON());
    expectNative(body, result.projection, [['A', [body.a[0], body.a[3]]], ['B', [body.b[0], body.a[1], body.a[2], body.b[1]]]]);
    body.history.undo();
    expect(project(body.doc, body.schema).doc.toJSON()).toEqual(body.projection.doc.toJSON());
  });

  it('registers only final surviving fresh runs after intermediate deletion and transfer', () => {
    const body = fixture();
    const batchId = 'fresh-filter';
    const root = EditorState.create({ doc: body.projection.doc }).tr;
    const a = content(root.doc, 'A').from;
    root.insertText('1234', a + 2);
    root.delete(a + 3, a + 5);
    const source = content(root.doc, 'A');
    mirrorAt(root, body, batchId).moveRange(source.from + 3, source.from + 4, content(root.doc, 'B').from + 1);
    const journal = replayBodyJournal(body.projection.doc, body.projection.units, [root], { batchId });
    const expected = expectedDoc(body.schema, [['A', 'AB1CD'], ['B', 'x4y']]);
    expect(journal.doc.toJSON()).toEqual(expected.toJSON());

    const { plan, result } = compileAndCommit(body, journal, batchId);

    expect(result.projection.doc.toJSON()).toEqual(expected.toJSON());
    expectNative(body, result.projection, [['A', body.a], ['B', body.b]]);
    expect(plan.fresh.flatMap((run) => run.units.map((unit) => unit.value)).sort()).toEqual(['1', '4']);
    expect(plan.native.filter((write) => write.kind === 'delete')).toEqual([]);
    expect(result.aliases.size).toBe(2);
    body.history.undo();
    expect(project(body.doc, body.schema).doc.toJSON()).toEqual(body.projection.doc.toJSON());
  });

  it('deletes only observed native identities when a deleted range also contains uncommitted fresh input', () => {
    const body = fixture();
    const batchId = 'native-delete';
    const root = EditorState.create({ doc: body.projection.doc }).tr;
    const a = content(root.doc, 'A').from;
    root.insertText('12', a + 2);
    root.delete(a + 1, a + 5);
    const journal = replayBodyJournal(body.projection.doc, body.projection.units, [root], { batchId });
    const expected = expectedDoc(body.schema, [['A', 'AD'], ['B', 'xy']]);
    expect(journal.doc.toJSON()).toEqual(expected.toJSON());

    const { plan, result } = compileAndCommit(body, journal, batchId);

    expect(result.projection.doc.toJSON()).toEqual(expected.toJSON());
    expect(plan.native.filter((write) => write.kind === 'delete').flatMap((write) => write.ids).sort()).toEqual(body.a.slice(1, 3).sort());
    expect(plan.fresh).toEqual([]);
    expect(result.aliases.size).toBe(0);
    expectNative(body, result.projection, [['A', [body.a[0], body.a[3]]], ['B', body.b]]);
    body.history.undo();
    expect(project(body.doc, body.schema).doc.toJSON()).toEqual(body.projection.doc.toJSON());
  });

  it('preserves independent repeated native labels across generated transfers with fresh offsets', () => {
    const schema = codecSchema();
    fc.assert(fc.property(fc.nat(3), fc.nat(3), fc.nat(2), (start, length, target) => {
      const body = fixture('AAAA', 'AA', schema);
      const batchId = `generated-${start}-${length}-${target}`;
      const count = 1 + length % (4 - start);
      const root = EditorState.create({ doc: body.projection.doc }).tr;
      root.insertText('!', content(root.doc, 'A').from);
      const source = content(root.doc, 'A');
      mirrorAt(root, body, batchId).moveRange(source.from + 1 + start, source.from + 1 + start + count, content(root.doc, 'B').from + target);
      const journal = replayBodyJournal(body.projection.doc, body.projection.units, [root], { batchId });
      const expected = expectedDoc(schema, [['A', `!${'A'.repeat(4 - count)}`], ['B', 'A'.repeat(2 + count)]]);
      expect(journal.doc.toJSON()).toEqual(expected.toJSON());

      const { result } = compileAndCommit(body, journal, batchId);

      expect(result.projection.doc.toJSON()).toEqual(expected.toJSON());
      expectNative(body, result.projection, [
        ['A', [...body.a.slice(0, start), ...body.a.slice(start + count)]],
        ['B', [...body.b.slice(0, target), ...body.a.slice(start, start + count), ...body.b.slice(target)]],
      ]);
      expect(result.aliases.size).toBe(1);
      body.history.undo();
      expect(project(body.doc, schema).doc.toJSON()).toEqual(body.projection.doc.toJSON());
    }), { numRuns: 40, seed: 161942 });
  });
});
