// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * Space document size cap, second design (inner#1790), web test spec P-01 and
 * P-02: over random edit histories, the kind `nextHistoryStep` judges on a
 * copy of the document equals what the real undo or redo writes, and what a
 * full Space lets through only deletes.
 *
 * Three scopes: a root `Y.Text`, a root `Y.Map`, and an `Y.XmlFragment`
 * nested in a `Y.Map` (the shape of a canvas node's body). A peer replica
 * relays both ways, as the provider does.
 *
 * Round 6 (P-01): `nextHistoryStep` returns the kind itself, a real step that
 * writes nothing is judged `remove`, an empty stack is judged too (without a
 * trial), and a second judgement with nothing changed in between (the reused
 * conclusion) must equal the real kind as well.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fc from 'fast-check';
import * as Y from 'yjs';

vi.mock('@web/lib/toast', () => ({
  toast: {
    warning: vi.fn(), error: vi.fn(), success: vi.fn(), info: vi.fn(),
    loading: vi.fn(), promise: vi.fn(), dismiss: vi.fn(), custom: vi.fn(),
  },
  muteToasts: vi.fn(),
  _unmuteToastsForTests: vi.fn(),
}));

import { changeLocale } from '@web/i18n/locale-bootstrap';
import { clearAllDocSizes } from '@web/data/yjs/doc-size';
import { docName, getDoc, _resetForTests } from '@web/data/yjs/manager';
import {
  enterSize,
  gatedStep,
  localUpdate,
  mirrorOf,
  realKind,
  shapeKind,
  trialFor,
  trialKind,
  type Direction,
  type StepKind,
} from '@web/data/yjs/__tests__/helpers/history-fork-harness';
import { P_FULL, P_OVER } from '@web/data/yjs/__tests__/helpers/size-v2-fixtures';

const NAME = docName.canvasSpace('p1', 's1');
const TRACKED = Symbol('tracked');
const UNTRACKED = 'untracked';

type Scope = 'text' | 'map' | 'nested';

type Op =
  | { op: 'insert'; at: number; text: string }
  | { op: 'delete'; at: number; len: number }
  | { op: 'set'; key: number; value: string }
  | { op: 'unset'; key: number }
  | { op: 'peerDelete'; at: number }
  | { op: 'untracked'; at: number; text: string }
  | { op: 'step'; direction: Direction };

/** One random history's document, peer and manager. */
interface World {
  doc: Y.Doc;
  peer: Y.Doc;
  manager: Y.UndoManager;
  /** The text the text operations edit, on this replica and on the peer. */
  text: (doc: Y.Doc) => Y.Text | Y.XmlText;
  /** Sets or removes a key in the scope, on this replica or on the peer. */
  setKey: (doc: Y.Doc, key: string, value: string | null) => void;
}

/**
 * A fresh registered document with the scope seeded, its peer and its manager.
 * @param scope - Which scope.
 * @returns The world.
 */
function world(scope: Scope): World {
  _resetForTests();
  clearAllDocSizes();
  const doc = getDoc(NAME);
  if (scope === 'text') {
    doc.transact(() => { doc.getText('t').insert(0, 'seed'); }, 'setup');
  } else if (scope === 'map') {
    doc.transact(() => {
      const map = doc.getMap<unknown>('m');
      map.set('k0', 'a');
      map.set('text', new Y.Text('seed'));
    }, 'setup');
  } else {
    doc.transact(() => {
      const node = new Y.Map<unknown>();
      const body = new Y.XmlFragment();
      doc.getMap<unknown>('nodesMap').set('n1', node);
      node.set('body', body);
      const paragraph = new Y.XmlElement('paragraph');
      body.insert(0, [paragraph]);
      paragraph.insert(0, [new Y.XmlText('seed')]);
    }, 'setup');
  }
  const peer = new Y.Doc();
  Y.applyUpdate(peer, Y.encodeStateAsUpdate(doc), 'remote');
  doc.on('update', (u: Uint8Array, origin: unknown) => { if (origin !== 'remote') Y.applyUpdate(peer, u, 'remote'); });
  peer.on('update', (u: Uint8Array, origin: unknown) => { if (origin !== 'remote') Y.applyUpdate(doc, u, 'remote'); });
  const body = (d: Y.Doc): Y.XmlFragment => (d.getMap<Y.Map<unknown>>('nodesMap').get('n1')!.get('body') as Y.XmlFragment);
  const paragraph = (d: Y.Doc): Y.XmlElement => body(d).get(0) as Y.XmlElement;
  const text = scope === 'text'
    ? (d: Y.Doc): Y.Text => d.getText('t')
    : scope === 'map'
      ? (d: Y.Doc): Y.Text => d.getMap<unknown>('m').get('text') as Y.Text
      : (d: Y.Doc): Y.XmlText => paragraph(d).get(0) as Y.XmlText;
  const setKey = scope === 'nested'
    ? (d: Y.Doc, key: string, value: string | null): void => {
      if (value === null) paragraph(d).removeAttribute(key);
      else paragraph(d).setAttribute(key, value);
    }
    : (d: Y.Doc, key: string, value: string | null): void => {
      const map = scope === 'map' ? d.getMap<unknown>('m') : d.getMap<unknown>('side');
      if (value === null) map.delete(key);
      else map.set(key, value);
    };
  const scopeType = scope === 'text' ? doc.getText('t') : scope === 'map' ? doc.getMap('m') : body(doc);
  const manager = new Y.UndoManager(scopeType, { trackedOrigins: new Set([TRACKED]), captureTimeout: 0 });
  return { doc, peer, manager, text, setKey };
}

/**
 * Applies one non-step operation.
 * @param w - The world.
 * @param o - The operation.
 */
function apply(w: World, o: Exclude<Op, { op: 'step' }>): void {
  const text = w.text(w.doc);
  switch (o.op) {
    case 'insert':
      w.doc.transact(() => { text.insert(Math.min(o.at, text.length), o.text); }, TRACKED);
      return;
    case 'delete': {
      if (text.length === 0) return;
      const at = Math.min(o.at, text.length - 1);
      w.doc.transact(() => { text.delete(at, Math.min(o.len, text.length - at)); }, TRACKED);
      return;
    }
    case 'set':
      w.doc.transact(() => { w.setKey(w.doc, `k${o.key}`, o.value); }, TRACKED);
      return;
    case 'unset':
      w.doc.transact(() => { w.setKey(w.doc, `k${o.key}`, null); }, TRACKED);
      return;
    case 'peerDelete': {
      const peerText = w.text(w.peer);
      if (peerText.length === 0) return;
      w.peer.transact(() => { peerText.delete(Math.min(o.at, peerText.length - 1), 1); });
      return;
    }
    case 'untracked':
      w.doc.transact(() => { text.insert(Math.min(o.at, text.length), o.text); }, UNTRACKED);
      return;
  }
}

const letters = fc.stringMatching(/^[a-h]{1,4}$/);
const position = fc.integer({ min: 0, max: 12 });
const op: fc.Arbitrary<Op> = fc.oneof(
  { weight: 3, arbitrary: fc.record({ op: fc.constant('insert' as const), at: position, text: letters }) },
  { weight: 2, arbitrary: fc.record({ op: fc.constant('delete' as const), at: position, len: fc.integer({ min: 1, max: 3 }) }) },
  { weight: 1, arbitrary: fc.record({ op: fc.constant('set' as const), key: fc.integer({ min: 0, max: 2 }), value: letters }) },
  { weight: 1, arbitrary: fc.record({ op: fc.constant('unset' as const), key: fc.integer({ min: 0, max: 2 }) }) },
  { weight: 1, arbitrary: fc.record({ op: fc.constant('peerDelete' as const), at: position }) },
  { weight: 1, arbitrary: fc.record({ op: fc.constant('untracked' as const), at: position, text: letters }) },
  { weight: 4, arbitrary: fc.record({ op: fc.constant('step' as const), direction: fc.constantFrom<Direction>('undo', 'redo') }) },
);
const history = fc.array(op, { minLength: 1, maxLength: 14 });
const scopes = fc.constantFrom<Scope>('text', 'map', 'nested');

beforeEach(() => {
  changeLocale('en');
});

afterEach(() => {
  clearAllDocSizes();
  _resetForTests();
});

describe('P-01 the trial kind equals the real kind', () => {
  it('P-01 before every undo or redo of a random history, the full-Space trial and its reused conclusion match what the real step writes', () => {
    fc.assert(fc.property(scopes, history, (scope, ops) => {
      const w = world(scope);
      for (const o of ops) {
        if (o.op !== 'step') {
          apply(w, o);
          continue;
        }
        enterSize(NAME, P_FULL);
        const trial = trialKind(w.manager, o.direction);
        // Nothing changed since: the manager's reused conclusion.
        const reused = trialKind(w.manager, o.direction);
        // The real step runs on the manager itself, ungated.
        const real = realKind(w.manager, o.direction);
        expect(trial).toBe(trialFor(real));
        expect(reused).toBe(trialFor(real));
      }
    }), { numRuns: 1000 });
  });
});

describe('P-02 a full Space lets through only deletions', () => {
  it('P-02 every step let through writes a delete or a remove when full, only a remove over the ceiling; a refused step writes nothing', () => {
    fc.assert(fc.property(scopes, history, fc.constantFrom('full', 'over'), (scope, ops, state) => {
      const w = world(scope);
      const allowed: ReadonlyArray<StepKind> = state === 'full' ? ['delete', 'remove', 'none'] : ['remove', 'none'];
      for (const o of ops) {
        if (o.op !== 'step') {
          apply(w, o);
          continue;
        }
        enterSize(NAME, state === 'full' ? P_FULL : P_OVER);
        const before = Y.encodeStateAsUpdate(w.doc);
        const lengths = [w.manager.undoStack.length, w.manager.redoStack.length];
        const mirror = mirrorOf(w.doc);
        let result: { ok: boolean } = { ok: false };
        const update = localUpdate(w.doc, () => { result = gatedStep(NAME, w.manager, o.direction); });
        if (result.ok) {
          expect(allowed).toContain(shapeKind(update, mirror));
        } else {
          expect(update).toBeNull();
          expect(Y.encodeStateAsUpdate(w.doc)).toEqual(before);
          expect([w.manager.undoStack.length, w.manager.redoStack.length]).toEqual(lengths);
        }
      }
    }), { numRuns: 1000 });
  });
});
