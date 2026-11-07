// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * Space document size cap, second version (inner#1790 v2 web test spec,
 * section 0): the push fixtures, the copy literals, the size states a case
 * runs in, the shape of what a write sent (S, D, R, empty) and the row
 * template `T(kind)` every write entry is expanded by.
 *
 * Values are written out, never computed from the implementation. The size
 * state is set through `setDocSize`, the one writer the provider's stateless
 * subscription calls (spec 0.4 allows it outside section 1). Install
 * `vi.mock('@web/lib/toast', ...)` in the test file before importing this
 * module: the row template reads the mocked `toast.warning`.
 */

import { expect, it } from 'vitest';
import * as Y from 'yjs';

import { updateShape } from '@breatic/shared';
import { setDocSize, startDocResync } from '@web/data/yjs/doc-size';
import type { SpaceWriteKind } from '@web/data/yjs/space-write';
import { toast } from '@web/lib/toast';

import * as F from '@web/data/yjs/__tests__/helpers/size-v2-fixtures';

/** One `doc:size` push as collab sends it (design 3: five fields and the type). */
export type SizePush = { type: 'doc:size'; bytes: number; limit: number; ceiling: number; phase: 'normal' | 'warning' | 'full' };

export const P_NORMAL: SizePush = { type: 'doc:size', ...F.P_NORMAL };
export const P_WARNING: SizePush = { type: 'doc:size', ...F.P_WARNING };
export const P_FULL: SizePush = { type: 'doc:size', ...F.P_FULL };
export const P_FULL_EDGE: SizePush = { type: 'doc:size', ...F.P_FULL_EDGE };
export const P_CEIL: SizePush = { type: 'doc:size', ...F.P_CEIL };
export const P_OVER: SizePush = { type: 'doc:size', ...F.P_OVER };
export const P_UNLIMITED: SizePush = { type: 'doc:size', ...F.P_UNLIMITED };
export const P_UNLIMITED_FULL: SizePush = { type: 'doc:size', ...F.P_UNLIMITED_FULL };

/** The size-cap sentences of spec 0.5, English (demo `COPY.en`). */
export const SIZE_COPY_EN = F.COPY_V2_EN;

/** The same sentences, Simplified Chinese (design 5.5). */
export const SIZE_COPY_ZH_CN = F.COPY_V2_ZH_CN;

/**
 * The state codes of spec 0.3: `U` never pushed, `N`/`W`/`F`/`O` the pushes,
 * `F_EDGE` one byte under the ceiling, `CEIL` exactly at it, `Z` resyncing
 * after a refusal.
 */
export type SizeCode = 'U' | 'N' | 'W' | 'F' | 'F_EDGE' | 'O' | 'CEIL' | 'Z';

const PUSH_OF: Record<Exclude<SizeCode, 'U' | 'Z'>, SizePush> = {
  N: P_NORMAL,
  W: P_WARNING,
  F: P_FULL,
  F_EDGE: P_FULL_EDGE,
  O: P_OVER,
  CEIL: P_CEIL,
};

/**
 * Puts a document in one size state. `Z` is a normal Space whose update was
 * refused, so a write held back there is held back by the rebuild alone.
 * @param name - Canonical document name.
 * @param code - The state.
 * @throws {TypeError} While the v2 writer is missing.
 */
export function enterSize(name: string, code: SizeCode): void {
  if (code === 'U') return;
  if (code === 'Z') {
    setDocSize(name, P_NORMAL);
    startDocResync(name);
    return;
  }
  setDocSize(name, PUSH_OF[code]);
}

/**
 * Delivers one push to a document (the same writer as {@link enterSize}).
 * @param name - Canonical document name.
 * @param push - The push.
 * @throws {TypeError} While the v2 writer is missing.
 */
export function pushSize(name: string, push: SizePush): void {
  setDocSize(name, push);
}

/**
 * Loads content into a document the way a peer's content arrives, so the
 * writes that built it are not this client's (spec 0.1, 0.4).
 * @param target - The registered document.
 * @param build - Writes the content into a separate source document.
 * @throws {Error} Whatever `build` throws.
 */
export function loadRemote(target: Y.Doc, build: (source: Y.Doc) => void): void {
  const source = new Y.Doc();
  build(source);
  Y.applyUpdate(target, Y.encodeStateAsUpdate(source), 'remote');
  source.destroy();
}

/** What a write sent, in the notation of spec 0.4. */
export type WriteShape = 'S' | 'D' | 'R' | '∅';

/** One write, what it returned and what it sent. */
export interface CapturedWrite<T> {
  result: T;
  shape: WriteShape;
  /** The merged local updates, or null when there were none. */
  update: Uint8Array | null;
  /** Whether the document's state changed at all. */
  changed: boolean;
}

/**
 * The structure table before a write and the listener collecting its local
 * updates.
 * @param doc - The document written.
 * @returns A finisher that stops collecting and classifies.
 */
function startCapture(doc: Y.Doc): () => { shape: WriteShape; update: Uint8Array | null; changed: boolean } {
  const mirror = new Y.Doc({ gc: false });
  const before = Y.encodeStateAsUpdate(doc);
  Y.applyUpdate(mirror, before);
  const updates: Uint8Array[] = [];
  /**
   * Keeps this client's updates.
   * @param update - The update.
   * @param _origin - Its origin.
   * @param _doc - The document.
   * @param transaction - The transaction.
   */
  const onUpdate = (update: Uint8Array, _origin: unknown, _doc: Y.Doc, transaction: Y.Transaction): void => {
    if (transaction.local) updates.push(update);
  };
  doc.on('update', onUpdate);
  return () => {
    doc.off('update', onUpdate);
    const changed = !bytesEqual(before, Y.encodeStateAsUpdate(doc));
    if (updates.length === 0) {
      mirror.destroy();
      return { shape: '∅', update: null, changed };
    }
    const update = Y.mergeUpdates(updates);
    const shape = updateShape(update, mirror.store);
    mirror.destroy();
    if (!shape.pureDelete) return { shape: 'S', update, changed };
    return { shape: shape.wholeTypesOnly ? 'R' : 'D', update, changed };
  };
}

/**
 * Byte-wise equality.
 * @param a - First.
 * @param b - Second.
 * @returns Whether they are equal.
 */
function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

/**
 * Runs a write and classifies what it sent (spec 0.4).
 * @param doc - The document written.
 * @param run - The write.
 * @returns Its result and shape.
 * @throws {Error} Whatever `run` throws.
 */
export function captureWrite<T>(doc: Y.Doc, run: () => T): CapturedWrite<T> {
  const finish = startCapture(doc);
  let result: T;
  try {
    result = run();
  } catch (err) {
    finish();
    throw err;
  }
  return { result, ...finish() };
}

/**
 * Runs an async write (its microtasks included) and classifies what it sent.
 * @param doc - The document written.
 * @param run - The write.
 * @returns Its result and shape.
 * @throws {Error} Whatever `run` rejects with.
 */
export async function captureWriteAsync<T>(doc: Y.Doc, run: () => Promise<T>): Promise<CapturedWrite<T>> {
  const finish = startCapture(doc);
  const result = await run();
  await Promise.resolve();
  return { result, ...finish() };
}

/**
 * The two-way check of spec 0.4: the shape a write of this kind must send.
 * @param kind - The declared kind.
 * @param captured - What the write sent.
 * @throws {AssertionError} When the shape does not fit the kind.
 */
export function expectKindShape(kind: SpaceWriteKind, captured: { shape: WriteShape; update: Uint8Array | null }): void {
  const want: WriteShape = kind === 'delete' ? 'D' : kind === 'remove' ? 'R' : 'S';
  expect(captured.shape).toBe(want);
  if (kind === 'compound') expect(Y.decodeUpdate(captured.update!).ds.clients.size).toBeGreaterThan(0);
}

/** What the row template expects of one kind in one state. */
export type RowOutcome = { written: true } | { written: false; toast: string | null };

/**
 * The main matrix (spec 2.1) for one kind and state.
 * @param kind - The write's kind.
 * @param code - The state.
 * @returns Whether it is written, or the toast its refusal shows.
 */
export function outcomeOf(kind: SpaceWriteKind, code: SizeCode): RowOutcome {
  if (code === 'U' || code === 'N' || code === 'W') return { written: true };
  if (code === 'Z') return { written: false, toast: null };
  if (code === 'O' || code === 'CEIL') return kind === 'remove' ? { written: true } : { written: false, toast: SIZE_COPY_EN.T_OVER };
  if (kind === 'delete' || kind === 'remove') return { written: true };
  return { written: false, toast: kind === 'compound' ? SIZE_COPY_EN.T_COMPOUND : SIZE_COPY_EN.T_ADD };
}

/**
 * Asserts the size toasts a call showed: exactly the one sentence, or none.
 * @param sentence - The expected sentence, or null for none.
 * @throws {AssertionError} When the toasts differ.
 */
export function expectSizeToast(sentence: string | null): void {
  const warnings = (toast.warning as unknown as { mock: { calls: unknown[][] } }).mock.calls;
  if (sentence === null) expect(warnings).toEqual([]);
  else {
    expect(warnings).toHaveLength(1);
    expect(warnings[0][0]).toBe(sentence);
  }
  expect((toast.error as unknown as { mock: { calls: unknown[][] } }).mock.calls).toEqual([]);
}

/** One write entry expanded by the row template `T(kind)` (spec 0.6). */
export interface KindRow<T> {
  /** Spec id, the title's first word. */
  id: string;
  /** What is written. */
  title: string;
  kind: SpaceWriteKind;
  /** Canonical document name the write goes to. */
  name: string;
  /** Loads the initial content into a fresh registered document and returns it. */
  seed: () => Y.Doc;
  /** The write. */
  run: () => T;
  /** Extra assertions when the write was let through. */
  written?: (result: T, doc: Y.Doc, code: SizeCode) => void;
  /** Extra assertions when it was refused. */
  refused?: (result: T, doc: Y.Doc, code: SizeCode) => void;
  /** The states to run (default U, F, O, Z). */
  codes?: ReadonlyArray<SizeCode>;
}

/**
 * Expands one row into one case per state: U writes the kind's shape; F, O
 * and Z follow the main matrix (written with the same shape and no toast, or
 * refused with the document untouched, nothing sent and the state's toast).
 * Each case starts from fresh content; the file resets the registry between
 * cases.
 * @param row - The row.
 * @throws {never} Registers cases only.
 */
export function kindRows<T>(row: KindRow<T>): void {
  for (const code of row.codes ?? (['U', 'F', 'O', 'Z'] as const)) {
    it(`${row.id} ${row.title} is ${row.kind} [${code}]`, () => {
      const doc = row.seed();
      enterSize(row.name, code);
      (toast.warning as unknown as { mockClear: () => void }).mockClear();
      (toast.error as unknown as { mockClear: () => void }).mockClear();
      const before = Y.encodeStateAsUpdate(doc);
      const captured = captureWrite(doc, row.run);
      const outcome = outcomeOf(row.kind, code);
      if (outcome.written) {
        expectKindShape(row.kind, captured);
        expectSizeToast(null);
        row.written?.(captured.result, doc, code);
        return;
      }
      expect(captured.shape).toBe('∅');
      expect(Y.encodeStateAsUpdate(doc)).toEqual(before);
      expectSizeToast(outcome.toast);
      row.refused?.(captured.result, doc, code);
    });
  }
}
