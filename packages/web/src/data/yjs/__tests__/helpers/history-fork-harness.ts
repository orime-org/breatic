// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * Space document size cap, second design (inner#1790): what web test spec
 * section 14 compares for undo and redo.
 *
 * The "real kind" of a step is read off what the undo manager really writes:
 * the local updates of the call, merged, judged by shared `updateShape`
 * against a `gc: false` copy of the document taken just before (spec 0.4:
 * `S` is an add, `D` a delete, `R` a remove, nothing written is no effect).
 * The "trial kind" is what `nextHistoryStep` answers under a full Space.
 *
 * `nextHistoryStep` returns the kind itself (spec section 14): a step
 * that writes nothing (an empty stack, a trial that wrote nothing, a scope the
 * real document deleted) is `remove`, which every state but `resyncing` lets
 * through, so the entry still calls `undo()`/`redo()` (spec answer Q8); a
 * trial that throws or cannot find its scope is `add`. Every entry runs the
 * step through `runHistoryStep`.
 *
 * Copies of the document are counted the way spec 21.5 observes them: a file
 * that mocks `yjs` with `encodeStateAsUpdate` wrapped in `vi.fn` (passing
 * through) can read how often the real document was encoded (`copiesOf`).
 */

import { vi, type MockInstance } from 'vitest';
import * as Y from 'yjs';
import { updateShape } from '@breatic/shared';

import { setDocSize, startDocResync } from '@web/data/yjs/doc-size';
import { nextHistoryStep, runHistoryStep } from '@web/data/yjs/history-step';
import type { SpaceWriteResult } from '@web/data/yjs/space-write';
import type { DocSizePushV2 } from '@web/data/yjs/__tests__/helpers/size-v2-fixtures';

/** What one undo or redo does, in the spec's shape vocabulary. */
export type StepKind = 'add' | 'delete' | 'remove' | 'none';

/** Which stack runs. */
export type Direction = 'undo' | 'redo';

/**
 * Puts a document in the state a push describes (the v2 single writer).
 * @param name - Canonical document name.
 * @param push - The fixture.
 * @throws {never} Never.
 */
export function enterSize(name: string, push: DocSizePushV2): void {
  setDocSize(name, { type: 'doc:size', seq: 1, ...push });
}

/**
 * Puts a document into the rebuild after a refusal.
 * @param name - Canonical document name.
 * @throws {never} Never.
 */
export function enterResync(name: string): void {
  startDocResync(name);
}

/**
 * Runs something and returns the local updates the document emitted, merged.
 * @param doc - The document.
 * @param run - What to run.
 * @returns The merged update, or null when nothing local was written.
 * @throws {Error} Whatever `run` throws.
 */
export function localUpdate(doc: Y.Doc, run: () => void): Uint8Array | null {
  const updates: Uint8Array[] = [];
  const onUpdate = (update: Uint8Array, _origin: unknown, _doc: Y.Doc, tr: Y.Transaction): void => {
    if (tr.local) updates.push(update);
  };
  doc.on('update', onUpdate);
  try {
    run();
  } finally {
    doc.off('update', onUpdate);
  }
  return updates.length === 0 ? null : Y.mergeUpdates(updates);
}

/**
 * Judges a merged update by spec 0.4.
 * @param update - The update, or null for none.
 * @param mirror - A `gc: false` copy of the document from before the update.
 * @returns Its kind.
 */
export function shapeKind(update: Uint8Array | null, mirror: Y.Doc): StepKind {
  if (update === null) return 'none';
  const shape = updateShape(update, mirror.store);
  if (!shape.pureDelete) return 'add';
  return shape.wholeTypesOnly ? 'remove' : 'delete';
}

/**
 * A `gc: false` copy of a document, for judging the next update against.
 * @param doc - The document.
 * @returns The copy.
 */
export function mirrorOf(doc: Y.Doc): Y.Doc {
  const mirror = new Y.Doc({ gc: false });
  Y.applyUpdate(mirror, Y.encodeStateAsUpdate(doc));
  return mirror;
}

/**
 * Runs something on a document and judges what it wrote.
 * @param doc - The document.
 * @param run - The write.
 * @returns The kind of what it wrote.
 * @throws {Error} Whatever `run` throws.
 */
export function kindOf(doc: Y.Doc, run: () => void): StepKind {
  const mirror = mirrorOf(doc);
  return shapeKind(localUpdate(doc, run), mirror);
}

/**
 * Runs the undo manager itself (no gate) and judges what it wrote.
 * @param manager - The undo manager.
 * @param direction - Which stack.
 * @returns The real kind.
 */
export function realKind(manager: Y.UndoManager, direction: Direction): StepKind {
  return kindOf(manager.doc, () => { manager[direction](); });
}

/**
 * The trial kind `nextHistoryStep` answers.
 * @param manager - The undo manager.
 * @param direction - Which stack.
 * @returns The kind; a step without effect is `remove`.
 */
export function trialKind(manager: Y.UndoManager, direction: Direction): StepKind {
  return nextHistoryStep(manager, direction) as StepKind;
}

/**
 * The trial kind a real kind must be judged as: a real step that wrote
 * nothing is judged `remove` (design 5.2, line 204).
 * @param real - What the real step wrote.
 * @returns The kind `nextHistoryStep` must answer.
 */
export function trialFor(real: StepKind): StepKind {
  return real === 'none' ? 'remove' : real;
}

/**
 * Runs an undo or redo the way every entry does (design 5.2, line 205):
 * `runHistoryStep` judges it and runs it through `writeSpaceDoc`.
 * @param name - Canonical document name.
 * @param manager - The undo manager.
 * @param direction - Which stack.
 * @returns What `writeSpaceDoc` answered.
 */
export function gatedStep(name: string, manager: Y.UndoManager, direction: Direction): SpaceWriteResult {
  return runHistoryStep(name, manager, direction);
}

/**
 * The wrapped `encodeStateAsUpdate` of a file that mocks `yjs` (spec 21.5).
 * @returns Its mock.
 * @throws {Error} When the calling file did not mock it.
 */
function encodeMock(): MockInstance {
  const encode: unknown = Y.encodeStateAsUpdate;
  if (!vi.isMockFunction(encode)) throw new Error('mock yjs with encodeStateAsUpdate wrapped in vi.fn to count copies');
  return encode;
}

/**
 * Starts counting copies of documents afresh.
 * @throws {Error} When the calling file did not mock `yjs`.
 */
export function resetCopies(): void {
  encodeMock().mockClear();
}

/**
 * How often a document was encoded since `resetCopies`: each is one copy a
 * trial made of it (spec 21.5).
 * @param doc - The real document.
 * @returns The count.
 * @throws {Error} When the calling file did not mock `yjs`.
 */
export function copiesOf(doc: Y.Doc): number {
  return encodeMock().mock.calls.filter(([encoded]) => encoded === doc).length;
}

/** Records which undo managers `undo` and `redo` ran on. */
export interface StepSpies {
  undo: MockInstance;
  redo: MockInstance;
  /** Every manager either method ran on, in order. */
  contexts: () => Y.UndoManager[];
  restore: () => void;
}

/**
 * Spies on `Y.UndoManager.prototype.undo` and `redo`, calling through.
 * @returns The spies.
 */
export function spyOnSteps(): StepSpies {
  const undo = vi.spyOn(Y.UndoManager.prototype, 'undo');
  const redo = vi.spyOn(Y.UndoManager.prototype, 'redo');
  return {
    undo,
    redo,
    contexts: () => [...undo.mock.contexts, ...redo.mock.contexts] as Y.UndoManager[],
    restore: () => { undo.mockRestore(); redo.mockRestore(); },
  };
}

/**
 * Whether an undo or redo ran on a manager over another document than this
 * one: the trial on the copy (design 5.2).
 * @param spies - The spies.
 * @param doc - The real document.
 * @returns True when a trial ran.
 */
export function trialRan(spies: StepSpies, doc: Y.Doc): boolean {
  return spies.contexts().some((manager) => manager.doc !== doc);
}

/**
 * Every item's `redone` pointer, for checking a trial left them alone.
 * @param doc - The document.
 * @returns `client:clock` to the pointer, as text.
 */
export function redoneMap(doc: Y.Doc): Map<string, string> {
  const out = new Map<string, string>();
  doc.store.clients.forEach((structs) => {
    for (const struct of structs) {
      if (struct instanceof Y.Item && struct.redone !== null) {
        out.set(`${struct.id.client}:${struct.id.clock}+${struct.length}`, `${struct.redone.client}:${struct.redone.clock}`);
      }
    }
  });
  return out;
}

/**
 * A peer replica kept in sync both ways, as the provider relays updates
 * (origin `remote` on arrival, so no local undo manager tracks it).
 * @param doc - The local document.
 * @returns The peer.
 */
export function peerOf(doc: Y.Doc): Y.Doc {
  const peer = new Y.Doc();
  Y.applyUpdate(peer, Y.encodeStateAsUpdate(doc), 'remote');
  doc.on('update', (update: Uint8Array, origin: unknown) => { if (origin !== 'remote') Y.applyUpdate(peer, update, 'remote'); });
  peer.on('update', (update: Uint8Array, origin: unknown) => { if (origin !== 'remote') Y.applyUpdate(doc, update, 'remote'); });
  return peer;
}
