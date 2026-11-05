// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';

const { toast } = vi.hoisted(() => ({
  toast: { warning: vi.fn(), error: vi.fn(), info: vi.fn(), success: vi.fn() },
}));

vi.mock('@web/lib/toast', () => ({ toast }));
vi.mock('@web/data/yjs/collab-failure-report', () => ({ reportCollabFailure: vi.fn() }));
vi.mock('@hocuspocus/provider', async (importOriginal) =>
  (await import('@web/data/yjs/__tests__/helpers/doc-size-driver')).mockProviderModule(await importOriginal()));

import {
  confirmId, confirmLatest, confirmRequests, flush, handshake, push, refuse, resetProviderSpies, type ProviderSpy,
} from '@web/data/yjs/__tests__/helpers/doc-size-driver';
import {
  COPY_EN, F_FULL, F_FULL_NEAR, F_NORMAL, F_OVER, F_WARNING, type DocSizePush,
} from '@web/data/yjs/__tests__/helpers/doc-size-fixtures';
import { reserveSpaceRoom, writeSpaceDoc } from '@web/data/yjs/space-write';
import { acquireDocProvider, _resetCollabSocketForTests } from '@web/data/yjs/collab-socket';
import { getDoc, _resetForTests } from '@web/data/yjs/manager';
import { changeLocale } from '@web/i18n/locale-bootstrap';

const NAME = 'project-p1/canvas-s1';
const DOCUMENT = 'project-p1/document-s2';
const TIMELINE = 'project-p1/timeline-s3';

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
 * Opens a document and pushes one size.
 * @param fixture - The push.
 * @param name - Canonical document name.
 * @returns The provider spy of the entry.
 * @throws {Error} When acquiring fails.
 */
function openWith(fixture: DocSizePush, name = NAME): ProviderSpy {
  const provider = open(name);
  push(provider, fixture);
  return provider;
}

/**
 * Whether a reservation of n bytes is accepted right now (spec 0.3 probe).
 * @param n - Bytes asked for.
 * @param name - Canonical document name.
 * @returns Whether it fit; an accepted probe is released at once.
 * @throws {never} Never.
 */
function probe(n: number, name = NAME): boolean {
  const result = reserveSpaceRoom(name, n, { notify: false });
  if (result.ok) result.reservation.release();
  return result.ok;
}

/**
 * Asserts the room available to new writes.
 * @param available - Expected available bytes (above 0).
 * @param name - Canonical document name.
 * @throws {AssertionError} When the room differs.
 */
function expectAvailable(available: number, name = NAME): void {
  expect(probe(available, name)).toBe(true);
  expect(probe(available + 1, name)).toBe(false);
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

describe('writeSpaceDoc and reserveSpaceRoom results (W-38 to W-40)', () => {
  it('W-38 returns exactly the documented shapes', () => {
    const provider = openWith(F_FULL);
    expect(writeSpaceDoc(NAME, { kind: 'add' }, vi.fn())).toEqual({ ok: false, reason: 'full' });
    push(provider, F_WARNING);
    expect(writeSpaceDoc(NAME, { kind: 'add', estimate: 786433 }, vi.fn())).toEqual({ ok: false, reason: 'no_room', room: 786432 });
    push(provider, F_FULL_NEAR);
    expect(writeSpaceDoc(NAME, { kind: 'overwrite' }, vi.fn())).toEqual({ ok: false, reason: 'full' });
    push(provider, F_NORMAL);
    expect(writeSpaceDoc(NAME, { kind: 'delete' }, vi.fn())).toEqual({ ok: true });
  });

  it('W-39 notify: false refuses the same way without a toast', () => {
    const provider = openWith(F_FULL);
    expect(writeSpaceDoc(NAME, { kind: 'add', notify: false }, vi.fn())).toEqual({ ok: false, reason: 'full' });
    push(provider, F_WARNING);
    expect(writeSpaceDoc(NAME, { kind: 'add', estimate: 786433, notify: false }, vi.fn())).toEqual({ ok: false, reason: 'no_room', room: 786432 });
    expect(reserveSpaceRoom(NAME, 786433, { notify: false })).toEqual({ ok: false, reason: 'no_room', room: 786432 });
    push(provider, F_FULL_NEAR);
    expect(writeSpaceDoc(NAME, { kind: 'overwrite', notify: false }, vi.fn())).toEqual({ ok: false, reason: 'full' });
    expect(toast.warning).toHaveBeenCalledTimes(0);
  });

  it('W-40 a document never acquired is unknown and lets both functions through', () => {
    const name = 'project-p9/canvas-x';
    const write = vi.fn();
    expect(writeSpaceDoc(name, { kind: 'add', estimate: 0 }, write)).toEqual({ ok: true });
    expect(write).toHaveBeenCalledTimes(1);
    expect(reserveSpaceRoom(name, 0).ok).toBe(true);
  });

  it('W-40 neither function throws while full or resyncing', () => {
    openWith(F_FULL);
    expect(() => writeSpaceDoc(NAME, { kind: 'add', estimate: 0 }, vi.fn())).not.toThrow();
    expect(() => reserveSpaceRoom(NAME, 0)).not.toThrow();
    const other = 'project-p1/canvas-s2';
    const provider = openWith(F_NORMAL, other);
    refuse(provider);
    open(other);
    expect(() => writeSpaceDoc(other, { kind: 'add', estimate: 0 }, vi.fn())).not.toThrow();
    expect(() => reserveSpaceRoom(other, 0)).not.toThrow();
  });

  it('W-40 an error thrown by the write itself propagates and leaves no reservation', () => {
    openWith(F_WARNING);
    expect(() => writeSpaceDoc(NAME, { kind: 'add', estimate: 100 }, () => { throw new Error('boom'); })).toThrow('boom');
    expectAvailable(786432);
  });
});

describe('writeSpaceDoc rules (W-41 to W-44)', () => {
  it('W-41 a valid reservation does not let an add through once the Space is full', () => {
    const provider = openWith(F_WARNING);
    const r = reserveSpaceRoom(NAME, 500000);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    push(provider, F_FULL);
    const write = vi.fn();
    expect(writeSpaceDoc(NAME, { kind: 'add', estimate: 500000, reservation: r.reservation }, write)).toEqual({ ok: false, reason: 'full' });
    expect(write).toHaveBeenCalledTimes(0);
    expect(warnings()).toEqual([COPY_EN.T_ADD_BLOCKED]);
    r.reservation.release();
    push(provider, F_WARNING);
    expectAvailable(786432);
  });

  it('W-42 an add without an estimate passes and records nothing', () => {
    openWith(F_WARNING);
    const write = vi.fn();
    expect(writeSpaceDoc(NAME, { kind: 'add' }, write)).toEqual({ ok: true });
    expect(write).toHaveBeenCalledTimes(1);
    expectAvailable(786432);
  });

  it('W-43 an add with an estimate and no reservation records one, released by receipt and push', async () => {
    const provider = open();
    await handshake(NAME, provider);
    push(provider, F_WARNING);
    const doc = getDoc(NAME);
    expect(writeSpaceDoc(NAME, { kind: 'add', estimate: 100000 }, () => doc.getMap('nodesMap').set('n1', new Y.Map()))).toEqual({ ok: true });
    await flush();
    expectAvailable(686432);
    await confirmLatest(provider);
    push(provider, { ...F_WARNING, bytes: 9537184, room: 686432, overwriteRoom: 1145184 });
    expectAvailable(686432);
    push(provider, F_WARNING);
    expectAvailable(786432);
  });

  it('W-44 reserveSpaceRoom accepts exactly the room and 0', () => {
    openWith(F_WARNING);
    const exact = reserveSpaceRoom(NAME, 786432);
    expect(exact.ok).toBe(true);
    const other = 'project-p1/canvas-s2';
    openWith(F_WARNING, other);
    expect(reserveSpaceRoom(other, 786433)).toEqual({ ok: false, reason: 'no_room', room: 786432 });
    const third = 'project-p1/canvas-s3';
    openWith(F_WARNING, third);
    expect(reserveSpaceRoom(third, 0).ok).toBe(true);
    expectAvailable(786432, third);
  });
});

describe('refusal copy by kind and Space type (W-45)', () => {
  it.each([
    ['canvas', NAME, F_FULL, 'add', undefined, COPY_EN.T_ADD_BLOCKED],
    ['document', DOCUMENT, F_FULL, 'add', undefined, COPY_EN.T_ADD_BLOCKED],
    ['canvas', NAME, F_FULL_NEAR, 'overwrite', undefined, COPY_EN.T_OVERWRITE_BLOCKED],
    ['document', DOCUMENT, F_OVER, 'overwrite', undefined, COPY_EN.T_OVERWRITE_BLOCKED],
    ['canvas', NAME, F_WARNING, 'add', 786433, COPY_EN.T_NO_ROOM('768 KiB')],
    ['timeline', TIMELINE, F_FULL, 'add', undefined, COPY_EN.T_TIMELINE_FULL],
    ['timeline', TIMELINE, F_FULL_NEAR, 'overwrite', undefined, COPY_EN.T_TIMELINE_FULL],
    ['timeline', TIMELINE, F_WARNING, 'add', 786433, COPY_EN.T_NO_ROOM('768 KiB')],
  ] as const)('W-45 %s %s a refused %s shows its copy', (_type, name, fixture, kind, estimate, copy) => {
    openWith(fixture, name);
    writeSpaceDoc(name, { kind, ...(estimate === undefined ? {} : { estimate }) }, vi.fn());
    expect(warnings()).toEqual([copy]);
    expect(toast.error).toHaveBeenCalledTimes(0);
  });

  it('W-45 canvas full: a refused reservation shows the add-blocked copy', () => {
    openWith(F_FULL);
    reserveSpaceRoom(NAME, 1);
    expect(warnings()).toEqual([COPY_EN.T_ADD_BLOCKED]);
    expect(toast.error).toHaveBeenCalledTimes(0);
  });
});

describe('no read-only gate of its own (W-145)', () => {
  it('W-145 writeSpaceDoc lets a read-only connection write', () => {
    const provider = open();
    provider.authorizedScope = 'readonly';
    push(provider, F_NORMAL);
    const write = vi.fn();
    expect(writeSpaceDoc(NAME, { kind: 'add', estimate: 100 }, write)).toEqual({ ok: true });
    expect(write).toHaveBeenCalledTimes(1);
  });
});

describe('a write that lands after writeSpaceDoc returns (landsLater)', () => {
  it('ties its room to the local update that follows, not to the version before it', async () => {
    const provider = open();
    await handshake(NAME, provider);
    push(provider, F_WARNING);
    const doc = getDoc(NAME);
    // An earlier write whose receipt is requested first.
    expect(writeSpaceDoc(NAME, { kind: 'delete' }, () => doc.getMap('nodesMap').set('a', 1))).toEqual({ ok: true });
    await flush();
    const earlier = confirmRequests(provider).at(-1)!.id;
    // The editor's filter allows the add; the sync plugin writes it afterwards.
    expect(writeSpaceDoc(NAME, { kind: 'add', estimate: 100000, landsLater: true }, () => undefined)).toEqual({ ok: true });
    doc.getMap('nodesMap').set('b', 2);
    await flush();
    // Only the earlier write is confirmed when the next push arrives.
    await confirmId(provider, earlier);
    push(provider, F_WARNING);
    expectAvailable(686432);
  });

  it('falls back to the current version when no local update follows', async () => {
    const provider = open();
    await handshake(NAME, provider);
    push(provider, F_WARNING);
    expect(writeSpaceDoc(NAME, { kind: 'add', estimate: 100000, landsLater: true }, () => undefined)).toEqual({ ok: true });
    await flush();
    expectAvailable(686432);
    push(provider, F_WARNING);
    expectAvailable(786432);
  });
});
