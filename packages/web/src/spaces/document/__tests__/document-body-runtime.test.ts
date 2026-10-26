// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { afterEach, describe, expect, it, vi } from 'vitest';
import fc from 'fast-check';
import * as Y from 'yjs';

import { createDocumentBodyRuntime } from '@web/spaces/document/document-body-runtime';
import type {
  DocumentBodyFailure,
  DocumentBodyRuntime,
  DocumentBodyRuntimeStatus,
} from '@web/spaces/document/document-body-runtime-types';

const documents: Y.Doc[] = [];
const runtimes: DocumentBodyRuntime[] = [];

afterEach(() => {
  for (const runtime of runtimes.splice(0)) runtime.dispose();
  for (const doc of documents.splice(0)) doc.destroy();
});

/** Creates a recovery record with independently held input and projection references. @throws {never} */
function failure(phase = 'preflighting'): DocumentBodyFailure {
  return {
    phase,
    error: new Error(`${phase} failure`),
    batch: 'batch-1',
    epoch: 4,
    accepted: { text: 'oldnew' },
    selection: { from: 6, to: 6 },
    journal: [{ input: 'new' }],
    lastGood: { text: 'old' },
    writeStarted: phase === 'committing' || phase === 'publishing',
    writeReturned: phase === 'publishing',
  };
}

/** Creates an isolated production runtime and its actual source document. @throws {never} */
function fixture(status: DocumentBodyRuntimeStatus = 'active'): {
  doc: Y.Doc;
  runtime: DocumentBodyRuntime;
  report: ReturnType<typeof vi.fn>;
  originalFailure: DocumentBodyFailure;
} {
  const doc = new Y.Doc();
  const report = vi.fn();
  const runtime = createDocumentBodyRuntime(doc, report);
  const originalFailure = failure();
  documents.push(doc);
  runtimes.push(runtime);
  if (status === 'waiting') runtime.wait(['fact-1']);
  if (status === 'failed') runtime.fail(originalFailure);
  if (status === 'disposed') runtime.dispose();
  return { doc, runtime, report, originalFailure };
}

const statuses = ['active', 'waiting', 'failed', 'disposed'] as const;
const events = ['write', 'complete', 'missing', 'error', 'role-visibility', 'close', 'old-async'] as const;

describe('document body runtime', () => {
  it('starts active with a stable snapshot and an independent incarnation', () => {
    const first = fixture();
    const second = fixture();

    expect(first.runtime.read()).toEqual({ status: 'active', missing: [], failure: null });
    expect(first.runtime.read()).toBe(first.runtime.read());
    expect(Object.isFrozen(first.runtime.read())).toBe(true);
    expect(Object.isFrozen(first.runtime.read().missing)).toBe(true);
    expect(first.runtime.incarnation === second.runtime.incarnation).toBe(false);
    expect(first.runtime.revision()).toBe(0);
  });

  for (const status of statuses) {
    for (const event of events) {
      it(`handles ${event} while ${status}`, () => {
        const { runtime, originalFailure } = fixture(status);
        const nextFailure = failure('projecting');
        let expected: DocumentBodyRuntimeStatus = status;

        if (event === 'write') {
          expect(runtime.canWrite(true, runtime.incarnation)).toBe(status === 'active');
        } else if (event === 'complete') {
          runtime.resume();
          if (status === 'waiting') expected = 'active';
        } else if (event === 'missing') {
          runtime.wait(['fact-2']);
          if (status === 'active' || status === 'waiting') expected = 'waiting';
        } else if (event === 'error') {
          runtime.fail(nextFailure);
          if (status === 'active' || status === 'waiting') expected = 'failed';
        } else if (event === 'role-visibility') {
          expect(runtime.canWrite(false, runtime.incarnation)).toBe(false);
          expect(runtime.canWrite(true, runtime.incarnation)).toBe(status === 'active');
        } else if (event === 'close') {
          runtime.dispose();
          expected = 'disposed';
        } else {
          expect(runtime.canWrite(true, Symbol('old-operation'))).toBe(false);
        }

        const snapshot = runtime.read();
        expect(snapshot.status).toBe(expected);
        expect(snapshot.missing).toEqual(expected === 'waiting' ? [event === 'missing' ? 'fact-2' : 'fact-1'] : []);
        expect(snapshot.failure).toBe(expected === 'failed' ? (status === 'failed' ? originalFailure : nextFailure) : null);
      });
    }
  }

  it('publishes failed before a readonly listener can reenter a writer', () => {
    const { runtime } = fixture();
    const observed: string[] = [];
    const record = failure('committing');
    runtime.subscribe(() => {
      observed.push(runtime.read().status);
      expect(runtime.read().failure).toBe(record);
      expect(runtime.canWrite(true, runtime.incarnation)).toBe(false);
      runtime.resume();
      runtime.wait(['later-fact']);
    });

    runtime.fail(record);

    expect(observed).toEqual(['failed']);
    expect(runtime.read()).toEqual({ status: 'failed', missing: [], failure: record });
  });

  it('retains the first failure and all accepted input references', () => {
    const { runtime } = fixture();
    const first = failure('registering');
    const changes = vi.fn();
    runtime.subscribe(changes);

    runtime.fail(first);
    const snapshot = runtime.read();
    runtime.fail(failure('publishing'));
    runtime.resume();

    expect(runtime.read()).toBe(snapshot);
    expect(runtime.read().failure).toBe(first);
    expect(runtime.read().failure?.accepted).toBe(first.accepted);
    expect(runtime.read().failure?.selection).toBe(first.selection);
    expect(runtime.read().failure?.journal).toBe(first.journal);
    expect(runtime.read().failure?.lastGood).toBe(first.lastGood);
    expect(changes).toHaveBeenCalledTimes(1);
  });

  it('keeps permission and incarnation admission independent of state transitions', () => {
    const { runtime } = fixture();
    const original = runtime.read();

    expect(runtime.canWrite(false, runtime.incarnation)).toBe(false);
    expect(runtime.canWrite(true, Symbol('another-handle'))).toBe(false);
    expect(runtime.canWrite(true, runtime.incarnation)).toBe(true);
    expect(runtime.read()).toBe(original);
    runtime.wait(['fact-1']);
    expect(runtime.canWrite(true, runtime.incarnation)).toBe(false);
    runtime.resume();
    expect(runtime.canWrite(true, runtime.incarnation)).toBe(true);
  });

  it('holds a current canonical missing set and releases only the waiting state', () => {
    const { runtime } = fixture();
    const changes = vi.fn();
    runtime.subscribe(changes);
    const missing = ['source-2', 'fact-1', 'source-2'];

    runtime.wait(missing);
    missing.push('mutated-caller-array');
    const waiting = runtime.read();
    expect(waiting).toEqual({ status: 'waiting', missing: ['fact-1', 'source-2'], failure: null });
    runtime.wait(['source-2', 'fact-1']);
    expect(runtime.read()).toBe(waiting);
    runtime.wait(['cut-3']);
    expect(runtime.read()).toEqual({ status: 'waiting', missing: ['cut-3'], failure: null });
    runtime.resume();
    expect(runtime.read()).toEqual({ status: 'active', missing: [], failure: null });
    runtime.resume();
    expect(changes).toHaveBeenCalledTimes(3);
  });

  it('notifies other listeners after one listener throws', () => {
    const { runtime, report } = fixture();
    const listenerError = new Error('readonly callback failed');
    runtime.subscribe(() => { throw listenerError; });
    const remaining = vi.fn();
    runtime.subscribe(remaining);

    expect(() => runtime.fail(failure())).not.toThrow();

    expect(runtime.read().status).toBe('failed');
    expect(report).toHaveBeenCalledExactlyOnceWith(listenerError);
    expect(remaining).toHaveBeenCalledTimes(1);
  });

  it('releases subscribers and recovery references on disposal', () => {
    const { runtime } = fixture();
    const removed = vi.fn();
    const release = runtime.subscribe(removed);
    release();
    release();
    const observed: string[] = [];
    runtime.subscribe(() => observed.push(runtime.read().status));
    runtime.fail(failure());

    runtime.dispose();
    const disposed = runtime.read();
    runtime.wait(['fact']);
    runtime.resume();
    runtime.fail(failure('projecting'));
    runtime.dispose();
    runtime.subscribe(removed);

    expect(runtime.read()).toBe(disposed);
    expect(disposed).toEqual({ status: 'disposed', missing: [], failure: null });
    expect(removed).toHaveBeenCalledTimes(0);
    expect(observed).toEqual(['failed', 'disposed']);
    expect(runtime.canWrite(true, runtime.incarnation)).toBe(false);
  });

  it('counts source deletion and updates through a failed view, then detaches on disposal', () => {
    const { doc, runtime } = fixture();
    const text = doc.getText('source');
    const sourceChanges = vi.fn();
    doc.on('update', sourceChanges);
    text.insert(0, 'abc');
    const vector = Y.encodeStateVector(doc);
    const bytes = Y.encodeStateAsUpdate(doc);
    expect(runtime.revision()).toBe(1);
    text.delete(1, 1);
    expect(Y.encodeStateVector(doc)).toEqual(vector);
    expect([...Y.encodeStateAsUpdate(doc)]).not.toEqual([...bytes]);
    expect(runtime.revision()).toBe(2);
    runtime.fail(failure());
    text.insert(2, '_PEER');
    expect(runtime.revision()).toBe(3);
    expect(text.toString()).toBe('ac_PEER');

    runtime.dispose();
    text.insert(7, '!');

    expect(runtime.revision()).toBe(3);
    expect(sourceChanges).toHaveBeenCalledTimes(4);
    expect(text.toString()).toBe('ac_PEER!');
  });

  it('keeps a retired incarnation separate when the same source is reopened', () => {
    const { doc, runtime } = fixture();
    const previous = runtime.incarnation;
    runtime.dispose();
    const reopened = createDocumentBodyRuntime(doc, vi.fn());
    runtimes.push(reopened);

    expect(reopened.canWrite(true, previous)).toBe(false);
    expect(reopened.canWrite(true, reopened.incarnation)).toBe(true);
    expect(runtime.canWrite(true, previous)).toBe(false);
  });

  it('maintains sticky failure and admission across generated event sequences', () => {
    fc.assert(fc.property(
      fc.array(fc.constantFrom('wait', 'resume', 'fail', 'dispose', 'write', 'update'), { maxLength: 60 }),
      (commands) => {
        const doc = new Y.Doc();
        const runtime = createDocumentBodyRuntime(doc, vi.fn());
        const first = failure();
        let model: DocumentBodyRuntimeStatus = 'active';
        let revision = 0;
        try {
          for (const command of commands) {
            if (command === 'wait') {
              runtime.wait(['pending-fact']);
              if (model === 'active' || model === 'waiting') model = 'waiting';
            } else if (command === 'resume') {
              runtime.resume();
              if (model === 'waiting') model = 'active';
            } else if (command === 'fail') {
              runtime.fail(first);
              if (model !== 'disposed') model = 'failed';
            } else if (command === 'dispose') {
              runtime.dispose();
              model = 'disposed';
            } else if (command === 'update') {
              doc.getText('source').insert(0, 'x');
              if (model !== 'disposed') revision += 1;
            }

            expect(runtime.read().status).toBe(model);
            expect(runtime.read().failure).toBe(model === 'failed' ? first : null);
            expect(runtime.canWrite(true, runtime.incarnation)).toBe(model === 'active');
            expect(runtime.canWrite(false, runtime.incarnation)).toBe(false);
            expect(runtime.canWrite(true, Symbol('old-incarnation'))).toBe(false);
            expect(runtime.revision()).toBe(revision);
          }
        } finally {
          runtime.dispose();
          doc.destroy();
        }
      },
    ), { seed: 161926, numRuns: 200 });
  });
});
