// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { toast } = vi.hoisted(() => ({
  toast: { warning: vi.fn(), error: vi.fn(), info: vi.fn(), success: vi.fn() },
}));

vi.mock('@web/lib/toast', () => ({ toast }));
vi.mock('@web/data/yjs/collab-failure-report', () => ({ reportCollabFailure: vi.fn() }));
vi.mock('@hocuspocus/provider', async (importOriginal) =>
  (await import('@web/data/yjs/__tests__/helpers/doc-size-driver')).mockProviderModule(await importOriginal()));

import {
  disconnect, push, pushRaw, refuse, resetProviderSpies, runTimers, synced, type ProviderSpy,
} from '@web/data/yjs/__tests__/helpers/doc-size-driver';
import {
  COPY_EN, F_AT_CEILING, F_FULL, F_FULL_NEAR, F_FULL_NEAR_MINUS1, F_NORMAL, F_OVER, F_OVER_BIG, F_UNLIMITED,
  F_WARNING, F_WARNING_TIGHT, docSizePayload, type DocSizePush,
} from '@web/data/yjs/__tests__/helpers/doc-size-fixtures';
import { readDocSize, useDocSize } from '@web/data/yjs/doc-size';
import { reserveSpaceRoom, writeSpaceDoc } from '@web/data/yjs/space-write';
import { acquireDocProvider, releaseDocProvider, _resetCollabSocketForTests } from '@web/data/yjs/collab-socket';
import { getDoc, hasDoc, _resetForTests } from '@web/data/yjs/manager';
import { changeLocale } from '@web/i18n/locale-bootstrap';

const NAME = 'project-p1/canvas-s1';
const NUMBERS = ['bytes', 'limit', 'ceiling', 'room', 'overwriteRoom'] as const;

/**
 * Opens a Space document the way a tab does.
 * @param name - Canonical document name.
 * @returns The provider spy of the entry.
 * @throws {Error} When acquiring fails.
 */
function open(name = NAME): ProviderSpy {
  return acquireDocProvider(name, getDoc(name)) as unknown as ProviderSpy;
}

/**
 * The refused document is rebuilt and its Space subtree mounts again (design 5.3 step 4).
 * @param provider - The provider whose document the server refused.
 * @param name - Canonical document name.
 * @returns The provider of the rebuilt document.
 * @throws {Error} When acquiring fails.
 */
function refuseAndRemount(provider: ProviderSpy, name = NAME): ProviderSpy {
  refuse(provider);
  return open(name);
}

/**
 * Whether a reservation of n bytes is accepted right now (spec 0.3 probe).
 * @param name - Canonical document name.
 * @param n - Bytes asked for.
 * @returns Whether it fit; an accepted probe is released at once.
 * @throws {never} Never.
 */
function probe(name: string, n: number): boolean {
  const result = reserveSpaceRoom(name, n, { notify: false });
  if (result.ok) result.reservation.release();
  return result.ok;
}

/**
 * Asserts the room available to new writes.
 * @param name - Canonical document name.
 * @param available - Expected available bytes.
 * @throws {AssertionError} When the room differs.
 */
function expectAvailable(name: string, available: number): void {
  if (available === 0) {
    expect(probe(name, 1)).toBe(false);
    expect(reserveSpaceRoom(name, 1, { notify: false })).toEqual({ ok: false, reason: 'no_room', room: 0 });
    return;
  }
  expect(probe(name, available)).toBe(true);
  expect(probe(name, available + 1)).toBe(false);
}

/**
 * Asserts the never-pushed state.
 * @param name - Canonical document name.
 * @throws {AssertionError} When the state is not unknown.
 */
function expectUnknown(name: string): void {
  const state = readDocSize(name);
  expect(state.phase).toBe('unknown');
  expect(state.overCeiling).toBe(false);
  for (const key of NUMBERS) expect(state[key]).toBeNull();
}

/**
 * Asserts the state taken from one push.
 * @param name - Canonical document name.
 * @param fixture - The push.
 * @param overCeiling - The expected derived flag.
 * @throws {AssertionError} When any field differs.
 */
function expectPushed(name: string, fixture: DocSizePush, overCeiling: boolean): void {
  expect(readDocSize(name)).toMatchObject({ ...fixture, overCeiling });
}

/**
 * Messages passed to toast.warning, in order.
 * @returns The first arguments.
 * @throws {never} Never.
 */
function warnings(): unknown[] {
  return toast.warning.mock.calls.map((call) => call[0]);
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

describe('doc size state before any push (W-01, W-02)', () => {
  it('W-01 starts unknown with null numbers, lets every write through and records no reservation', () => {
    const provider = open();
    expectUnknown(NAME);
    const write1 = vi.fn();
    const write2 = vi.fn();
    const write3 = vi.fn();
    expect(writeSpaceDoc(NAME, { kind: 'add', estimate: 2 ** 40 }, write1)).toEqual({ ok: true });
    expect(writeSpaceDoc(NAME, { kind: 'overwrite' }, write2)).toEqual({ ok: true });
    expect(writeSpaceDoc(NAME, { kind: 'delete' }, write3)).toEqual({ ok: true });
    expect(write1).toHaveBeenCalledTimes(1);
    expect(write2).toHaveBeenCalledTimes(1);
    expect(write3).toHaveBeenCalledTimes(1);
    expect(reserveSpaceRoom(NAME, 2 ** 40).ok).toBe(true);
    expect(toast.warning).toHaveBeenCalledTimes(0);
    push(provider, F_WARNING);
    expectAvailable(NAME, 786432);
  });

  it('W-02 stays unknown on a limit = 0 push and lets every write through', () => {
    const provider = open();
    push(provider, F_UNLIMITED);
    const state = readDocSize(NAME);
    expect(state.phase).toBe('unknown');
    expect(state.limit).toBe(0);
    expect(state.overCeiling).toBe(false);
    const writes = [vi.fn(), vi.fn(), vi.fn()];
    expect(writeSpaceDoc(NAME, { kind: 'add', estimate: 2 ** 40 }, writes[0]!)).toEqual({ ok: true });
    expect(writeSpaceDoc(NAME, { kind: 'overwrite' }, writes[1]!)).toEqual({ ok: true });
    expect(writeSpaceDoc(NAME, { kind: 'delete' }, writes[2]!)).toEqual({ ok: true });
    for (const write of writes) expect(write).toHaveBeenCalledTimes(1);
    expect(reserveSpaceRoom(NAME, 2 ** 40).ok).toBe(true);
    expect(toast.warning).toHaveBeenCalledTimes(0);
  });
});

describe('doc size state follows pushes (W-03 to W-06)', () => {
  it.each([
    ['F_NORMAL', F_NORMAL, false],
    ['F_WARNING', F_WARNING, false],
    ['F_FULL', F_FULL, false],
    ['F_AT_CEILING', F_AT_CEILING, false],
    ['F_OVER', F_OVER, true],
  ] as const)('W-03 takes the pushed phase and numbers from %s', (_label, fixture, overCeiling) => {
    const provider = open();
    push(provider, fixture);
    expectPushed(NAME, fixture, overCeiling);
  });

  it('W-04 useDocSize follows pushes back and forth between phases', () => {
    const provider = open();
    const { result } = renderHook(() => useDocSize(NAME));
    const sequence = [F_NORMAL, F_WARNING, F_FULL, F_WARNING, F_NORMAL];
    const phases: string[] = [];
    const bytes: Array<number | null> = [];
    for (const fixture of sequence) {
      act(() => { provider.emit('stateless', { payload: docSizePayload(fixture) }); });
      phases.push(result.current.phase);
      bytes.push(result.current.bytes);
    }
    expect(phases).toEqual(['normal', 'warning', 'full', 'warning', 'normal']);
    expect(bytes).toEqual([1048576, 9437184, 10223616, 9437184, 1048576]);
  });

  it.each([
    ['F_NORMAL', F_NORMAL],
    ['F_WARNING', F_WARNING],
    ['F_FULL', F_FULL],
  ] as const)('W-05 goes back to unknown from %s on a limit = 0 push and lets writes through', (_label, start) => {
    const provider = open();
    push(provider, start);
    push(provider, F_UNLIMITED);
    expect(readDocSize(NAME).phase).toBe('unknown');
    const write = vi.fn();
    const write2 = vi.fn();
    expect(writeSpaceDoc(NAME, { kind: 'add', estimate: 2 ** 40 }, write)).toEqual({ ok: true });
    expect(writeSpaceDoc(NAME, { kind: 'overwrite' }, write2)).toEqual({ ok: true });
    expect(write).toHaveBeenCalledTimes(1);
    expect(write2).toHaveBeenCalledTimes(1);
    expect(toast.warning).toHaveBeenCalledTimes(0);
  });

  it('W-06 ignores malformed pushes and accepts one with an extra field', () => {
    const provider = open();
    push(provider, F_WARNING);
    const { overwriteRoom: _dropped, ...withoutOverwriteRoom } = F_FULL;
    const malformed = [
      docSizePayload({ ...F_FULL, phase: 'bogus' }),
      docSizePayload({ ...F_FULL, bytes: -1 }),
      docSizePayload({ ...F_FULL, bytes: 1.5 }),
      docSizePayload(withoutOverwriteRoom),
      JSON.stringify({ ...F_FULL, type: 'doc:sizes' }),
      'not json',
      JSON.stringify({ type: 'sync:confirmed', id: '44444444-4444-4444-8444-444444444444', ok: true }),
    ];
    for (const payload of malformed) {
      expect(() => pushRaw(provider, payload)).not.toThrow();
      expectPushed(NAME, F_WARNING, false);
    }
    push(provider, { ...F_FULL, extra: 1 });
    expect(readDocSize(NAME).phase).toBe('full');
    expect(readDocSize(NAME).bytes).toBe(10223616);
  });
});

describe('writeSpaceDoc by phase and kind (W-07 to W-12)', () => {
  it('W-07 normal: refuses an add over the room with a toast and accepts one equal to it', () => {
    const provider = open();
    push(provider, F_NORMAL);
    const writeA = vi.fn();
    const writeB = vi.fn();
    expect(writeSpaceDoc(NAME, { kind: 'add', estimate: 9175041 }, writeA)).toEqual({ ok: false, reason: 'no_room', room: 9175040 });
    expect(writeA).toHaveBeenCalledTimes(0);
    expect(warnings()).toEqual([COPY_EN.T_NO_ROOM('8.8 MiB')]);
    expect(writeSpaceDoc(NAME, { kind: 'add', estimate: 9175040 }, writeB)).toEqual({ ok: true });
    expect(writeB).toHaveBeenCalledTimes(1);
    expect(toast.warning).toHaveBeenCalledTimes(1);
    expect(toast.error).toHaveBeenCalledTimes(0);
  });

  it('W-08 warning: refuses an add over the room with a toast and accepts one equal to it', () => {
    const provider = open();
    push(provider, F_WARNING);
    const writeA = vi.fn();
    const writeB = vi.fn();
    expect(writeSpaceDoc(NAME, { kind: 'add', estimate: 786433 }, writeA)).toEqual({ ok: false, reason: 'no_room', room: 786432 });
    expect(writeA).toHaveBeenCalledTimes(0);
    expect(warnings()).toEqual([COPY_EN.T_NO_ROOM('768 KiB')]);
    expect(writeSpaceDoc(NAME, { kind: 'add', estimate: 786432 }, writeB)).toEqual({ ok: true });
    expect(writeB).toHaveBeenCalledTimes(1);
    expect(toast.error).toHaveBeenCalledTimes(0);
  });

  it('W-09 full: refuses every add, even with estimate 0 or none', () => {
    const provider = open();
    push(provider, F_FULL);
    const w1 = vi.fn();
    const w2 = vi.fn();
    expect(writeSpaceDoc(NAME, { kind: 'add', estimate: 0 }, w1)).toEqual({ ok: false, reason: 'full' });
    expect(writeSpaceDoc(NAME, { kind: 'add' }, w2)).toEqual({ ok: false, reason: 'full' });
    expect(w1).toHaveBeenCalledTimes(0);
    expect(w2).toHaveBeenCalledTimes(0);
    expect(warnings()).toEqual([COPY_EN.T_ADD_BLOCKED, COPY_EN.T_ADD_BLOCKED]);
    expect(toast.error).toHaveBeenCalledTimes(0);
  });

  it.each([
    ['F_NORMAL', F_NORMAL],
    ['F_WARNING', F_WARNING],
    ['F_WARNING_TIGHT', F_WARNING_TIGHT],
  ] as const)('W-10a %s: an overwrite ignores its estimate and the room', (_label, fixture) => {
    const provider = open();
    push(provider, fixture);
    const write = vi.fn();
    expect(writeSpaceDoc(NAME, { kind: 'overwrite', estimate: 20000000 }, write)).toEqual({ ok: true });
    expect(write).toHaveBeenCalledTimes(1);
    expect(toast.warning).toHaveBeenCalledTimes(0);
  });

  it.each([
    ['normal', { ...F_NORMAL, overwriteRoom: 0 }],
    ['warning', { ...F_WARNING, overwriteRoom: 0 }],
  ] as const)('W-10b %s with overwriteRoom 0: an overwrite is refused whatever the phase', (_label, fixture) => {
    const provider = open();
    push(provider, fixture);
    const write = vi.fn();
    expect(writeSpaceDoc(NAME, { kind: 'overwrite', estimate: 20000000 }, write)).toEqual({ ok: false, reason: 'full' });
    expect(write).toHaveBeenCalledTimes(0);
    expect(warnings()).toEqual([COPY_EN.T_OVERWRITE_BLOCKED]);
  });

  it.each([
    ['F_FULL', F_FULL, true],
    ['F_FULL_NEAR_MINUS1', F_FULL_NEAR_MINUS1, true],
    ['F_FULL_NEAR', F_FULL_NEAR, false],
    ['F_OVER', F_OVER, false],
  ] as const)('W-11 full %s: an overwrite passes only while overwriteRoom is above 0', (_label, fixture, passes) => {
    const provider = open();
    push(provider, fixture);
    const write = vi.fn();
    const result = writeSpaceDoc(NAME, { kind: 'overwrite' }, write);
    if (passes) {
      expect(result).toEqual({ ok: true });
      expect(write).toHaveBeenCalledTimes(1);
      expect(toast.warning).toHaveBeenCalledTimes(0);
    } else {
      expect(result).toEqual({ ok: false, reason: 'full' });
      expect(write).toHaveBeenCalledTimes(0);
      expect(warnings()).toEqual([COPY_EN.T_OVERWRITE_BLOCKED]);
    }
  });

  it.each([
    ['F_NORMAL', F_NORMAL],
    ['F_WARNING', F_WARNING],
    ['F_FULL', F_FULL],
    ['F_FULL_NEAR', F_FULL_NEAR],
    ['F_AT_CEILING', F_AT_CEILING],
    ['F_OVER', F_OVER],
    ['F_OVER_BIG', F_OVER_BIG],
  ] as const)('W-12 %s: a delete always passes', (_label, fixture) => {
    const provider = open();
    push(provider, fixture);
    const write = vi.fn();
    expect(writeSpaceDoc(NAME, { kind: 'delete' }, write)).toEqual({ ok: true });
    expect(write).toHaveBeenCalledTimes(1);
    expect(toast.warning).toHaveBeenCalledTimes(0);
  });
});

describe('refusal and resync (W-13 to W-16)', () => {
  it.each([
    ['no push', null],
    ['F_NORMAL', F_NORMAL],
    ['F_WARNING', F_WARNING],
    ['F_FULL', F_FULL],
  ] as const)('W-13 enters resyncing from %s and ignores a second close from the old provider', (_label, start) => {
    const old = open();
    if (start !== null) push(old, start);
    refuse(old);
    expect(readDocSize(NAME).phase).toBe('resyncing');
    const fresh = getDoc(NAME);
    const next = open();
    refuse(old);
    expect(getDoc(NAME)).toBe(fresh);
    expect(fresh.isDestroyed).toBe(false);
    expect(next.destroy).toHaveBeenCalledTimes(0);
    expect(readDocSize(NAME).phase).toBe('resyncing');
    expect(warnings().filter((message) => message === COPY_EN.T_RESYNC)).toHaveLength(1);
  });

  it('W-14 refuses every write while resyncing, with no toast beyond the resync one', () => {
    const provider = open();
    push(provider, F_NORMAL);
    refuseAndRemount(provider);
    const writes = [vi.fn(), vi.fn(), vi.fn()];
    expect(writeSpaceDoc(NAME, { kind: 'add', estimate: 1 }, writes[0]!)).toEqual({ ok: false, reason: 'full' });
    expect(writeSpaceDoc(NAME, { kind: 'overwrite' }, writes[1]!)).toEqual({ ok: false, reason: 'full' });
    expect(writeSpaceDoc(NAME, { kind: 'delete' }, writes[2]!)).toEqual({ ok: false, reason: 'full' });
    expect(reserveSpaceRoom(NAME, 1)).toEqual({ ok: false, reason: 'full' });
    for (const write of writes) expect(write).toHaveBeenCalledTimes(0);
    expect(warnings()).toEqual([COPY_EN.T_RESYNC]);
  });

  it('W-15a records pushes while resyncing and takes the last one once synced', () => {
    const old = open();
    const next = refuseAndRemount(old);
    push(next, F_WARNING);
    push(next, F_FULL);
    expect(readDocSize(NAME).phase).toBe('resyncing');
    synced(next);
    expect(readDocSize(NAME).phase).toBe('full');
    expect(readDocSize(NAME).bytes).toBe(10223616);
  });

  it('W-15b a limit = 0 push while resyncing leaves the document unknown once synced', () => {
    const old = open();
    const next = refuseAndRemount(old);
    push(next, F_UNLIMITED);
    synced(next);
    expect(readDocSize(NAME).phase).toBe('unknown');
    const write = vi.fn();
    expect(writeSpaceDoc(NAME, { kind: 'add', estimate: 2 ** 40 }, write)).toEqual({ ok: true });
    expect(write).toHaveBeenCalledTimes(1);
  });

  it('W-16a without pushes during the resync, synced falls back to the push before it', () => {
    const old = open();
    push(old, F_FULL);
    const next = refuseAndRemount(old);
    synced(next);
    expect(readDocSize(NAME).phase).toBe('full');
    expect(readDocSize(NAME).bytes).toBe(10223616);
    expect(writeSpaceDoc(NAME, { kind: 'add' }, vi.fn())).toEqual({ ok: false, reason: 'full' });
  });

  it('W-16b a document never pushed is unknown after the resync', () => {
    const old = open();
    const next = refuseAndRemount(old);
    synced(next);
    expectUnknown(NAME);
    const write = vi.fn();
    expect(writeSpaceDoc(NAME, { kind: 'add', estimate: 2 ** 40 }, write)).toEqual({ ok: true });
    expect(write).toHaveBeenCalledTimes(1);
  });
});

describe('events that keep the state (W-17 to W-21)', () => {
  it.each([
    ['no push', null, 'unknown'],
    ['F_NORMAL', F_NORMAL, 'normal'],
    ['F_WARNING', F_WARNING, 'warning'],
    ['F_FULL', F_FULL, 'full'],
  ] as const)('W-17 synced outside a resync keeps %s', (_label, start, phase) => {
    const provider = open();
    if (start !== null) push(provider, start);
    synced(provider);
    expect(readDocSize(NAME).phase).toBe(phase);
  });

  it.each([
    ['no push', null],
    ['F_WARNING', F_WARNING],
    ['F_FULL', F_FULL],
  ] as const)('W-18 a disconnect and re-authentication keep %s until the next push', (_label, start) => {
    const provider = open();
    if (start !== null) push(provider, start);
    const before = readDocSize(NAME);
    disconnect(provider);
    act(() => {
      provider.emit('authenticationFailed', { reason: 'x' });
      provider.emit('authenticated', { scope: 'read-write' });
    });
    expect(readDocSize(NAME)).toEqual(before);
    push(provider, F_NORMAL);
    expect(readDocSize(NAME).phase).toBe('normal');
  });

  it('W-18 a disconnect keeps resyncing', () => {
    const old = open();
    push(old, F_WARNING);
    const next = refuseAndRemount(old);
    const before = readDocSize(NAME);
    disconnect(next);
    expect(readDocSize(NAME)).toEqual(before);
    expect(readDocSize(NAME).phase).toBe('resyncing');
    push(next, F_NORMAL);
    expect(readDocSize(NAME).phase).toBe('resyncing');
  });

  it('W-19a closing the Space clears its state, also for the next open', async () => {
    const provider = open();
    push(provider, F_FULL);
    releaseDocProvider(NAME);
    await runTimers();
    expectUnknown(NAME);
    open();
    expectUnknown(NAME);
  });

  it('W-19b closing the Space during a resync cancels it', async () => {
    const old = open();
    push(old, F_FULL);
    const next = refuseAndRemount(old);
    releaseDocProvider(NAME);
    await runTimers();
    synced(next);
    expectUnknown(NAME);
    expect(hasDoc(NAME)).toBe(false);
  });

  it('W-20 a role change to read-only keeps the phase', () => {
    const provider = open();
    push(provider, F_WARNING);
    provider.authorizedScope = 'readonly';
    act(() => { provider.emit('authenticated', { scope: 'readonly' }); });
    expect(readDocSize(NAME).phase).toBe('warning');
  });

  it.each([
    ['limit = 0', F_UNLIMITED, 'unknown'],
    ['F_NORMAL', F_NORMAL, 'normal'],
  ] as const)('W-21 a full tab follows a changed configuration after reconnecting (%s)', (_label, after, phase) => {
    const provider = open();
    push(provider, F_FULL);
    disconnect(provider);
    act(() => { provider.emit('authenticated', { scope: 'read-write' }); });
    push(provider, after);
    expect(readDocSize(NAME).phase).toBe(phase);
    const write = vi.fn();
    expect(writeSpaceDoc(NAME, { kind: 'add', estimate: 1048576 }, write)).toEqual({ ok: true });
    expect(write).toHaveBeenCalledTimes(1);
  });
});

describe('which documents take pushes (W-22, W-136, W-142)', () => {
  it('W-22 all four Space document kinds subscribe, independently', () => {
    const names = ['project-p1/canvas-s1', 'project-p1/document-s2', 'project-p1/timeline-s3', 'project-p1/3d-s4'];
    const spies = names.map((name) => open(name));
    spies.forEach((spy) => push(spy, F_FULL));
    expect(names.map((name) => readDocSize(name).phase)).toEqual(['full', 'full', 'full', 'full']);
    push(spies[0]!, F_NORMAL);
    expect(names.map((name) => readDocSize(name).phase)).toEqual(['normal', 'full', 'full', 'full']);
  });

  it('W-136 any limit = 0 push means unlimited, whatever its other numbers say', () => {
    const provider = open();
    push(provider, F_WARNING);
    const a = reserveSpaceRoom(NAME, 300000);
    expect(a.ok).toBe(true);
    push(provider, { bytes: 9437184, limit: 0, ceiling: 10747904, room: 0, overwriteRoom: 0, phase: 'full' });
    expect(readDocSize(NAME).phase).toBe('unknown');
    const write = vi.fn();
    const write2 = vi.fn();
    expect(writeSpaceDoc(NAME, { kind: 'add', estimate: 2 ** 40 }, write)).toEqual({ ok: true });
    expect(writeSpaceDoc(NAME, { kind: 'overwrite' }, write2)).toEqual({ ok: true });
    expect(write).toHaveBeenCalledTimes(1);
    expect(write2).toHaveBeenCalledTimes(1);
    expect(toast.warning).toHaveBeenCalledTimes(0);
    push(provider, F_WARNING);
    expectAvailable(NAME, 786432);
  });

  it('W-142 the meta document and an unparsable name ignore doc:size', () => {
    const meta = open('project-p1/meta');
    const weird = open('weird-name');
    expect(() => push(meta, F_FULL)).not.toThrow();
    expect(() => push(weird, F_FULL)).not.toThrow();
    expectUnknown('project-p1/meta');
    expectUnknown('weird-name');
  });
});
