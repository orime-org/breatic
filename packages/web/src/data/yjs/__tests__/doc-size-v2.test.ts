// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * Space document size cap, second design (inner#1790), web test spec section
 * 1: the per-document size state of `data/yjs/doc-size.ts`, driven through the
 * provider events the registry subscribes to (stateless push, refusal close,
 * synced, ordinary close).
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { toast } = vi.hoisted(() => ({
  toast: { warning: vi.fn(), error: vi.fn(), info: vi.fn(), success: vi.fn() },
}));

vi.mock('@web/lib/toast', () => ({ toast }));
vi.mock('@web/data/yjs/collab-failure-report', () => ({ reportCollabFailure: vi.fn() }));
vi.mock('@hocuspocus/provider', async (importOriginal) =>
  (await import('@web/data/yjs/__tests__/helpers/doc-size-driver')).mockProviderModule(await importOriginal()));

import { COLLAB_REAUTH_REASONS, DocSizeStatusSchema } from '@breatic/shared';
import * as docSizeModule from '@web/data/yjs/doc-size';
import * as spaceWriteModule from '@web/data/yjs/space-write';
import {
  disconnect, push, pushRaw, refuse, resetProviderSpies, runTimers, synced, type ProviderSpy,
} from '@web/data/yjs/__tests__/helpers/doc-size-driver';
import {
  COPY_V2_EN, P_CEIL, P_FULL, P_FULL_EDGE, P_NORMAL, P_OVER, P_UNLIMITED, P_UNLIMITED_FULL, P_WARNING,
  type DocSizePushV2,
} from '@web/data/yjs/__tests__/helpers/size-v2-fixtures';
import { readDocSize, useDocSize, type DocSizeState } from '@web/data/yjs/doc-size';
import { writeSpaceDoc } from '@web/data/yjs/space-write';
import {
  acquireDocProvider, readDocConnection, releaseDocProvider, _resetCollabSocketForTests,
} from '@web/data/yjs/collab-socket';
import { docName, getDoc, _resetForTests } from '@web/data/yjs/manager';
import { changeLocale } from '@web/i18n/locale-bootstrap';

const NAME = docName.canvasSpace('p1', 's1');
const docSizeSource = readFileSync(resolve(import.meta.dirname, '../doc-size.ts'), 'utf8');
const spaceWriteSource = readFileSync(resolve(import.meta.dirname, '../space-write.ts'), 'utf8');
const KINDS = ['add', 'edit', 'compound', 'delete', 'remove'] as const;

/** The five fields of the size state every assertion reads. */
type Facts = Pick<DocSizeState, 'phase' | 'overCeiling' | 'bytes' | 'limit' | 'ceiling'>;

/**
 * Opens a Space document the way a tab does (and the way a rebuilt Space remounts).
 * @param name - Canonical document name.
 * @returns The provider spy of the entry.
 * @throws {Error} When acquiring fails.
 */
function open(name = NAME): ProviderSpy {
  return acquireDocProvider(name, getDoc(name)) as unknown as ProviderSpy;
}

/**
 * The five size fields now.
 * @param name - Canonical document name.
 * @returns Phase, overCeiling and the numbers.
 * @throws {never} Never.
 */
function facts(name = NAME): Facts {
  const { phase, overCeiling, bytes, limit, ceiling } = readDocSize(name);
  return { phase, overCeiling, bytes, limit, ceiling };
}

/**
 * The state one push leads to outside a rebuild.
 * @param pushed - The push.
 * @param phase - Expected phase.
 * @param overCeiling - Expected flag.
 * @returns The expected facts.
 * @throws {never} Never.
 */
function pushedFacts(pushed: DocSizePushV2, phase: Facts['phase'], overCeiling: boolean): Facts {
  return { phase, overCeiling, bytes: pushed.bytes, limit: pushed.limit, ceiling: pushed.ceiling };
}

const UNKNOWN_FACTS: Facts = { phase: 'unknown', overCeiling: false, bytes: null, limit: null, ceiling: null };

/**
 * Opens a document, pushes, refuses it and remounts it.
 * @param before - The push before the refusal, or null for none.
 * @param name - Canonical document name.
 * @returns The refused provider and the provider of the rebuilt document.
 * @throws {Error} When acquiring fails.
 */
function intoResync(before: DocSizePushV2 | null, name = NAME): { old: ProviderSpy; next: ProviderSpy } {
  const old = open(name);
  if (before !== null) push(old, before);
  refuse(old);
  return { old, next: open(name) };
}

/**
 * Whether every kind writes right now.
 * @param name - Canonical document name.
 * @throws {AssertionError} When any kind is refused.
 */
function expectAllKindsPass(name = NAME): void {
  for (const kind of KINDS) {
    const write = vi.fn();
    expect(writeSpaceDoc(name, { kind }, write)).toEqual({ ok: true });
    expect(write).toHaveBeenCalledTimes(1);
  }
  expect(toast.warning).toHaveBeenCalledTimes(0);
}

/**
 * Messages passed to toast.warning that are the resync sentence.
 * @returns Their count.
 * @throws {never} Never.
 */
function resyncToasts(): number {
  return toast.warning.mock.calls.filter((call) => call[0] === COPY_V2_EN.T_RESYNC).length;
}

beforeEach(() => {
  changeLocale('en');
  resetProviderSpies();
  vi.clearAllMocks();
});

afterEach(() => {
  _resetCollabSocketForTests();
  _resetForTests();
});

describe('size state before and without a limit (S-01, S-02, S-05)', () => {
  it('S-01 starts unknown with null numbers and lets every kind through', () => {
    open();
    expect(facts()).toEqual(UNKNOWN_FACTS);
    expectAllKindsPass();
  });

  it.each([
    ['P_UNLIMITED', P_UNLIMITED],
    ['P_UNLIMITED_FULL', P_UNLIMITED_FULL],
  ] as const)('S-02 stays unknown on %s and lets an add through', (_label, pushed) => {
    const provider = open();
    push(provider, pushed);
    expect(readDocSize(NAME).phase).toBe('unknown');
    expect(readDocSize(NAME).overCeiling).toBe(false);
    const write = vi.fn();
    expect(writeSpaceDoc(NAME, { kind: 'add' }, write)).toEqual({ ok: true });
    expect(write).toHaveBeenCalledTimes(1);
    expect(toast.warning).toHaveBeenCalledTimes(0);
  });

  it.each([
    ['N', P_NORMAL],
    ['W', P_WARNING],
    ['F', P_FULL],
    ['O', P_OVER],
  ] as const)('S-05 goes back to unknown from %s on P_UNLIMITED and lets an add through', (_label, start) => {
    const provider = open();
    push(provider, start);
    expect(readDocSize(NAME).phase).not.toBe('unknown');
    push(provider, P_UNLIMITED);
    expect(readDocSize(NAME).phase).toBe('unknown');
    expect(readDocSize(NAME).overCeiling).toBe(false);
    const write = vi.fn();
    expect(writeSpaceDoc(NAME, { kind: 'add' }, write)).toEqual({ ok: true });
    expect(write).toHaveBeenCalledTimes(1);
    expect(toast.warning).toHaveBeenCalledTimes(0);
  });
});

describe('size state follows pushes (S-03, S-04, S-06, S-07, S-08)', () => {
  it.each([
    ['P_NORMAL', P_NORMAL, 'normal', false],
    ['P_WARNING', P_WARNING, 'warning', false],
    ['P_FULL', P_FULL, 'full', false],
    ['P_OVER', P_OVER, 'full', true],
  ] as const)('S-03 takes the phase and numbers of %s', (_label, pushed, phase, overCeiling) => {
    const provider = open();
    push(provider, pushed);
    expect(facts()).toEqual(pushedFacts(pushed, phase, overCeiling));
  });

  it.each([
    ['P_CEIL', 'true', P_CEIL, true],
    ['P_FULL_EDGE', 'false', P_FULL_EDGE, false],
  ] as const)('S-04 from F, %s sets overCeiling to %s (bytes equal to the ceiling is over)', (_label, overCeilingLabel, pushed, overCeiling) => {
    expect(overCeilingLabel).toBe(String(overCeiling));
    const provider = open();
    push(provider, P_FULL);
    push(provider, pushed);
    expect(facts()).toEqual(pushedFacts(pushed, 'full', overCeiling));
  });

  it('S-06 follows N, W, F, O, F, W, N and useDocSize re-renders once per push', () => {
    const provider = open();
    let renders = 0;
    const { result } = renderHook(() => {
      renders += 1;
      return useDocSize(NAME);
    });
    const steps = [
      [P_NORMAL, 'normal', false],
      [P_WARNING, 'warning', false],
      [P_FULL, 'full', false],
      [P_OVER, 'full', true],
      [P_FULL, 'full', false],
      [P_WARNING, 'warning', false],
      [P_NORMAL, 'normal', false],
    ] as const;
    for (const [pushed, phase, overCeiling] of steps) {
      const before = renders;
      push(provider, pushed);
      expect(facts()).toEqual(pushedFacts(pushed, phase, overCeiling));
      expect(result.current.phase).toBe(phase);
      expect(result.current.overCeiling).toBe(overCeiling);
      expect(result.current.bytes).toBe(pushed.bytes);
      expect(renders).toBe(before + 1);
    }
  });

  it('S-07 takes the pushed phase as it is, without recomputing it from bytes', () => {
    const provider = open();
    push(provider, { bytes: 9437184, limit: 10485760, ceiling: 10747904, phase: 'normal' });
    expect(readDocSize(NAME).phase).toBe('normal');
    expect(readDocSize(NAME).overCeiling).toBe(false);
  });

  it.each([
    ['type doc:sizes', JSON.stringify({ ...P_FULL, type: 'doc:sizes' })],
    ['no ceiling', JSON.stringify({ type: 'doc:size', bytes: P_FULL.bytes, limit: P_FULL.limit, phase: 'full' })],
    ['bytes -1', JSON.stringify({ type: 'doc:size', ...P_FULL, bytes: -1 })],
    ['bytes 1.5', JSON.stringify({ type: 'doc:size', ...P_FULL, bytes: 1.5 })],
    ['phase resyncing', JSON.stringify({ type: 'doc:size', ...P_FULL, phase: 'resyncing' })],
    ['not JSON', 'not json'],
    ['another stateless message', JSON.stringify({ type: 'other' })],
  ] as const)('S-08 ignores an invalid push (%s) and keeps W', (_label, payload) => {
    const provider = open();
    push(provider, P_WARNING);
    const before = facts();
    expect(before).toEqual(pushedFacts(P_WARNING, 'warning', false));
    expect(() => pushRaw(provider, payload)).not.toThrow();
    expect(facts()).toEqual(before);
  });
});

describe('refusal and rebuild (S-09 to S-13)', () => {
  it.each([
    ['N', P_NORMAL, false],
    ['W', P_WARNING, false],
    ['F', P_FULL, false],
    ['O', P_OVER, true],
  ] as const)('S-09 a refusal from %s sets resyncing and keeps overCeiling and the numbers', (_label, start, overCeiling) => {
    const provider = open();
    push(provider, start);
    refuse(provider);
    expect(facts()).toEqual(pushedFacts(start, 'resyncing', overCeiling));
  });

  it('S-10 a refusal before any push sets resyncing; synced without pushes leads back to unknown', () => {
    const { next } = intoResync(null);
    expect(readDocSize(NAME).phase).toBe('resyncing');
    synced(next);
    expect(facts()).toEqual(UNKNOWN_FACTS);
  });

  it('S-11 a second refusal while resyncing keeps resyncing and shows no second resync toast', () => {
    const { next } = intoResync(P_FULL);
    expect(resyncToasts()).toBe(1);
    refuse(next);
    open();
    expect(readDocSize(NAME).phase).toBe('resyncing');
    expect(resyncToasts()).toBe(1);
  });

  it('S-12 pushes during the rebuild keep resyncing and the shown numbers; synced takes the last one', () => {
    const { next } = intoResync(P_FULL);
    push(next, P_WARNING);
    expect(facts()).toEqual(pushedFacts(P_FULL, 'resyncing', false));
    push(next, P_NORMAL);
    expect(facts()).toEqual(pushedFacts(P_FULL, 'resyncing', false));
    synced(next);
    expect(facts()).toEqual(pushedFacts(P_NORMAL, 'normal', false));
  });

  it('S-13 without pushes during the rebuild, synced falls back to the last push received', () => {
    const { next } = intoResync(P_WARNING);
    synced(next);
    expect(facts()).toEqual(pushedFacts(P_WARNING, 'warning', false));
  });
});

describe('events that keep the state (S-14 to S-16, S-19)', () => {
  it.each([
    ['U', null, UNKNOWN_FACTS],
    ['N', P_NORMAL, pushedFacts(P_NORMAL, 'normal', false)],
    ['F', P_FULL, pushedFacts(P_FULL, 'full', false)],
  ] as const)('S-14 synced outside a rebuild keeps %s', (_label, start, expected) => {
    const provider = open();
    if (start !== null) push(provider, start);
    expect(facts()).toEqual(expected);
    synced(provider);
    expect(facts()).toEqual(expected);
  });

  it.each([
    ['W', P_WARNING, 'warning', false],
    ['F', P_FULL, 'full', false],
    ['O', P_OVER, 'full', true],
  ] as const)('S-15 a drop and a re-authentication close keep %s; the next push decides', (_label, start, phase, overCeiling) => {
    const provider = open();
    push(provider, start);
    disconnect(provider);
    expect(facts()).toEqual(pushedFacts(start, phase, overCeiling));
    act(() => {
      provider.emit('close', { event: { code: 1000, reason: COLLAB_REAUTH_REASONS.permissionChanged } });
    });
    expect(facts()).toEqual(pushedFacts(start, phase, overCeiling));
    push(provider, P_NORMAL);
    expect(facts()).toEqual(pushedFacts(P_NORMAL, 'normal', false));
  });

  it('S-16 a drop while resyncing keeps resyncing; the later synced still ends the rebuild', () => {
    const { next } = intoResync(P_FULL);
    disconnect(next);
    expect(readDocSize(NAME).phase).toBe('resyncing');
    push(next, P_WARNING);
    synced(next);
    expect(facts()).toEqual(pushedFacts(P_WARNING, 'warning', false));
  });

  it.each([
    ['F', P_FULL, false],
    ['O', P_OVER, true],
  ] as const)('S-19 a role change to read-only keeps %s', (_label, start, overCeiling) => {
    const provider = open();
    push(provider, start);
    provider.authorizedScope = 'readonly';
    act(() => { provider.emit('authenticated', { scope: 'readonly' }); });
    expect(facts()).toEqual(pushedFacts(start, 'full', overCeiling));
  });

  it('S-19 a role change to read-only keeps Z', () => {
    const { next } = intoResync(P_FULL);
    next.authorizedScope = 'readonly';
    act(() => { next.emit('authenticated', { scope: 'readonly' }); });
    expect(facts()).toEqual(pushedFacts(P_FULL, 'resyncing', false));
  });

  it('S-19 writeSpaceDoc does not judge the role: a read-only connection at N still writes', () => {
    const provider = open();
    push(provider, P_NORMAL);
    provider.authorizedScope = 'readonly';
    act(() => { provider.emit('authenticated', { scope: 'readonly' }); });
    expect(readDocSize(NAME).phase).toBe('normal');
    const write = vi.fn();
    expect(writeSpaceDoc(NAME, { kind: 'add' }, write)).toEqual({ ok: true });
    expect(write).toHaveBeenCalledTimes(1);
  });
});

describe('closing the Space tab (S-17, S-18)', () => {
  it.each([
    ['N', P_NORMAL],
    ['F', P_FULL],
    ['O', P_OVER],
  ] as const)('S-17 closing the tab at %s clears the state and tells useDocSize', async (_label, start) => {
    const provider = open();
    push(provider, start);
    const { result } = renderHook(() => useDocSize(NAME));
    expect(result.current.phase).toBe(start.phase);
    releaseDocProvider(NAME);
    await runTimers();
    expect(facts()).toEqual(UNKNOWN_FACTS);
    expect(result.current.phase).toBe('unknown');
    expect(result.current.bytes).toBeNull();
  });

  it('S-18 closing the tab while resyncing clears the state and cancels the rebuild', async () => {
    const { old, next } = intoResync(P_FULL);
    releaseDocProvider(NAME);
    await runTimers();
    expect(facts()).toEqual(UNKNOWN_FACTS);
    synced(next);
    synced(old);
    expect(facts()).toEqual(UNKNOWN_FACTS);
    expect(readDocConnection(NAME)).toBeNull();
  });
});

describe('which documents take pushes (S-20, S-21)', () => {
  it('S-20 all four Space kinds take a push through the provider stateless event; meta does not', () => {
    const names = [
      docName.canvasSpace('p1', 's1'),
      docName.documentSpace('p1', 's2'),
      docName.timelineSpace('p1', 's3'),
      docName.threeDSpace('p1', 's4'),
    ];
    const meta = docName.projectMeta('p1');
    const providers = names.map((name) => open(name));
    const metaProvider = open(meta);
    for (const provider of providers) {
      act(() => { provider.emit('stateless', { payload: JSON.stringify({ type: 'doc:size', seq: 1, ...P_FULL }) }); });
    }
    act(() => { metaProvider.emit('stateless', { payload: JSON.stringify({ type: 'doc:size', seq: 1, ...P_FULL }) }); });
    expect(names.map((name) => readDocSize(name).phase)).toEqual(['full', 'full', 'full', 'full']);
    expect(facts(meta)).toEqual(UNKNOWN_FACTS);
  });

  it('S-21 each document keeps its own state; a refusal of A leaves B writable', () => {
    const a = docName.canvasSpace('p1', 'sa');
    const b = docName.canvasSpace('p1', 'sb');
    const pa = open(a);
    const pb = open(b);
    push(pa, P_FULL);
    push(pb, P_NORMAL);
    refuse(pa);
    expect(readDocSize(a).phase).toBe('resyncing');
    expect(facts(b)).toEqual(pushedFacts(P_NORMAL, 'normal', false));
    const write = vi.fn();
    expect(writeSpaceDoc(b, { kind: 'add' }, write)).toEqual({ ok: true });
    expect(write).toHaveBeenCalledTimes(1);
  });
});

describe('no reservations are left (S-22)', () => {
  it('S-22 the reservation exports are gone from doc-size and space-write', () => {
    for (const removed of ['availableRoom', 'freeReservation', 'holdRoom', 'heldBytes', 'bindWrite']) {
      expect(Object.keys(docSizeModule)).not.toContain(removed);
    }
    for (const removed of [
      'reserveSpaceRoom', 'utf8Bytes', 'encodedValueBytes', 'replacementJudgement', 'estimateNodeBytes',
      'estimateTextBodyBytes', 'estimateSliceBytes', 'strongestWrite',
    ]) {
      expect(Object.keys(spaceWriteModule)).not.toContain(removed);
    }
    expect(docSizeSource).not.toMatch(/no_room|overwriteRoom|reservation/i);
    expect(spaceWriteSource).not.toMatch(/no_room|'overwrite'/);
  });

  it('S-22 a push with only the v2 fields and its seq is accepted, by the schema and by the state', () => {
    expect(DocSizeStatusSchema.safeParse({ type: 'doc:size', seq: 1, ...P_FULL }).success).toBe(true);
    const provider = open();
    push(provider, P_FULL);
    expect(facts()).toEqual(pushedFacts(P_FULL, 'full', false));
  });
});
