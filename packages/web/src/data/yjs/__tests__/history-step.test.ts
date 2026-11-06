// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * Space size cap (inner#1790): what the next undo or redo does to the size.
 *
 * `Y.UndoManager` pops stack items until one changes something, so the
 * judgement is about that item, not the top one. Each case runs the real undo
 * manager afterwards and checks the judgement against what it did: a step
 * judged `delete` writes no new item, any other kind writes at least one, and
 * the estimate covers the content it wrote.
 */

import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import * as Y from 'yjs';

import { nextHistoryStep } from '@web/data/yjs/history-step';

const ORIGIN = 'test-undo';

/** Two documents kept in sync, the first with an undo manager over `nodes`. */
interface Pair {
  a: Y.Doc;
  b: Y.Doc;
  nodes: Y.Map<Y.Map<unknown>>;
  peer: Y.Map<Y.Map<unknown>>;
  um: Y.UndoManager;
}

/**
 * Two synced documents.
 * @returns The pair.
 */
function pair(): Pair {
  const a = new Y.Doc();
  const b = new Y.Doc();
  a.on('update', (u: Uint8Array, o: unknown) => { if (o !== 'remote') Y.applyUpdate(b, u, 'remote'); });
  b.on('update', (u: Uint8Array, o: unknown) => { if (o !== 'remote') Y.applyUpdate(a, u, 'remote'); });
  const nodes = a.getMap<Y.Map<unknown>>('nodes');
  const um = new Y.UndoManager([nodes], { trackedOrigins: new Set([ORIGIN]), captureTimeout: 0 });
  return { a, b, nodes, peer: b.getMap<Y.Map<unknown>>('nodes'), um };
}

/**
 * A node map with one content field.
 * @param content - The content.
 * @returns The map, not attached yet.
 */
function node(content: string): Y.Map<unknown> {
  const m = new Y.Map<unknown>();
  m.set('content', content);
  return m;
}

/**
 * Run an undo or redo and report what it wrote.
 * @param p - The pair.
 * @param direction - Which stack.
 * @returns Whether it wrote new items, and the UTF-8 bytes of their content.
 */
function run(p: Pair, direction: 'undo' | 'redo'): { wrote: boolean; contentBytes: number } {
  const sv = Y.encodeStateVector(p.a);
  const clock = Y.getState(p.a.store, p.a.clientID);
  if (direction === 'undo') p.um.undo();
  else p.um.redo();
  let contentBytes = 0;
  for (const s of Y.decodeUpdate(Y.encodeStateAsUpdate(p.a, sv)).structs) {
    if (s instanceof Y.Item && s.id.client === p.a.clientID) {
      contentBytes += new TextEncoder().encode(JSON.stringify(s.content.getContent()) ?? '').byteLength;
    }
  }
  return { wrote: Y.getState(p.a.store, p.a.clientID) > clock, contentBytes };
}

describe('nextHistoryStep', () => {
  it('judges an empty stack as a delete with nothing to add', () => {
    const p = pair();
    expect(nextHistoryStep(p.um, 'undo')).toEqual({ kind: 'delete', estimate: 0 });
    expect(nextHistoryStep(p.um, 'redo')).toEqual({ kind: 'delete', estimate: 0 });
  });

  it('judges undoing a creation as a delete', () => {
    const p = pair();
    p.a.transact(() => p.nodes.set('n', node('hello')), ORIGIN);
    expect(nextHistoryStep(p.um, 'undo')).toEqual({ kind: 'delete', estimate: 0 });
    expect(run(p, 'undo').wrote).toBe(false);
  });

  it('judges undoing a deletion as an add that covers the content brought back', () => {
    const p = pair();
    p.a.transact(() => p.nodes.set('n', node('x'.repeat(5000))), 'setup');
    p.a.transact(() => p.nodes.delete('n'), ORIGIN);
    const step = nextHistoryStep(p.um, 'undo');
    expect(step.kind).toBe('add');
    const ran = run(p, 'undo');
    expect(ran.wrote).toBe(true);
    expect(step.estimate).toBeGreaterThanOrEqual(ran.contentBytes);
    expect(step.estimate).toBeGreaterThanOrEqual(5000);
  });

  it('judges undoing a move as an overwrite', () => {
    const p = pair();
    p.a.transact(() => p.nodes.set('n', node('a')), 'setup');
    p.a.transact(() => p.nodes.get('n')!.set('x', 10), 'setup');
    p.a.transact(() => p.nodes.get('n')!.set('x', 20), ORIGIN);
    expect(nextHistoryStep(p.um, 'undo').kind).toBe('overwrite');
    expect(run(p, 'undo').wrote).toBe(true);
  });

  it('judges undoing the removal of a key as an add', () => {
    const p = pair();
    p.a.transact(() => p.nodes.set('n', node('a')), 'setup');
    p.a.transact(() => p.nodes.get('n')!.set('bg', '#fff'), 'setup');
    p.a.transact(() => p.nodes.get('n')!.delete('bg'), ORIGIN);
    expect(nextHistoryStep(p.um, 'undo').kind).toBe('add');
  });

  it('skips a top step a peer already undid and judges the one below, as yjs runs it', () => {
    const p = pair();
    p.a.transact(() => p.nodes.set('X', node('x'.repeat(200_000))), 'setup');
    p.a.transact(() => p.nodes.delete('X'), ORIGIN);
    p.a.transact(() => p.nodes.set('Y', node('y')), ORIGIN);
    // The peer deletes Y: undoing its creation has nothing left to do.
    p.peer.delete('Y');
    const step = nextHistoryStep(p.um, 'undo');
    expect(step.kind).toBe('add');
    expect(step.estimate).toBeGreaterThanOrEqual(200_000);
    const ran = run(p, 'undo');
    expect(p.nodes.has('X')).toBe(true);
    expect(step.estimate).toBeGreaterThanOrEqual(ran.contentBytes);
  });

  it('skips a top step whose key a peer wrote since, and judges the delete below', () => {
    const p = pair();
    p.a.transact(() => p.nodes.set('Z', node('z')), ORIGIN);
    p.a.transact(() => p.nodes.set('K', node('k')), 'setup');
    p.a.transact(() => p.nodes.delete('K'), ORIGIN);
    // The peer writes K again: bringing the old K back conflicts and yjs skips it.
    p.peer.set('K', node('peer'));
    expect(nextHistoryStep(p.um, 'undo')).toEqual({ kind: 'delete', estimate: 0 });
    expect(run(p, 'undo').wrote).toBe(false);
    expect(p.nodes.has('Z')).toBe(false);
  });

  it('agrees with what the undo manager does, for any edits by the writer and a peer', () => {
    type Op =
      | { who: 'a' | 'b'; op: 'set'; key: number; content: string }
      | { who: 'a' | 'b'; op: 'del'; key: number }
      | { who: 'a' | 'b'; op: 'field'; key: number; value: number }
      | { who: 'a'; op: 'undo' }
      | { who: 'a'; op: 'redo' };
    const key = fc.integer({ min: 0, max: 3 });
    const who = fc.constantFrom<'a' | 'b'>('a', 'a', 'b');
    const op: fc.Arbitrary<Op> = fc.oneof(
      fc.record({ who, op: fc.constant('set' as const), key, content: fc.string({ maxLength: 40 }) }),
      fc.record({ who, op: fc.constant('del' as const), key }),
      fc.record({ who, op: fc.constant('field' as const), key, value: fc.integer() }),
      fc.record({ who: fc.constant('a' as const), op: fc.constant('undo' as const) }),
      fc.record({ who: fc.constant('a' as const), op: fc.constant('redo' as const) }),
    );
    fc.assert(fc.property(fc.array(op, { maxLength: 14 }), fc.constantFrom<'undo' | 'redo'>('undo', 'redo'), (ops, direction) => {
      const p = pair();
      for (const o of ops) {
        if (o.op === 'undo') { p.um.undo(); continue; }
        if (o.op === 'redo') { p.um.redo(); continue; }
        const doc = o.who === 'a' ? p.a : p.b;
        const map = o.who === 'a' ? p.nodes : p.peer;
        const k = `n${o.key}`;
        doc.transact(() => {
          if (o.op === 'set') map.set(k, node(o.content));
          else if (o.op === 'del') map.delete(k);
          else map.get(k)?.set('x', o.value);
        }, o.who === 'a' ? ORIGIN : 'peer');
      }
      const step = nextHistoryStep(p.um, direction);
      const ran = run(p, direction);
      expect(step.kind !== 'delete').toBe(ran.wrote);
      expect(step.estimate).toBeGreaterThanOrEqual(ran.contentBytes);
    }), { numRuns: 500 });
  });
});
