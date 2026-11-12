// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * Space document size cap, second design (inner#1790), web test spec section
 * 2: `writeSpaceDoc` with the five kinds in every size state, `canAdd` and
 * `strongestKind`. The state is set through `setDocSize` (the one writer the
 * provider subscription calls) and `startDocResync`.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { toast } = vi.hoisted(() => ({
  toast: { warning: vi.fn(), error: vi.fn(), info: vi.fn(), success: vi.fn() },
}));

vi.mock('@web/lib/toast', () => ({ toast }));

import type { DocSizeStatus } from '@breatic/shared';
import {
  COPY_V2_EN, P_CEIL, P_FULL, P_FULL_EDGE, P_NORMAL, P_OVER, P_WARNING, type DocSizePushV2,
} from '@web/data/yjs/__tests__/helpers/size-v2-fixtures';
import { clearAllDocSizes, readDocSize, setDocSize, startDocResync } from '@web/data/yjs/doc-size';
import { canAdd, strongestKind, writeSpaceDoc, type SpaceWriteKind } from '@web/data/yjs/space-write';
import { docName } from '@web/data/yjs/manager';
import { changeLocale } from '@web/i18n/locale-bootstrap';

const NAME = docName.canvasSpace('p1', 's1');
const OTHER = docName.canvasSpace('p1', 's2');
const KINDS: readonly SpaceWriteKind[] = ['add', 'edit', 'compound', 'delete', 'remove'];

/** A state code of spec 0.3, with the boundary fixtures. */
type StateCode = 'U' | 'N' | 'W' | 'F' | 'F_EDGE' | 'O' | 'CEIL' | 'Z';

const PUSH_OF: Record<Exclude<StateCode, 'U' | 'Z'>, DocSizePushV2> = {
  N: P_NORMAL, W: P_WARNING, F: P_FULL, F_EDGE: P_FULL_EDGE, O: P_OVER, CEIL: P_CEIL,
};

/**
 * Puts a document in a state.
 * @param state - The state code; `Z` is a rebuild started from `N`.
 * @param name - Canonical document name.
 * @throws {AssertionError} When the state did not take.
 */
function at(state: StateCode, name = NAME): void {
  if (state === 'U') {
    expect(readDocSize(name).phase).toBe('unknown');
    return;
  }
  const pushed = state === 'Z' ? P_NORMAL : PUSH_OF[state];
  setDocSize(name, { type: 'doc:size', ...pushed } as DocSizeStatus);
  if (state === 'Z') startDocResync(name);
  expect(readDocSize(name).phase).toBe(state === 'Z' ? 'resyncing' : pushed.phase);
}

/** What one cell of W-01 expects. */
type Cell = { ok: true } | { ok: false; reason: 'full' | 'over_ceiling' | 'resyncing'; toast: string | null };

const PASS: Cell = { ok: true };
const FULL_ADD: Cell = { ok: false, reason: 'full', toast: COPY_V2_EN.T_ADD };
const FULL_COMPOUND: Cell = { ok: false, reason: 'full', toast: COPY_V2_EN.T_COMPOUND };
const OVER: Cell = { ok: false, reason: 'over_ceiling', toast: COPY_V2_EN.T_OVER };
const RESYNC: Cell = { ok: false, reason: 'resyncing', toast: null };

/** W-01: each kind's result by state (spec 2.1). */
const MATRIX: Record<SpaceWriteKind, Record<StateCode, Cell>> = {
  add: { U: PASS, N: PASS, W: PASS, F: FULL_ADD, F_EDGE: FULL_ADD, O: OVER, CEIL: OVER, Z: RESYNC },
  edit: { U: PASS, N: PASS, W: PASS, F: FULL_ADD, F_EDGE: FULL_ADD, O: OVER, CEIL: OVER, Z: RESYNC },
  compound: { U: PASS, N: PASS, W: PASS, F: FULL_COMPOUND, F_EDGE: FULL_COMPOUND, O: OVER, CEIL: OVER, Z: RESYNC },
  delete: { U: PASS, N: PASS, W: PASS, F: PASS, F_EDGE: PASS, O: OVER, CEIL: OVER, Z: RESYNC },
  remove: { U: PASS, N: PASS, W: PASS, F: PASS, F_EDGE: PASS, O: PASS, CEIL: PASS, Z: RESYNC },
};

const CELLS = KINDS.flatMap((kind) =>
  (Object.keys(MATRIX[kind]) as StateCode[]).map((state) => [kind, state, MATRIX[kind][state]] as const));

beforeEach(() => {
  changeLocale('en');
  vi.clearAllMocks();
});

afterEach(() => {
  clearAllDocSizes();
});

describe('writeSpaceDoc by kind and state (W-01)', () => {
  it.each(CELLS)('W-01 %s at %s', (kind, state, cell) => {
    at(state);
    const write = vi.fn();
    const result = writeSpaceDoc(NAME, { kind }, write);
    if (cell.ok) {
      expect(result).toEqual({ ok: true });
      expect(write).toHaveBeenCalledTimes(1);
      expect(toast.warning).toHaveBeenCalledTimes(0);
    } else {
      expect(result).toEqual({ ok: false, reason: cell.reason });
      expect(write).toHaveBeenCalledTimes(0);
      if (cell.toast === null) {
        expect(toast.warning).toHaveBeenCalledTimes(0);
      } else {
        expect(toast.warning).toHaveBeenCalledTimes(1);
        expect(toast.warning.mock.calls[0]?.[0]).toBe(cell.toast);
      }
    }
    expect(toast.error).toHaveBeenCalledTimes(0);
  });
});

describe('writeSpaceDoc details (W-02 to W-05, W-07)', () => {
  it.each([
    ['add', 'F', { ok: false, reason: 'full' }],
    ['compound', 'F', { ok: false, reason: 'full' }],
    ['delete', 'O', { ok: false, reason: 'over_ceiling' }],
  ] as const)('W-02 notify: false refuses %s at %s the same way without a toast', (kind, state, expected) => {
    at(state);
    const write = vi.fn();
    expect(writeSpaceDoc(NAME, { kind, notify: false }, write)).toEqual(expected);
    expect(write).toHaveBeenCalledTimes(0);
    expect(toast.warning).toHaveBeenCalledTimes(0);
  });

  it('W-03 an error thrown by the write itself propagates unchanged', () => {
    at('U');
    const boom = new Error('boom');
    let caught: unknown = null;
    try {
      writeSpaceDoc(NAME, { kind: 'add' }, () => { throw boom; });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBe(boom);
  });

  it('W-04 a write inside an allowed one on the same document is not judged again', () => {
    at('F');
    const inner = vi.fn();
    let innerResult: unknown = null;
    const outer = writeSpaceDoc(NAME, { kind: 'remove' }, () => {
      innerResult = writeSpaceDoc(NAME, { kind: 'compound' }, inner);
    });
    expect(outer).toEqual({ ok: true });
    expect(inner).toHaveBeenCalledTimes(1);
    expect(innerResult).toEqual({ ok: true });
    expect(toast.warning).toHaveBeenCalledTimes(0);
  });

  it('W-05 a write inside an allowed one on another document is judged by that document', () => {
    at('N');
    at('F', OTHER);
    const inner = vi.fn();
    let innerResult: unknown = null;
    const outer = writeSpaceDoc(NAME, { kind: 'add' }, () => {
      innerResult = writeSpaceDoc(OTHER, { kind: 'add' }, inner);
    });
    expect(outer).toEqual({ ok: true });
    expect(innerResult).toEqual({ ok: false, reason: 'full' });
    expect(inner).toHaveBeenCalledTimes(0);
    expect(toast.warning).toHaveBeenCalledTimes(1);
    expect(toast.warning.mock.calls[0]?.[0]).toBe(COPY_V2_EN.T_ADD);
  });

  it('W-07 two refused adds both reach the toast wrapper, with the same sentence', () => {
    at('F');
    writeSpaceDoc(NAME, { kind: 'add' }, vi.fn());
    writeSpaceDoc(NAME, { kind: 'add' }, vi.fn());
    expect(toast.warning).toHaveBeenCalledTimes(2);
    expect(toast.warning.mock.calls.map((call) => call[0])).toEqual([COPY_V2_EN.T_ADD, COPY_V2_EN.T_ADD]);
  });
});

describe('canAdd (W-06)', () => {
  it.each([
    ['U', true],
    ['N', true],
    ['W', true],
    ['F', false],
    ['O', false],
    ['Z', false],
    ['CEIL', false],
  ] as const)('W-06 at %s is %s, with no toast', (state, expected) => {
    at(state);
    expect(canAdd(NAME)).toBe(expected);
    expect(toast.warning).toHaveBeenCalledTimes(0);
  });
});

describe('strongestKind (W-08)', () => {
  const RANK: Record<SpaceWriteKind, number> = { add: 4, edit: 3, compound: 2, delete: 1, remove: 0 };
  const PAIRS = KINDS.flatMap((a) => KINDS.map((b) => [a, b] as const));

  it.each(PAIRS)('W-08 strongestKind(%s, %s) is the stronger one', (a, b) => {
    expect(strongestKind(a, b)).toBe(RANK[a] >= RANK[b] ? a : b);
  });

  it('W-08 strongestKind of all five is add, of the deletes is compound', () => {
    expect(strongestKind('remove', 'delete', 'compound', 'edit', 'add')).toBe('add');
    expect(strongestKind('remove', 'delete', 'compound')).toBe('compound');
    expect(strongestKind('remove')).toBe('remove');
  });
});
