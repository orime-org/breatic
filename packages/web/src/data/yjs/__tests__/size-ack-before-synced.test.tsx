// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * Space document size cap, round 9 (inner#1790 web spec 25, design 5.1 and
 * 5.6 "握手与确认的顺序", Z3): a `doc:size` push that arrives before the
 * provider has synced is acknowledged only once it syncs, and only the latest
 * one, so the acknowledgement follows this connection's SyncStep2. A push on
 * a synced provider is still acknowledged inside its callback.
 *
 * Transport: `H9`, the scripted server of `helpers/handshake-server.ts` in
 * single-step mode under production `acquireDocProvider` on the real
 * Hocuspocus provider and socket: `authenticated` and the server's SyncStep1
 * and SyncStep2 (in that order) reach the client only when a case releases
 * them.
 */

import { act, renderHook } from '@testing-library/react';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';

const h7 = await vi.hoisted(async () => {
  const m = await import('@web/data/yjs/__tests__/helpers/handshake-server');
  m.installScriptedWebSocket();
  return m;
});

vi.mock('@web/data/yjs/collab-failure-report', () => ({ reportCollabFailure: vi.fn() }));
vi.mock('@web/lib/toast', () => ({
  toast: { warning: vi.fn(), error: vi.fn(), success: vi.fn(), info: vi.fn(), loading: vi.fn(), dismiss: vi.fn() },
  muteToasts: vi.fn(),
  _unmuteToastsForTests: vi.fn(),
}));

import {
  COLLAB_DOCUMENT_TOO_LARGE_REASON, COLLAB_REAUTH_REASONS, DocSizeSeenSchema, documentBodyFragment,
} from '@breatic/shared';
import { COPY_V2_EN, P_FULL, P_NORMAL, P_WARNING } from '@web/data/yjs/__tests__/helpers/size-v2-fixtures';
import {
  acquireDocProvider, readDocProvider, releaseDocProvider, _resetCollabSocketForTests,
} from '@web/data/yjs/collab-socket';
import { clearAllDocSizes, readDocSize, useDocSize } from '@web/data/yjs/doc-size';
import { docName, getDoc, _resetForTests } from '@web/data/yjs/manager';
import { writeSpaceDoc } from '@web/data/yjs/space-write';
import { toast } from '@web/lib/toast';

const { resetServer, settle } = h7;
type ScriptedServer = InstanceType<typeof h7.ScriptedServer>;
type ScriptedWebSocket = InstanceType<typeof h7.ScriptedWebSocket>;

const PID = 'p1';
const CANVAS = docName.canvasSpace(PID, 's1');
const DOCUMENT = docName.documentSpace(PID, 'd1');
const TIMELINE = docName.timelineSpace(PID, 't1');
const SCENE = docName.threeDSpace(PID, 'x1');
const META = docName.projectMeta(PID);

const SPACES = [
  ['canvas', CANVAS],
  ['document', DOCUMENT],
  ['3d', SCENE],
  ['timeline', TIMELINE],
] as const;

let server: ScriptedServer;

/** What the cases read and drive on the production provider. */
interface Provider {
  readonly synced: boolean;
  sendStateless: (payload: string) => void;
  on: (event: string, listener: (data: unknown) => void) => void;
}

/** One document opened on `H9`. */
interface Opened {
  name: string;
  doc: Y.Doc;
  provider: Provider;
  /** How many `synced` events the provider emitted. */
  syncedEvents: () => number;
  /** The connection the current handshake runs on. */
  socket: () => ScriptedWebSocket;
}

/**
 * Waits on real timers until a condition holds.
 * @param condition - The condition.
 * @param label - Shown when it never holds.
 * @returns Resolves once it holds.
 * @throws {AssertionError} When it does not hold within about 4 seconds.
 */
async function until(condition: () => boolean, label: string): Promise<void> {
  for (let i = 0; i < 400 && !condition(); i += 1) await settle(1);
  expect(condition(), label).toBe(true);
}

/**
 * The newest connection the server saw.
 * @returns The connection.
 * @throws {Error} When there is none.
 */
function newest(): ScriptedWebSocket {
  const socket = server.sockets.at(-1);
  if (socket === undefined) throw new Error('no connection');
  return socket;
}

/**
 * Waits until the client has sent Auth and SyncStep1 for a document on the
 * newest connection since a mark, and the server holds `authenticated`.
 * @param name - Canonical document name.
 * @param from - The first frame index to look at.
 * @returns Resolves when both arrived.
 * @throws {AssertionError} When they do not.
 */
async function untilHandshakeStarts(name: string, from = 0): Promise<void> {
  await until(() => {
    const kinds = server.order(name, from, newest());
    return kinds.includes('auth') && kinds.includes('step1') && server.holds('authenticated', name);
  }, `auth and step1 of ${name}`);
}

/**
 * Opens a document with its production provider on `H9` and waits until its
 * Auth and SyncStep1 reached the server; nothing the server answers is released.
 * @param name - Canonical document name.
 * @param options - How the server authorizes it.
 * @param options.scope - The scope `authenticated` carries.
 * @returns The opened document.
 * @throws {AssertionError} When the handshake does not start.
 */
async function open(name: string, options: { scope?: string } = {}): Promise<Opened> {
  if (options.scope !== undefined) server.scopes.set(name, options.scope);
  const from = server.mark();
  const doc = getDoc(name);
  const provider = acquireDocProvider(name, doc) as unknown as Provider;
  let synced = 0;
  provider.on('synced', () => { synced += 1; });
  await untilHandshakeStarts(name, from);
  return { name, doc, provider, syncedEvents: () => synced, socket: newest };
}

/**
 * Releases the server's SyncStep1 and SyncStep2, checking the spec 25.0
 * precondition: not synced before SyncStep2, synced with exactly one more
 * `synced` event after it.
 * @param opened - The document.
 * @param between - Runs after SyncStep1 is released, before SyncStep2.
 * @throws {AssertionError} When the precondition does not hold.
 */
function finishHandshake(opened: Opened, between?: () => void): void {
  const events = opened.syncedEvents();
  server.release('serverStep1', opened.name);
  between?.();
  expect(opened.provider.synced).toBe(false);
  server.release('serverStep2', opened.name);
  expect(opened.provider.synced).toBe(true);
  expect(opened.syncedEvents()).toBe(events + 1);
}

/**
 * Releases `authenticated`, then the server's two sync steps.
 * @param opened - The document.
 * @throws {AssertionError} When the precondition of {@link finishHandshake} does not hold.
 */
function handshake(opened: Opened): void {
  server.release('authenticated', opened.name);
  finishHandshake(opened);
}

/**
 * The `seen` frames of one document since a mark.
 * @param name - Canonical document name.
 * @param from - The first frame index.
 * @param socket - Only the frames of this connection.
 * @returns The kinds.
 * @throws {never} Never.
 */
function seen(name: string, from = 0, socket?: ScriptedWebSocket): string[] {
  return server.order(name, from, socket).filter((kind) => kind.startsWith('seen('));
}

/**
 * Drops the current connection like a network failure and waits until the
 * provider's reconnect has sent Auth and SyncStep1 on a new one.
 * @param opened - The document.
 * @param whileDown - Runs while no connection is open.
 * @returns The frame index the new connection's frames start at.
 * @throws {AssertionError} When the provider does not reconnect.
 */
async function dropAndReconnect(opened: Opened, whileDown?: () => void): Promise<number> {
  const old = opened.socket();
  const from = server.mark();
  old.drop();
  expect(opened.provider.synced).toBe(false);
  whileDown?.();
  await until(() => newest() !== old, 'the provider dials again');
  await untilHandshakeStarts(opened.name, from);
  return from;
}

/**
 * Whether an update, applied to a copy of a document state, brings the offline item `b1`.
 * @param name - Canonical document name.
 * @param base - The state the copy starts from.
 * @param update - The update.
 * @returns Whether the copy then holds `b1`.
 * @throws {never} Never.
 */
function carriesB1(name: string, base: Uint8Array, update: Uint8Array): boolean {
  const copy = new Y.Doc();
  Y.applyUpdate(copy, base);
  Y.applyUpdate(copy, update);
  const found = name === CANVAS
    ? copy.getMap('nodesMap').has('b1')
    : documentBodyFragment(copy).toString().includes('offline-b1');
  copy.destroy();
  return found;
}

/**
 * Writes the offline item `b1` through the size gate: a canvas node, or a passage at the end of the document body.
 * @param name - Canonical document name.
 * @param doc - The document.
 * @returns What the gate answered.
 * @throws {never} Never.
 */
function writeB1(name: string, doc: Y.Doc): ReturnType<typeof writeSpaceDoc> {
  return writeSpaceDoc(name, { kind: 'add' }, () => {
    doc.transact(() => {
      if (name === CANVAS) doc.getMap('nodesMap').set('b1', new Y.Map());
      else {
        const body = documentBodyFragment(doc);
        body.insert(body.length, [new Y.XmlText('offline-b1')]);
      }
    });
  });
}

beforeEach(() => {
  server = resetServer();
  server.stepping = true;
  vi.mocked(toast.warning).mockClear();
});

afterEach(() => {
  vi.useRealTimers();
  _resetCollabSocketForTests();
  clearAllDocSizes();
  _resetForTests();
});

afterAll(() => {
  h7.uninstallScriptedWebSocket();
});

describe('25.1 a push before the handshake completes is acknowledged once the provider syncs', () => {
  it.each(SPACES)('W9-01 %s: a push after authenticated and before the server SyncStep1 is not acknowledged while unsynced', async (_label, name) => {
    const opened = await open(name);
    server.release('authenticated', name);
    const mark = server.mark();
    server.push(name, P_FULL, 3);
    expect(opened.provider.synced).toBe(false);
    // The push was delivered synchronously: whatever its callback sent is recorded now.
    expect(seen(name, mark)).toEqual([]);
    await settle();
    expect(opened.provider.synced).toBe(false);
    expect(seen(name)).toEqual([]);
  });

  it.each(SPACES)('W9-02 %s: the deferred seen(3) leaves when the provider syncs, after the client SyncStep2', async (_label, name) => {
    const opened = await open(name);
    server.release('authenticated', name);
    server.push(name, P_FULL, 3);
    const beforeStep1 = server.mark();
    server.release('serverStep1', name);
    expect(server.order(name, beforeStep1)).toEqual(['step2']);
    expect(opened.provider.synced).toBe(false);
    const beforeStep2 = server.mark();
    server.release('serverStep2', name);
    expect(opened.provider.synced).toBe(true);
    expect(opened.syncedEvents()).toBe(1);
    const after = server.frames.slice(beforeStep2).filter(({ frame }) => frame.name === name && h7.kindOf(frame).startsWith('seen('));
    expect(after).toHaveLength(1);
    const [only] = after;
    const payload = only?.frame.kind === 'stateless' ? only.frame.payload : '';
    expect(payload).toBe('{"type":"doc:size-seen","seq":3}');
    expect(DocSizeSeenSchema.safeParse(JSON.parse(payload)).success).toBe(true);
    expect(server.order(name)).toEqual(['auth', 'step1', 'step2', 'seen(3)']);
    await settle();
    expect(seen(name)).toEqual(['seen(3)']);
  });

  it.each([
    ['both before the server SyncStep1', false],
    ['one before the server SyncStep1, one between the two sync steps', true],
  ] as const)('W9-03 only the latest of two unsynced pushes is acknowledged (%s)', async (_label, split) => {
    const opened = await open(CANVAS);
    server.release('authenticated', CANVAS);
    server.push(CANVAS, P_WARNING, 3);
    if (!split) server.push(CANVAS, P_FULL, 4);
    finishHandshake(opened, () => {
      if (split) server.push(CANVAS, P_FULL, 4);
      expect(seen(CANVAS)).toEqual([]);
    });
    await settle();
    expect(seen(CANVAS)).toEqual(['seen(4)']);
    expect(server.order(CANVAS)).toEqual(['auth', 'step1', 'step2', 'seen(4)']);
  });

  it.each(SPACES)('W9-04 %s (regression guard): a push on a synced provider is acknowledged inside its callback, after setDocSize', async (_label, name) => {
    const opened = await open(name);
    handshake(opened);
    const phases: string[] = [];
    server.onFrame = (frame): void => {
      if (frame.kind === 'stateless' && frame.payload.includes('doc:size-seen')) phases.push(readDocSize(name).phase);
    };
    const mark = server.mark();
    server.push(name, P_FULL, 5);
    expect(seen(name, mark)).toEqual(['seen(5)']);
    expect(phases).toEqual(['full']);
  });

  it.each([
    ['canvas', CANVAS],
    ['document', DOCUMENT],
  ] as const)('W9-05 %s: after a reconnect, the full push is acknowledged after the SyncStep2 that carries the offline write', async (_label, name) => {
    const opened = await open(name);
    handshake(opened);
    server.push(name, P_WARNING, 5);
    expect(seen(name)).toEqual(['seen(5)']);
    expect(readDocSize(name).phase).toBe('warning');
    const base = Y.encodeStateAsUpdate(server.docOf(name));

    const from = await dropAndReconnect(opened, () => {
      expect(writeB1(name, opened.doc)).toEqual({ ok: true });
    });
    const socket = opened.socket();
    server.release('authenticated', name);
    server.push(name, P_FULL, 6);
    expect(seen(name, from)).toEqual([]);
    expect(readDocSize(name).phase).toBe('full');

    server.release('serverStep1', name);
    const step2 = server.frames.slice(from).find(({ frame, socket: on }) => on === socket && frame.name === name && frame.kind === 'step2');
    expect(step2).toBeDefined();
    expect(step2?.frame.kind === 'step2' && carriesB1(name, base, step2.frame.update)).toBe(true);
    expect(seen(name, from)).toEqual([]);

    server.release('serverStep2', name);
    expect(opened.provider.synced).toBe(true);
    expect(seen(name, from)).toEqual(['seen(6)']);

    const onNew = server.frames.slice(from).filter(({ frame, socket: on }) => on === socket && frame.name === name);
    const seenAt = onNew.findIndex(({ frame }) => h7.kindOf(frame) === 'seen(6)');
    const carrying = onNew
      .map(({ frame }, index) => ({ frame, index }))
      .filter(({ frame }) => (frame.kind === 'step2' || frame.kind === 'update') && carriesB1(name, base, frame.update));
    expect(carrying.length).toBeGreaterThan(0);
    for (const { index } of carrying) expect(index).toBeLessThan(seenAt);
  });

  it('W9-06 a reauth CLOSE on the same socket: the push of the new handshake is acknowledged after its step2', async () => {
    const opened = await open(CANVAS);
    handshake(opened);
    server.push(CANVAS, P_WARNING, 5);
    const mark = server.mark();
    server.closeDocument(CANVAS, COLLAB_REAUTH_REASONS.permissionChanged);
    await until(() => !opened.provider.synced, 'the CLOSE resets synced');
    await untilHandshakeStarts(CANVAS, mark);
    expect(opened.provider.synced).toBe(false);
    server.release('authenticated', CANVAS);
    server.push(CANVAS, P_FULL, 9);
    expect(seen(CANVAS, mark)).toEqual([]);
    finishHandshake(opened);
    await settle();
    expect(server.order(CANVAS, mark)).toEqual(['auth', 'step1', 'step2', 'seen(9)']);
  });

  it('W9-07 a push of a connection dropped before it synced is never acknowledged; the new connection acknowledges its own', async () => {
    const opened = await open(CANVAS);
    const first = opened.socket();
    server.release('authenticated', CANVAS);
    server.push(CANVAS, P_FULL, 3);
    const from = await dropAndReconnect(opened);
    const second = opened.socket();
    server.release('authenticated', CANVAS);
    server.push(CANVAS, P_WARNING, 7);
    finishHandshake(opened);
    await settle();
    expect(seen(CANVAS, 0, first)).toEqual([]);
    expect(server.order(CANVAS, from, second)).toEqual(['auth', 'step1', 'step2', 'seen(7)']);
    expect(seen(CANVAS)).toEqual(['seen(7)']);
  });

  it('W9-08 (a) a reconnect that brings no push sends no seen when it syncs', async () => {
    const opened = await open(CANVAS);
    handshake(opened);
    await dropAndReconnect(opened);
    handshake(opened);
    await settle();
    expect(seen(CANVAS)).toEqual([]);
  });

  it('W9-08 (b) a seq acknowledged on sync is forgotten: the next sync without a push sends nothing', async () => {
    const opened = await open(CANVAS);
    server.release('authenticated', CANVAS);
    server.push(CANVAS, P_FULL, 3);
    finishHandshake(opened);
    expect(seen(CANVAS)).toEqual(['seen(3)']);
    const from = await dropAndReconnect(opened);
    handshake(opened);
    await settle();
    expect(seen(CANVAS, from)).toEqual([]);
    expect(seen(CANVAS)).toEqual(['seen(3)']);
  });

  it('W9-09 an unsynced push updates the local size at once: readDocSize, useDocSize subscribers and the write gate', async () => {
    const opened = await open(CANVAS);
    server.release('authenticated', CANVAS);
    server.push(CANVAS, P_WARNING, 2);
    expect(readDocSize(CANVAS).phase).toBe('warning');
    let renders = 0;
    renderHook(() => {
      renders += 1;
      return useDocSize(CANVAS);
    });
    const rendered = renders;
    act(() => { server.push(CANVAS, P_FULL, 3); });
    expect(opened.provider.synced).toBe(false);
    expect(readDocSize(CANVAS)).toMatchObject({ phase: 'full', bytes: P_FULL.bytes, limit: P_FULL.limit, ceiling: P_FULL.ceiling });
    expect(renders).toBe(rendered + 1);
    const write = vi.fn();
    const local: Uint8Array[] = [];
    const listener = (update: Uint8Array, _origin: unknown, _doc: Y.Doc, transaction: Y.Transaction): void => {
      if (transaction.local) local.push(update);
    };
    opened.doc.on('update', listener);
    expect(writeSpaceDoc(CANVAS, { kind: 'add' }, write)).toEqual({ ok: false, reason: 'full' });
    opened.doc.off('update', listener);
    expect(write).toHaveBeenCalledTimes(0);
    expect(local).toEqual([]);
    expect(toast.warning).toHaveBeenCalledTimes(1);
    expect(vi.mocked(toast.warning).mock.calls[0]?.[0]).toBe(COPY_V2_EN.T_ADD);
  });

  it('W9-10 after a refusal rebuilt the document, the new provider acknowledges only the latest push, after its step2', async () => {
    const old = await open(CANVAS);
    handshake(old);
    server.push(CANVAS, P_FULL, 10);
    server.closeDocument(CANVAS, COLLAB_DOCUMENT_TOO_LARGE_REASON);
    await until(() => readDocProvider(CANVAS) === null, 'the refusal retires the provider');
    expect(readDocSize(CANVAS).phase).toBe('resyncing');
    const mark = server.mark();
    const fresh = await open(CANVAS);
    expect(fresh.provider).not.toBe(old.provider);
    server.release('authenticated', CANVAS);
    server.push(CANVAS, P_FULL, 11);
    server.push(CANVAS, P_WARNING, 12);
    expect(seen(CANVAS, mark)).toEqual([]);
    expect(readDocSize(CANVAS).phase).toBe('resyncing');
    finishHandshake(fresh);
    expect(readDocSize(CANVAS).phase).toBe('warning');
    await settle();
    expect(server.order(CANVAS, mark)).toEqual(['auth', 'step1', 'step2', 'seen(12)']);
  });

  it('W9-11 a retired provider whose events still fire acknowledges nothing; the new provider is unaffected', async () => {
    const old = await open(CANVAS);
    server.release('authenticated', CANVAS);
    server.push(CANVAS, P_WARNING, 5);
    // The listeners the registry gave the provider; destroying it empties a
    // new table but leaves this one, so the retired events can still be fired.
    const retired = (old.provider as unknown as { callbacks: Record<string, Array<(data: unknown) => void>> }).callbacks;
    const sendStateless = vi.spyOn(old.provider, 'sendStateless');
    server.closeDocument(CANVAS, COLLAB_DOCUMENT_TOO_LARGE_REASON);
    await until(() => readDocProvider(CANVAS) === null, 'the refusal retires the provider');
    const mark = server.mark();
    for (const listener of retired.stateless ?? []) listener.call(old.provider, { payload: JSON.stringify({ type: 'doc:size', seq: 6, ...P_FULL }) });
    for (const listener of retired.synced ?? []) listener.call(old.provider, { state: true });
    expect(sendStateless).not.toHaveBeenCalled();
    expect(seen(CANVAS, mark)).toEqual([]);

    const fresh = await open(CANVAS);
    server.release('authenticated', CANVAS);
    server.push(CANVAS, P_NORMAL, 7);
    finishHandshake(fresh);
    await settle();
    expect(sendStateless).not.toHaveBeenCalled();
    expect(server.order(CANVAS, mark)).toEqual(['auth', 'step1', 'step2', 'seen(7)']);
  });

  it('W9-12 releasing an unsynced provider that holds a push sends no seen and forgets the size', async () => {
    const opened = await open(CANVAS);
    server.release('authenticated', CANVAS);
    server.push(CANVAS, P_FULL, 3);
    expect(() => releaseDocProvider(CANVAS, opened.doc)).not.toThrow();
    await until(() => readDocProvider(CANVAS) === null, 'the release destroys the provider');
    await settle();
    expect(seen(CANVAS)).toEqual([]);
    expect(readDocSize(CANVAS).phase).toBe('unknown');
  });

  it('W9-13 a read-only connection defers the same way: seen(3) after its step2', async () => {
    const opened = await open(CANVAS, { scope: 'readonly' });
    server.release('authenticated', CANVAS);
    server.push(CANVAS, P_FULL, 3);
    expect(seen(CANVAS)).toEqual([]);
    finishHandshake(opened);
    await settle();
    expect(server.order(CANVAS)).toEqual(['auth', 'step1', 'step2', 'seen(3)']);
  });

  it('W9-14 a valid push on the meta document is never acknowledged, before or after it syncs', async () => {
    const opened = await open(META);
    server.release('authenticated', META);
    server.push(META, P_FULL, 1);
    finishHandshake(opened);
    await settle();
    expect(seen(META)).toEqual([]);
  });

  it('W9-15 invalid pushes before the handshake completes are not acknowledged and leave the size alone', async () => {
    const opened = await open(CANVAS);
    server.release('authenticated', CANVAS);
    const before = readDocSize(CANVAS);
    const { seq: _seq, ...noSeq } = { seq: 0, ...P_FULL };
    for (const payload of [
      JSON.stringify({ type: 'doc:size', ...noSeq }),
      JSON.stringify({ type: 'doc:size', seq: -1, ...P_FULL }),
      JSON.stringify({ type: 'doc:size', seq: 2, ...P_FULL, phase: 'over' }),
      'not json',
      JSON.stringify({ type: 'sync:confirmed', id: '33333333-3333-4333-8333-333333333333', ok: true }),
    ]) server.pushRaw(CANVAS, payload);
    expect(seen(CANVAS)).toEqual([]);
    finishHandshake(opened);
    await settle();
    expect(seen(CANVAS)).toEqual([]);
    expect(readDocSize(CANVAS)).toEqual(before);
  });

  it('W9-16 the deferred seen goes through SpaceProvider.sendStateless: a buffered Update leaves ahead of it', async () => {
    const opened = await open(CANVAS);
    server.release('authenticated', CANVAS);
    vi.useFakeTimers();
    server.push(CANVAS, P_WARNING, 4);
    server.release('serverStep1', CANVAS);
    opened.doc.transact(() => { opened.doc.getMap('nodesMap').set('w1', new Y.Map()); });
    expect(opened.provider.synced).toBe(false);
    server.release('serverStep2', CANVAS);
    expect(opened.provider.synced).toBe(true);
    expect(server.order(CANVAS).filter((kind) => kind !== 'confirm').slice(-3)).toEqual(['step2', 'update', 'seen(4)']);
    const mark = server.mark();
    await vi.advanceTimersByTimeAsync(50);
    expect(server.order(CANVAS, mark).filter((kind) => kind === 'update')).toEqual([]);
  });
});
