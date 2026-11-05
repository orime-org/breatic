// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

import fc from 'fast-check';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';

import { applyTimelineEdit, initializeTimelineDocument } from '@breatic/shared/space-content';
import type { TimelineVideoClip, TimelineVideoSource } from '@breatic/shared';

const { toast } = vi.hoisted(() => ({
  toast: { warning: vi.fn(), error: vi.fn(), info: vi.fn(), success: vi.fn() },
}));

vi.mock('@web/lib/toast', () => ({ toast }));
vi.mock('@web/data/yjs/collab-failure-report', () => ({ reportCollabFailure: vi.fn() }));
vi.mock('@hocuspocus/provider', async (importOriginal) =>
  (await import('@web/data/yjs/__tests__/helpers/doc-size-driver')).mockProviderModule(await importOriginal()));

import {
  confirmId, confirmLatest, confirmRequests, disconnect, flush, handshake, push, refuse, resetProviderSpies, runTimers,
  synced, type ProviderSpy,
} from '@web/data/yjs/__tests__/helpers/doc-size-driver';
import {
  COPY_EN, F_AFTER_WRITE, F_FULL, F_NORMAL, F_UNLIMITED, F_WARNING, F_WARNING_TIGHT,
} from '@web/data/yjs/__tests__/helpers/doc-size-fixtures';
import { readDocSize } from '@web/data/yjs/doc-size';
import { reserveSpaceRoom, writeSpaceDoc } from '@web/data/yjs/space-write';
import { acquireDocProvider, releaseDocProvider, _resetCollabSocketForTests } from '@web/data/yjs/collab-socket';
import { getDoc, _resetForTests } from '@web/data/yjs/manager';
import { changeLocale } from '@web/i18n/locale-bootstrap';

const NAME = 'project-p1/canvas-s1';

type Reservation = { release: () => void };

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
 * Opens, completes the handshake and pushes F_WARNING (the section's common setup).
 * @param name - Canonical document name.
 * @returns The provider spy of the entry.
 * @throws {Error} When acquiring fails.
 */
async function openWarning(name = NAME): Promise<ProviderSpy> {
  const provider = open(name);
  await handshake(name, provider);
  push(provider, F_WARNING);
  return provider;
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
 * @param available - Expected available bytes.
 * @param name - Canonical document name.
 * @throws {AssertionError} When the room differs.
 */
function expectAvailable(available: number, name = NAME): void {
  if (available === 0) {
    expect(probe(name, 1)).toBe(false);
    expect(reserveSpaceRoom(name, 1, { notify: false })).toEqual({ ok: false, reason: 'no_room', room: 0 });
    return;
  }
  expect(probe(name, available)).toBe(true);
  expect(probe(name, available + 1)).toBe(false);
}

/**
 * Reserves and expects success.
 * @param bytes - Bytes to reserve.
 * @param name - Canonical document name.
 * @returns The reservation handle.
 * @throws {AssertionError} When the reservation is refused.
 */
function reserve(bytes: number, name = NAME): Reservation {
  const result = reserveSpaceRoom(name, bytes, { notify: false });
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error('reservation refused');
  return result.reservation;
}

/**
 * Writes one new node with a reservation (the W-27 write) and lets its receipt request go out.
 * @param reservation - The reservation the write carries.
 * @param estimate - The write's estimate.
 * @param key - The node id written.
 * @param name - Canonical document name.
 * @returns The write result.
 * @throws {never} Never.
 */
async function writeWithReservation(reservation: Reservation, estimate = 500000, key = 'n1', name = NAME): Promise<unknown> {
  const doc = getDoc(name);
  const result = writeSpaceDoc(name, { kind: 'add', estimate, reservation }, () => doc.getMap('nodesMap').set(key, new Y.Map()));
  await flush();
  return result;
}

/**
 * Puts a node into the document as a remote update, so a later local delete has something to remove.
 * @param provider - The provider the update arrives on.
 * @param key - The node id.
 * @param name - Canonical document name.
 * @throws {never} Never.
 */
function seedRemote(provider: ProviderSpy, key: string, name = NAME): void {
  const peer = new Y.Doc();
  try {
    peer.getMap('nodesMap').set(key, 1);
    Y.applyUpdate(getDoc(name), Y.encodeStateAsUpdate(peer), provider);
  } finally { peer.destroy(); }
}

/**
 * A local delete without a reservation.
 * @param key - The node id removed.
 * @param name - Canonical document name.
 * @returns Resolves after its receipt request went out.
 * @throws {AssertionError} When the delete is refused.
 */
async function localDelete(key: string, name = NAME): Promise<void> {
  const doc = getDoc(name);
  expect(writeSpaceDoc(name, { kind: 'delete' }, () => doc.getMap('nodesMap').delete(key))).toEqual({ ok: true });
  await flush();
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

describe('reservations reduce the room (W-23 to W-26)', () => {
  it('W-23 a reservation takes its bytes off the room', async () => {
    await openWarning();
    const result = reserveSpaceRoom(NAME, 500000);
    expect(result.ok).toBe(true);
    expect(typeof (result as { reservation: Reservation }).reservation.release).toBe('function');
    expectAvailable(286432);
    expect(toast.warning).toHaveBeenCalledTimes(0);
  });

  it('W-24 several reservations add up and one over the rest is refused', async () => {
    await openWarning();
    const a = reserveSpaceRoom(NAME, 500000);
    const b = reserveSpaceRoom(NAME, 286432);
    const c = reserveSpaceRoom(NAME, 1);
    expect(a.ok).toBe(true);
    expect(b.ok).toBe(true);
    expect(c).toEqual({ ok: false, reason: 'no_room', room: 0 });
    expect(warnings()).toEqual([COPY_EN.T_NO_ROOM('0 B')]);
    (a as { reservation: Reservation }).reservation.release();
    expect(probe(NAME, 500000)).toBe(true);
    expect(probe(NAME, 500001)).toBe(false);
  });

  it('W-25 a reservation is refused while full and while resyncing', async () => {
    const provider = await openWarning();
    push(provider, F_FULL);
    expect(reserveSpaceRoom(NAME, 1)).toEqual({ ok: false, reason: 'full' });
    expect(warnings()).toEqual([COPY_EN.T_ADD_BLOCKED]);
    expect(reserveSpaceRoom(NAME, 1, { notify: false })).toEqual({ ok: false, reason: 'full' });
    expect(toast.warning).toHaveBeenCalledTimes(1);

    const other = 'project-p1/canvas-s2';
    const otherProvider = await openWarning(other);
    refuse(otherProvider);
    open(other);
    expect(reserveSpaceRoom(other, 1)).toEqual({ ok: false, reason: 'full' });
    expect(reserveSpaceRoom(other, 1, { notify: false })).toEqual({ ok: false, reason: 'full' });
    expect(warnings().filter((message) => message !== COPY_EN.T_RESYNC)).toEqual([COPY_EN.T_ADD_BLOCKED]);
  });

  it('W-26 release gives the bytes back once, and an immediate retry is accepted', async () => {
    await openWarning();
    const r = reserve(786432);
    r.release();
    expect(probe(NAME, 786432)).toBe(true);
    r.release();
    expectAvailable(786432);
    const r2 = reserveSpaceRoom(NAME, 786432);
    expect(r2.ok).toBe(true);
    expect(probe(NAME, 1)).toBe(false);
  });
});

describe('writes that carry a reservation (W-27 to W-29, W-138 to W-140)', () => {
  it('W-27 a write with its reservation passes and is not counted twice', async () => {
    await openWarning();
    const r = reserve(500000);
    expect(await writeWithReservation(r)).toEqual({ ok: true });
    expect(getDoc(NAME).getMap('nodesMap').has('n1')).toBe(true);
    expectAvailable(286432);
  });

  it('W-28a a write with a released reservation is checked like one without', async () => {
    const provider = await openWarning();
    const r = reserve(500000);
    r.release();
    push(provider, F_WARNING_TIGHT);
    const write = vi.fn();
    expect(writeSpaceDoc(NAME, { kind: 'add', estimate: 500000, reservation: r }, write)).toEqual({ ok: false, reason: 'no_room', room: 1 });
    expect(write).toHaveBeenCalledTimes(0);
    expect(warnings()).toEqual([COPY_EN.T_NO_ROOM('1 B')]);
  });

  it('W-28b a write with a released reservation that fits records a new reservation', async () => {
    await openWarning();
    const r = reserve(500000);
    r.release();
    expect(await writeWithReservation(r)).toEqual({ ok: true });
    expectAvailable(286432);
  });

  it('W-29 the reservation outlives a stale push, survives the receipt alone and goes with the push after it', async () => {
    const provider = await openWarning();
    const r = reserve(500000);
    expect(await writeWithReservation(r)).toEqual({ ok: true });
    expect(confirmRequests(provider)).toHaveLength(1);
    push(provider, F_WARNING);
    expectAvailable(286432);
    await confirmLatest(provider);
    expectAvailable(286432);
    push(provider, F_AFTER_WRITE);
    expectAvailable(286432);
    await runTimers();
    expectAvailable(286432);
    r.release();
    expectAvailable(286432);
  });

  it('W-138 a reservation already used by a write counts as none on a second write', async () => {
    await openWarning();
    const r = reserve(500000);
    expect(await writeWithReservation(r)).toEqual({ ok: true });
    const w1 = vi.fn();
    expect(writeSpaceDoc(NAME, { kind: 'add', estimate: 300000, reservation: r }, w1)).toEqual({ ok: false, reason: 'no_room', room: 286432 });
    expect(w1).toHaveBeenCalledTimes(0);
    const w2 = vi.fn();
    expect(writeSpaceDoc(NAME, { kind: 'add', estimate: 200000, reservation: r }, w2)).toEqual({ ok: true });
    expect(w2).toHaveBeenCalledTimes(1);
    expectAvailable(86432);
  });

  it('W-139 release() on a reservation already used by a write does nothing', async () => {
    const provider = await openWarning();
    const r = reserve(500000);
    expect(await writeWithReservation(r)).toEqual({ ok: true });
    r.release();
    expectAvailable(286432);
    await confirmLatest(provider);
    push(provider, F_AFTER_WRITE);
    expectAvailable(286432);
  });

  it('W-140a an estimate above its reservation is refused when the excess does not fit', async () => {
    await openWarning();
    const r = reserve(300000);
    expectAvailable(486432);
    const w1 = vi.fn();
    expect(writeSpaceDoc(NAME, { kind: 'add', estimate: 800000, reservation: r }, w1)).toEqual({ ok: false, reason: 'no_room', room: 486432 });
    expect(w1).toHaveBeenCalledTimes(0);
    expectAvailable(486432);
  });

  it('W-140b an estimate above its reservation passes when the excess equals the room', async () => {
    await openWarning();
    const r = reserve(300000);
    const w2 = vi.fn();
    expect(writeSpaceDoc(NAME, { kind: 'add', estimate: 786432, reservation: r }, w2)).toEqual({ ok: true });
    expect(w2).toHaveBeenCalledTimes(1);
    expect(reserveSpaceRoom(NAME, 1, { notify: false })).toEqual({ ok: false, reason: 'no_room', room: 0 });
  });
});

describe('what keeps and what drops reservations (W-30 to W-36, W-141)', () => {
  it('W-30 a reservation without a write ignores receipts, pushes and disconnects', async () => {
    const provider = await openWarning();
    seedRemote(provider, 'd1');
    reserve(500000);
    await localDelete('d1');
    await confirmLatest(provider);
    expectAvailable(286432);
    push(provider, F_WARNING);
    expectAvailable(286432);
    disconnect(provider);
    expectAvailable(286432);
    await handshake(NAME, provider);
    push(provider, F_WARNING);
    expectAvailable(286432);
  });

  it('W-31 an offline write keeps its reservation until the new connection confirms it', async () => {
    const provider = await openWarning();
    seedRemote(provider, 'd1');
    const r = reserve(500000);
    await localDelete('d1');
    const oldId = confirmRequests(provider).at(-1)!.id;
    disconnect(provider);
    expect(await writeWithReservation(r)).toEqual({ ok: true });
    push(provider, F_WARNING);
    await confirmId(provider, oldId);
    expectAvailable(286432);
    await handshake(NAME, provider);
    const newId = confirmRequests(provider).at(-1)!.id;
    expect(newId).not.toBe(oldId);
    await confirmId(provider, newId);
    push(provider, F_AFTER_WRITE);
    expectAvailable(286432);
    r.release();
    expectAvailable(286432);
  });

  it('W-32 resetDocument drops every reservation of the document', async () => {
    const provider = await openWarning();
    const a = reserve(300000);
    const b = reserve(200000);
    expect(await writeWithReservation(b, 200000)).toEqual({ ok: true });
    refuse(provider);
    const next = open();
    push(next, F_WARNING);
    synced(next);
    expectAvailable(786432);
    expect(() => { a.release(); b.release(); }).not.toThrow();
    expectAvailable(786432);
  });

  it('W-33 closing the Space drops its reservations', async () => {
    await openWarning();
    const a = reserve(300000);
    const b = reserve(200000);
    expect(await writeWithReservation(b, 200000)).toEqual({ ok: true });
    releaseDocProvider(NAME);
    await runTimers();
    const next = open();
    push(next, F_WARNING);
    expectAvailable(786432);
    expect(() => { a.release(); b.release(); }).not.toThrow();
    expectAvailable(786432);
  });

  it('W-34 a limit = 0 push drops every reservation', async () => {
    const provider = await openWarning();
    reserve(300000);
    const b = reserve(200000);
    expect(await writeWithReservation(b, 200000)).toEqual({ ok: true });
    push(provider, F_UNLIMITED);
    expect(readDocSize(NAME).phase).toBe('unknown');
    push(provider, F_WARNING);
    expectAvailable(786432);
  });

  it('W-35 without reservations every push sets the room exactly', async () => {
    const provider = await openWarning();
    seedRemote(provider, 'd1');
    await localDelete('d1');
    await confirmLatest(provider);
    push(provider, F_WARNING);
    expectAvailable(786432);
    disconnect(provider);
    await handshake(NAME, provider);
    push(provider, F_NORMAL);
    expectAvailable(9175040);
    refuse(provider);
    const next = open();
    push(next, F_WARNING);
    synced(next);
    expectAvailable(786432);
    push(next, F_UNLIMITED);
    push(next, F_WARNING);
    expectAvailable(786432);
  });

  it('W-36 a timeline reservation goes with the receipt and the push after it', async () => {
    const name = 'project-p1/timeline-s3';
    const doc = getDoc(name);
    const seed = new Y.Doc();
    try {
      initializeTimelineDocument(seed, { width: 1920, height: 1080, fps: { num: 24, den: 1 } });
      Y.applyUpdate(doc, Y.encodeStateAsUpdate(seed), 'server');
    } finally { seed.destroy(); }
    const provider = open(name);
    await handshake(name, provider);
    push(provider, F_WARNING);
    const r = reserveSpaceRoom(name, 500000, { notify: false });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const source: TimelineVideoSource = {
      id: '10000000-0000-4000-8000-000000000001', kind: 'video', assetId: '20000000-0000-4000-8000-000000000001',
      timebase: { num: 24, den: 1 }, extentFrames: 48, durationSeconds: '2', durationOrigin: 'registered',
    };
    const clip: TimelineVideoClip = {
      id: '30000000-0000-4000-8000-000000000001', kind: 'video', trackId: 'visual-1', sourceId: source.id,
      startFrame: 0, sourceInFrame: 0, durationFrames: 48, rate: { num: 1, den: 1 }, gain: 1, mute: false,
      transform: { x: 0, y: 0, scaleX: 1, scaleY: 1, rotation: 0 },
    };
    let applied = false;
    expect(writeSpaceDoc(name, { kind: 'add', estimate: 500000, reservation: r.reservation }, () => {
      applied = applyTimelineEdit(doc, { operation: 'add_video', parameters: { source, clip } });
    })).toEqual({ ok: true });
    expect(applied).toBe(true);
    await flush();
    expect(confirmRequests(provider)).toHaveLength(1);
    await confirmLatest(provider);
    push(provider, F_AFTER_WRITE);
    expectAvailable(286432, name);
  });

  it('W-141a a reservation dropped by a resync counts as none in the new document (full)', async () => {
    const provider = await openWarning();
    const r = reserve(500000);
    refuse(provider);
    const next = open();
    push(next, F_FULL);
    synced(next);
    const write = vi.fn();
    expect(writeSpaceDoc(NAME, { kind: 'add', estimate: 500000, reservation: r }, write)).toEqual({ ok: false, reason: 'full' });
    expect(write).toHaveBeenCalledTimes(0);
    expect(warnings().filter((message) => message !== COPY_EN.T_RESYNC)).toEqual([COPY_EN.T_ADD_BLOCKED]);
  });

  it('W-141b a reservation dropped by a resync counts as none in the new document (warning)', async () => {
    const provider = await openWarning();
    const r = reserve(500000);
    refuse(provider);
    const next = open();
    push(next, F_WARNING);
    synced(next);
    expect(await writeWithReservation(r)).toEqual({ ok: true });
    expectAvailable(286432);
  });
});

/** One generated step of the W-37 property. */
type Command =
  | { type: 'reserve'; n: number }
  | { type: 'release'; i: number }
  | { type: 'writeWith'; i: number }
  | { type: 'writeWithout'; n: number }
  | { type: 'push'; room: number; phase: 'normal' | 'warning' }
  | { type: 'confirm' }
  | { type: 'disconnect' }
  | { type: 'reconnect' }
  | { type: 'unlimited' };

/** A reservation as the reference model tracks it. */
interface ModelReservation { bytes: number; version: number | undefined; released: boolean; handle: Reservation }

const commandArb: fc.Arbitrary<Command> = fc.oneof(
  fc.record({ type: fc.constant('reserve' as const), n: fc.integer({ min: 0, max: 1_000_000 }) }),
  fc.record({ type: fc.constant('release' as const), i: fc.nat() }),
  fc.record({ type: fc.constant('writeWith' as const), i: fc.nat() }),
  fc.record({ type: fc.constant('writeWithout' as const), n: fc.integer({ min: 0, max: 1_000_000 }) }),
  fc.record({ type: fc.constant('push' as const), room: fc.integer({ min: 0, max: 9_175_040 }), phase: fc.constantFrom('normal' as const, 'warning' as const) }),
  fc.constant({ type: 'confirm' as const }),
  fc.constant({ type: 'disconnect' as const }),
  fc.constant({ type: 'reconnect' as const }),
  fc.constant({ type: 'unlimited' as const }),
);

describe('reservation invariants (W-37)', () => {
  it('W-37 the available room always equals the reference model', async () => {
    let run = 0;
    await fc.assert(fc.asyncProperty(fc.array(commandArb, { minLength: 1, maxLength: 40 }), async (commands) => {
      run += 1;
      const name = `project-q${run}/canvas-s1`;
      const doc = getDoc(name);
      const provider = open(name);
      await handshake(name, provider);
      push(provider, F_WARNING);
      // Independent model of DD 6.6 plus the receipt rules of bindDocSync.
      const model = {
        known: true,
        room: 786432,
        reservations: [] as ModelReservation[],
        local: 0,
        confirmed: 0,
        connected: true,
        pending: null as number | null,
      };
      const available = (): number => Math.max(0, model.room - model.reservations.filter((r) => !r.released).reduce((sum, r) => sum + r.bytes, 0));
      const valid = (r: ModelReservation | undefined): r is ModelReservation => r !== undefined && !r.released && r.version === undefined;
      const afterLocalUpdate = (): void => {
        model.local += 1;
        if (model.connected && model.pending === null) model.pending = model.local;
      };
      let key = 0;
      for (const command of commands) {
        switch (command.type) {
          case 'reserve': {
            const result = reserveSpaceRoom(name, command.n, { notify: false });
            if (!model.known) {
              expect(result.ok).toBe(true);
              if (result.ok) model.reservations.push({ bytes: command.n, version: undefined, released: true, handle: result.reservation });
            } else if (command.n <= available()) {
              expect(result.ok).toBe(true);
              if (result.ok) model.reservations.push({ bytes: command.n, version: undefined, released: false, handle: result.reservation });
            } else {
              expect(result).toEqual({ ok: false, reason: 'no_room', room: available() });
            }
            break;
          }
          case 'release': {
            if (model.reservations.length === 0) break;
            const target = model.reservations[command.i % model.reservations.length]!;
            target.handle.release();
            if (valid(target)) target.released = true;
            break;
          }
          case 'writeWith':
          case 'writeWithout': {
            const target = command.type === 'writeWith' && model.reservations.length > 0
              ? model.reservations[command.i % model.reservations.length]
              : undefined;
            if (command.type === 'writeWith' && target === undefined) break;
            const estimate = command.type === 'writeWith' ? target!.bytes : command.n;
            key += 1;
            const id = `k${key}`;
            const result = writeSpaceDoc(name, { kind: 'add', estimate, ...(target ? { reservation: target.handle } : {}) }, () => doc.getMap('nodesMap').set(id, key));
            await flush();
            if (!model.known) {
              expect(result).toEqual({ ok: true });
              afterLocalUpdate();
            } else if (valid(target)) {
              expect(result).toEqual({ ok: true });
              afterLocalUpdate();
              target.version = model.local;
            } else if (estimate <= available()) {
              expect(result).toEqual({ ok: true });
              afterLocalUpdate();
              model.reservations.push({ bytes: estimate, version: model.local, released: false, handle: { release: (): void => undefined } });
            } else {
              expect(result).toEqual({ ok: false, reason: 'no_room', room: available() });
            }
            break;
          }
          case 'push': {
            const bytes = 10485760 - 262144 - command.room;
            push(provider, { bytes, limit: 10485760, ceiling: 10747904, room: command.room, overwriteRoom: 10747904 - bytes - 65536, phase: command.phase });
            model.known = true;
            model.room = command.room;
            for (const r of model.reservations) if (r.version !== undefined && model.confirmed >= r.version) r.released = true;
            break;
          }
          case 'confirm': {
            if (model.pending === null) break;
            await confirmLatest(provider);
            await flush();
            model.confirmed = model.pending;
            model.pending = model.local > model.confirmed ? model.local : null;
            break;
          }
          case 'disconnect':
            disconnect(provider);
            model.connected = false;
            model.pending = null;
            break;
          case 'reconnect':
            await handshake(name, provider);
            model.connected = true;
            if (model.pending === null && model.local > model.confirmed) model.pending = model.local;
            break;
          case 'unlimited':
            push(provider, F_UNLIMITED);
            model.known = false;
            for (const r of model.reservations) r.released = true;
            break;
        }
        if (model.known) {
          expect(probe(name, available())).toBe(true);
          expect(probe(name, available() + 1)).toBe(false);
        } else {
          expect(probe(name, 2 ** 40)).toBe(true);
        }
      }
    }), { seed: 1790, numRuns: 60 });
  });
});
