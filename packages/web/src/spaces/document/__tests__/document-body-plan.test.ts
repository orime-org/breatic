// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { afterEach, describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { Schema } from '@tiptap/pm/model';
import * as Y from 'yjs';
import {
  documentBodyRecords,
  documentBodySource,
  readBodyTree,
  registerDocumentBodyRecords,
} from '@breatic/shared/document-body';

import { commitPreparedBodyBatch, prepareBodyBatch } from '@web/spaces/document/document-body-plan';
import type { BodyBatchEnvironment, BodyBatchPlan, BodyPlanProjection } from '@web/spaces/document/document-body-plan-types';
import { createDocumentBodyRuntime } from '@web/spaces/document/document-body-runtime';

const schema = new Schema({ nodes: {
  doc: { content: 'paragraph*' },
  paragraph: { content: 'text*', attrs: { id: { default: null } } },
  text: {},
} });
const docs: Y.Doc[] = [];
const histories: Y.UndoManager[] = [];

afterEach(() => {
  histories.splice(0).forEach((history) => history.destroy());
  docs.splice(0).forEach((doc) => doc.destroy());
});

/** Projects a small independent schema for the explicit commit-engine contract. */
function project(doc: Y.Doc): BodyPlanProjection {
  const read = readBodyTree(doc);
  if (read.status !== 'ready') throw new Error(`Incomplete test body:${read.status}`);
  let position = 1;
  const units: BodyPlanProjection['units'][number][] = [];
  const paragraphs = read.view.owners.map((owner) => {
    const text = owner.units.map((unit) => String(unit.value)).join('');
    for (const unit of owner.units) units.push({
      token: unit.id, origin: 'existing', pos: position++, width: 1, value: String(unit.value), block: owner.id,
    });
    position += 2;
    return schema.nodes['paragraph'].create({ id: owner.id }, text === '' ? [] : schema.text(text));
  });
  return { doc: schema.nodes['doc'].create(null, paragraphs), units };
}

/** Builds a real native source and origin-scoped history for the approved plan contract. */
function fixture(text = 'AB', canWrite = (): boolean => true): { env: BodyBatchEnvironment; history: Y.UndoManager } {
  const doc = new Y.Doc();
  docs.push(doc);
  registerDocumentBodyRecords(doc, {
    records: [
      { id: 'root', kind: 'root', attrs: {} },
      { id: 'group', kind: 'container', type: 'blockGroup', parent: 'root', order: 'a', attrs: {} },
      { id: 'A', kind: 'owner', type: 'paragraph', attrs: {}, wrapperAttrs: { id: 'A' }, facet: 'F:A', base: true, parent: 'group', order: 'a' },
      { id: 'F:A', kind: 'facet', owner: 'A', parent: 'A', order: 'a' },
    ],
    sources: [{ id: 'S:A', facet: 'F:A', head: 'head:A', tail: 'tail:A' }],
    contexts: [{ id: 'base', dependencies: [] }],
  });
  const { metadata } = documentBodyRecords(doc);
  metadata.set('format', 'breatic.document.records');
  metadata.set('version', 1);
  metadata.set('seedRoot', 'root');
  if (text !== '') documentBodySource(doc, 'S:A').insert(1, text, { ctx: 'base' });
  const userOrigin = {};
  const history = new Y.UndoManager(doc, { trackedOrigins: new Set([userOrigin]) });
  histories.push(history);
  const runtime = createDocumentBodyRuntime(doc, () => undefined);
  return { env: { doc, runtime, userOrigin, canWrite, project }, history };
}

/** Describes one accepted new run in a newly registered empty source. */
function plan(env: BodyBatchEnvironment): BodyBatchPlan {
  const before = project(env.doc);
  return {
    id: 'batch',
    registration: {
      sources: [{ id: 'fresh', facet: 'F:A', head: 'fresh:head', tail: 'fresh:tail' }],
      groups: [{ id: 'batch:group', history: 'user', facts: ['batch:structure'] }],
      facts: [{ id: 'batch:structure', group: 'batch:group', kind: 'structure', dependencies: [], edges: [
        { child: 'C:fresh:head', parent: 'C:tail:A', counter: 1, order: 'a' },
      ] }],
    },
    cuts: [], native: [],
    fresh: [{ source: 'fresh', units: [{ token: 'batch:fresh:0', value: 'Q', attributes: { ctx: 'base' } }] }],
    enable: ['batch:group'],
    expected: {
      doc: schema.nodes['doc'].create(null, schema.nodes['paragraph'].create({ id: 'A' }, schema.text('ABQ'))),
      units: [...before.units, { token: 'batch:fresh:0', origin: 'fresh', pos: 3, width: 1, value: 'Q', block: 'A' }],
    },
  };
}

describe('explicit body batch preflight and commit', () => {
  it('reports the actual registration user-write and projection boundaries', () => {
    const { env } = fixture();
    const phases: { phase: string; text: string }[] = [];
    const phased = { ...env, onCommitPhase: (phase: string): void => { phases.push({ phase, text: project(env.doc).doc.textContent }); } };
    const prepared = prepareBodyBatch(phased, plan(phased));
    expect(phases).toEqual([]);
    commitPreparedBodyBatch(phased, prepared);
    expect(phases).toEqual([
      { phase: 'registering', text: 'AB' }, { phase: 'committing', text: 'AB' },
      { phase: 'written', text: 'ABQ' }, { phase: 'projecting', text: 'ABQ' },
    ]);
  });

  it('records entry and return of the actual native USER call without observer callbacks', () => {
    const { env } = fixture();
    const writeState = { started: false, returned: false };
    const tracked = { ...env, writeState };
    const prepared = prepareBodyBatch(tracked, plan(tracked));
    expect(writeState).toEqual({ started: false, returned: false });
    commitPreparedBodyBatch(tracked, prepared);
    expect(writeState).toEqual({ started: true, returned: true });
  });

  it('reports a USER observer failure while keeping its actual written source', () => {
    const { env, history } = fixture();
    const writeState = { started: false, returned: false };
    const tracked = { ...env, writeState };
    const prepared = prepareBodyBatch(tracked, plan(tracked));
    const failure = new Error('native observer failed');
    env.doc.on('update', (_update, origin) => { if (origin === env.userOrigin) throw failure; });
    expect(() => commitPreparedBodyBatch(tracked, prepared)).toThrow(failure);
    expect(project(env.doc).doc.textContent).toBe('ABQ');
    expect(writeState).toEqual({ started: true, returned: false });
    expect(history.undoStack).toHaveLength(1);
  });

  it.each([
    ['registering', 'AB', 0], ['committing', 'AB', 0], ['written', 'ABQ', 1], ['projecting', 'ABQ', 1],
  ] as const)('retains the real source after a failure at %s', (at, text, items) => {
    const { env, history } = fixture();
    const failure = new Error(`test-${at}`);
    const writeState = { started: false, returned: false };
    const phased = { ...env, writeState, onCommitPhase: (phase: string): void => { if (phase === at) throw failure; } };
    const prepared = prepareBodyBatch(phased, plan(phased));
    expect(() => commitPreparedBodyBatch(phased, prepared)).toThrow(failure);
    expect(project(env.doc).doc.textContent).toBe(text);
    expect(history.undoStack).toHaveLength(items);
    expect(documentBodyRecords(env.doc).enabled.has('batch:group')).toBe(items === 1);
    expect(writeState).toEqual({ started: items === 1, returned: items === 1 });
  });

  it('checks the source revision again after entering registration', () => {
    const { env } = fixture();
    const phased = { ...env, onCommitPhase: (phase: string): void => {
      if (phase === 'registering') documentBodySource(env.doc, 'S:A').delete(1, 1);
    } };
    const prepared = prepareBodyBatch(phased, plan(phased));
    expect(() => commitPreparedBodyBatch(phased, prepared)).toThrow(/revision/i);
    expect(project(env.doc).doc.textContent).toBe('B');
    expect(documentBodyRecords(env.doc).sources.has('fresh')).toBe(false);
  });

  it('checks final permission after entering the native USER phase', () => {
    let allowed = true;
    const { env } = fixture('AB', () => allowed);
    const phased = { ...env, onCommitPhase: (phase: string): void => { if (phase === 'committing') allowed = false; } };
    const prepared = prepareBodyBatch(phased, plan(phased));
    expect(() => commitPreparedBodyBatch(phased, prepared)).toThrow(/admission/i);
    expect(project(env.doc).doc.textContent).toBe('AB');
    expect(documentBodySource(env.doc, 'fresh').length).toBe(2);
  });

  it('preflights in isolation then registers before exactly one native user transaction', () => {
    const { env, history } = fixture();
    const before = Y.encodeStateAsUpdate(env.doc);
    const expectedBefore = project(env.doc);
    const prepared = prepareBodyBatch(env, plan(env));
    expect(Y.encodeStateAsUpdate(env.doc)).toEqual(before);
    expect(history.undoStack).toHaveLength(0);
    const observations: { user: boolean; text: string; ids: readonly string[]; history: number }[] = [];
    env.doc.on('update', (_update, origin) => {
      observations.push({ user: origin === env.userOrigin, text: project(env.doc).doc.textContent,
        ids: project(env.doc).units.map((unit) => unit.token), history: history.undoStack.length });
    });
    const result = commitPreparedBodyBatch(env, prepared);
    expect(observations.map((entry) => [entry.user, entry.text])).toEqual([[false, 'AB'], [true, 'ABQ']]);
    expect(observations[0].ids).toEqual(expectedBefore.units.map((unit) => unit.token));
    expect(observations[0].history).toBe(0);
    expect(history.undoStack).toHaveLength(1);
    expect(result.projection.doc.textContent).toBe('ABQ');
    expect(result.projection.units.slice(0, 2)).toEqual(expectedBefore.units);
    expect(result.aliases.get('batch:fresh:0')).toBe(result.projection.units[2].token);
    expect(result.aliases.size).toBe(1);
    history.undo();
    expect(project(env.doc).doc.textContent).toBe('AB');
    history.redo();
    expect(project(env.doc).doc.textContent).toBe('ABQ');
  });

  it.each(['edges', 'destination', 'delete', 'expected'] as const)('rejects damaged %s in isolation without source or history writes', (damage) => {
    const { env, history } = fixture();
    const input = plan(env);
    const malformed = damage === 'edges'
      ? { ...input, registration: { ...input.registration, facts: [] } }
      : damage === 'destination' ? { ...input, fresh: [{ ...input.fresh[0], source: 'missing' }] }
        : damage === 'delete' ? { ...input, native: [{ kind: 'delete' as const, ids: ['missing/native'] }] }
          : { ...input, expected: { ...input.expected, doc: project(env.doc).doc } };
    const before = Y.encodeStateAsUpdate(env.doc);
    expect(() => prepareBodyBatch(env, malformed)).toThrow();
    expect(Y.encodeStateAsUpdate(env.doc)).toEqual(before);
    expect(history.undoStack).toHaveLength(0);
  });

  it('invalidates preflight after a deletion-only update even when the state vector is unchanged', () => {
    const { env, history } = fixture();
    const prepared = prepareBodyBatch(env, plan(env));
    const vector = Y.encodeStateVector(env.doc);
    documentBodySource(env.doc, 'S:A').delete(1, 1);
    expect(Y.encodeStateVector(env.doc)).toEqual(vector);
    const source = Y.encodeStateAsUpdate(env.doc);
    expect(() => commitPreparedBodyBatch(env, prepared)).toThrow(/revision/i);
    expect(Y.encodeStateAsUpdate(env.doc)).toEqual(source);
    expect(project(env.doc).doc.textContent).toBe('B');
    expect(history.undoStack).toHaveLength(0);
  });

  it('checks current admission and rejects reuse of a committed plan', () => {
    let allowed = true;
    const { env } = fixture('AB', () => allowed);
    const prepared = prepareBodyBatch(env, plan(env));
    const before = Y.encodeStateAsUpdate(env.doc);
    allowed = false;
    expect(() => commitPreparedBodyBatch(env, prepared)).toThrow(/admission/i);
    expect(Y.encodeStateAsUpdate(env.doc)).toEqual(before);
    expect(project(env.doc).doc.textContent).toBe('AB');
    allowed = true;
    commitPreparedBodyBatch(env, prepared);
    expect(() => commitPreparedBodyBatch(env, prepared)).toThrow();
    expect(project(env.doc).doc.textContent).toBe('ABQ');
  });

  it('rechecks current permission after registration before the single USER write', () => {
    let allowed = true;
    const { env, history } = fixture('AB', () => allowed);
    const prepared = prepareBodyBatch(env, plan(env));
    env.doc.on('update', (_update, origin) => {
      if (origin !== env.userOrigin) allowed = false;
    });
    expect(() => commitPreparedBodyBatch(env, prepared)).toThrow(/admission/i);
    expect(project(env.doc).doc.textContent).toBe('AB');
    expect(documentBodySource(env.doc, 'fresh').length).toBe(2);
    expect(documentBodyRecords(env.doc).enabled.has('batch:group')).toBe(false);
    expect(history.undoStack).toHaveLength(0);
  });

  it('rejects another environment and a runtime that becomes unavailable after preflight', () => {
    const { env } = fixture();
    const prepared = prepareBodyBatch(env, plan(env));
    const before = Y.encodeStateAsUpdate(env.doc);
    expect(() => commitPreparedBodyBatch({ ...env }, prepared)).toThrow(/handle/i);
    env.runtime.wait(['fact:pending']);
    expect(() => commitPreparedBodyBatch(env, prepared)).toThrow(/admission/i);
    expect(Y.encodeStateAsUpdate(env.doc)).toEqual(before);
    env.runtime.resume();
    expect(commitPreparedBodyBatch(env, prepared).projection.doc.textContent).toBe('ABQ');
  });

  it('detects an external source update reentering registration before USER', () => {
    const { env, history } = fixture();
    const prepared = prepareBodyBatch(env, plan(env));
    let once = false;
    env.doc.on('update', (_update, origin) => {
      if (!once && origin !== env.userOrigin) {
        once = true;
        env.doc.transact(() => documentBodySource(env.doc, 'S:A').insert(1, '!'), 'external');
      }
    });
    expect(() => commitPreparedBodyBatch(env, prepared)).toThrow();
    expect(project(env.doc).doc.textContent).toBe('!AB');
    expect(documentBodyRecords(env.doc).enabled.has('batch:group')).toBe(false);
    expect(history.undoStack).toHaveLength(0);
  });

  it('keeps a prepared plan independent of later mutation of its input arrays', () => {
    const { env } = fixture();
    const input = plan(env);
    const mutable = [...input.enable];
    const prepared = prepareBodyBatch(env, { ...input, enable: mutable });
    mutable.splice(0);
    const result = commitPreparedBodyBatch(env, prepared);
    expect(result.projection.doc.textContent).toBe('ABQ');
    expect(documentBodyRecords(env.doc).enabled.get('batch:group')).toBe(true);
  });

  it('rejects a fresh run that reuses an existing native source', () => {
    const { env, history } = fixture();
    const input = plan(env);
    const source = Y.encodeStateAsUpdate(env.doc);
    expect(() => prepareBodyBatch(env, {
      ...input, fresh: [{ ...input.fresh[0], source: 'S:A' }],
    })).toThrow();
    expect(Y.encodeStateAsUpdate(env.doc)).toEqual(source);
    expect(history.undoStack).toHaveLength(0);
  });

  it('validates whole scalar endpoints before an observed native deletion', () => {
    const { env, history } = fixture();
    documentBodySource(env.doc, 'S:A').insert(2, '😀', { ctx: 'base' });
    const frame = project(env.doc);
    const source = Y.encodeStateAsUpdate(env.doc);
    const input: BodyBatchPlan = {
      id: 'half-surrogate', registration: {}, cuts: [],
      native: [{ kind: 'delete', ids: [frame.units[1].token] }],
      fresh: [], enable: [], expected: frame,
    };
    expect(() => prepareBodyBatch(env, input)).toThrow(/surrogate/i);
    expect(Y.encodeStateAsUpdate(env.doc)).toEqual(source);
    expect(history.undoStack).toHaveLength(0);
  });

  it('deletes observed native units without removing a permanent cut', () => {
    const { env, history } = fixture();
    const frame = project(env.doc);
    const prepared = prepareBodyBatch(env, {
      id: 'delete-A', registration: {}, cuts: [],
      native: [{ kind: 'delete', ids: [frame.units[0].token] }], fresh: [], enable: [],
      expected: {
        doc: schema.nodes['doc'].create(null, schema.nodes['paragraph'].create({ id: 'A' }, schema.text('B'))),
        units: [{ ...frame.units[1], pos: 1 }],
      },
    });
    const result = commitPreparedBodyBatch(env, prepared);
    expect(result.projection.doc.textContent).toBe('B');
    expect(documentBodySource(env.doc, 'S:A').toDelta().map((run: { readonly insert: unknown }) => run.insert)).toEqual([
      { bodyCut: 'head:A' }, 'B', { bodyCut: 'tail:A' },
    ]);
    expect(history.undoStack).toHaveLength(1);
    history.undo();
    expect(project(env.doc).doc.textContent).toBe('AB');
  });

  it('conserves every unselected identity under generated observed deletions', () => {
    fc.assert(fc.property(fc.array(fc.boolean(), { minLength: 1, maxLength: 20 }), (selected) => {
      const text = selected.map((_, index) => String.fromCharCode(65 + index)).join('');
      const { env } = fixture(text);
      const before = project(env.doc);
      const retained = before.units.filter((_, index) => !selected[index]);
      const nextText = retained.map((unit) => unit.value).join('');
      const expected = {
        doc: schema.nodes['doc'].create(null, schema.nodes['paragraph'].create({ id: 'A' }, nextText === '' ? [] : schema.text(nextText))),
        units: retained.map((unit, index) => ({ ...unit, pos: index + 1 })),
      };
      const prepared = prepareBodyBatch(env, {
        id: 'generated-delete', registration: {}, cuts: [],
        native: [{ kind: 'delete', ids: before.units.filter((_, index) => selected[index]).map((unit) => unit.token) }],
        fresh: [], enable: [], expected,
      });
      const result = commitPreparedBodyBatch(env, prepared);
      expect(result.projection.doc.toJSON()).toEqual(expected.doc.toJSON());
      expect(result.projection.units.map((unit) => unit.token)).toEqual(retained.map((unit) => unit.token));
      expect(documentBodySource(env.doc, 'S:A').length).toBe(retained.length + 2);
    }), { seed: 161941, numRuns: 100 });
  });

  it('formats only observed native units while preserving their independent context', () => {
    const { env, history } = fixture();
    const before = project(env.doc);
    const prepared = prepareBodyBatch(env, {
      id: 'format', registration: {
        groups: [{ id: 'format:group', history: 'user', facts: ['format:bold'] }],
        facts: [{ id: 'format:bold', group: 'format:group', dependencies: [], kind: 'mark', payload: { type: 'bold', attrs: {} } }],
      }, cuts: [], fresh: [], enable: ['format:group'],
      native: [{ kind: 'format', ids: [before.units[0].token], attributes: { 'mark:bold': { factId: 'format:bold' } } }],
      expected: before,
    });
    commitPreparedBodyBatch(env, prepared);
    expect(documentBodySource(env.doc, 'S:A').toDelta()).toEqual([
      { insert: { bodyCut: 'head:A' } },
      { insert: 'A', attributes: { ctx: 'base', 'mark:bold': { factId: 'format:bold' } } },
      { insert: 'B', attributes: { ctx: 'base' } },
      { insert: { bodyCut: 'tail:A' } },
    ]);
    expect(project(env.doc).units.map((unit) => unit.token)).toEqual(before.units.map((unit) => unit.token));
    expect(history.undoStack).toHaveLength(1);
    history.undo();
    expect(documentBodySource(env.doc, 'S:A').toDelta()).toEqual([
      { insert: { bodyCut: 'head:A' } }, { insert: 'AB', attributes: { ctx: 'base' } }, { insert: { bodyCut: 'tail:A' } },
    ]);
  });

  it('rejects a native formatting plan that overwrites the structural context', () => {
    const { env } = fixture();
    const before = project(env.doc);
    const source = Y.encodeStateAsUpdate(env.doc);
    expect(() => prepareBodyBatch(env, {
      id: 'invalid-context', registration: {}, cuts: [], fresh: [], enable: [], expected: before,
      native: [{ kind: 'format', ids: [before.units[0].token], attributes: { ctx: null } }],
    })).toThrow(/mark keys/i);
    expect(Y.encodeStateAsUpdate(env.doc)).toEqual(source);
  });

  it('registers a relative permanent cut before deleting adjacent observed units', () => {
    const { env, history } = fixture();
    const before = project(env.doc);
    const prepared = prepareBodyBatch(env, {
      id: 'cut-delete', registration: {},
      cuts: [{ source: 'S:A', cut: 'middle', at: Y.createRelativePositionFromTypeIndex(documentBodySource(env.doc, 'S:A'), 2, 0) }],
      native: [{ kind: 'delete', ids: before.units.map((unit) => unit.token) }], fresh: [], enable: [],
      expected: { doc: schema.nodes['doc'].create(null, schema.nodes['paragraph'].create({ id: 'A' })), units: [] },
    });
    commitPreparedBodyBatch(env, prepared);
    expect(documentBodySource(env.doc, 'S:A').toDelta()).toEqual([
      { insert: { bodyCut: 'head:A' } }, { insert: { bodyCut: 'middle' } }, { insert: { bodyCut: 'tail:A' } },
    ]);
    history.undo();
    expect(project(env.doc).doc.textContent).toBe('AB');
    expect(documentBodySource(env.doc, 'S:A').length).toBe(5);
  });
});
