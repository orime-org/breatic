// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * Space document size cap, round 10 (inner#1790 web spec 26, design 5.1):
 * `synced` turns true only on the server's SyncStep2. Collab still answers an
 * Update of a document connection it has just closed with SyncStatus(1); that
 * frame lands on the provider of the reopened (reauth) or rebuilt (refusal)
 * document, and must not mark it synced before its own handshake, or the
 * deferred acknowledgement, `docSizeSynced`, `hasEverSynced` and `useSocket`
 * all move ahead of the content.
 *
 * Transport: `H9`, the scripted server of `helpers/handshake-server.ts` in
 * single-step mode under production `acquireDocProvider` on the real
 * Hocuspocus provider and socket, plus the SyncStatus frame and same-task
 * document CLOSE of spec 26.0.
 */

import { act, renderHook } from '@testing-library/react';
import * as React from 'react';
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

import { COLLAB_DOCUMENT_TOO_LARGE_REASON, COLLAB_REAUTH_REASONS, documentBodyFragment } from '@breatic/shared';
import { P_FULL, P_WARNING } from '@web/data/yjs/__tests__/helpers/size-v2-fixtures';
import {
  acquireDocProvider, CollabSocketProvider, readDocFacts, readDocProvider, _resetCollabSocketForTests,
} from '@web/data/yjs/collab-socket';
import { clearAllDocSizes, readDocSize } from '@web/data/yjs/doc-size';
import { docName, getDoc, _resetForTests } from '@web/data/yjs/manager';
import { writeSpaceDoc } from '@web/data/yjs/space-write';
import { useSocket, type SocketState } from '@web/data/yjs/use-socket';

const { resetServer, settle, recordProviderEvents } = h7;
type ScriptedServer = InstanceType<typeof h7.ScriptedServer>;
type ScriptedWebSocket = InstanceType<typeof h7.ScriptedWebSocket>;
type ProviderEvents = ReturnType<typeof recordProviderEvents>;

const PID = 'p1';
const CANVAS = docName.canvasSpace(PID, 's1');
const DOCUMENT = docName.documentSpace(PID, 'd1');
const TIMELINE = docName.timelineSpace(PID, 't1');
const SCENE = docName.threeDSpace(PID, 'x1');
const USER = 'u1';

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
  readonly hasUnsyncedChanges: boolean;
  sendStateless: (payload: string) => void;
  on: (event: string, listener: (data: unknown) => void) => void;
}

/** One document opened on `H9`. */
interface Opened {
  name: string;
  doc: Y.Doc;
  provider: Provider;
  events: ProviderEvents;
}

/** The part of `useSocket`'s answer spec 26.1 reads. */
type Connection = Pick<SocketState, 'synced' | 'status' | 'hasEverSynced'>;

const CONNECTING: Connection = { synced: false, status: 'connecting', hasEverSynced: false };
const CONNECTED: Connection = { synced: true, status: 'connected', hasEverSynced: true };
const DISCONNECTED: Connection = { synced: false, status: 'disconnected', hasEverSynced: true };

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
  const events = recordProviderEvents(provider);
  await untilHandshakeStarts(name, from);
  return { name, doc, provider, events };
}

/**
 * Releases `authenticated` and the server's two sync steps, checking the
 * spec 25.0 precondition per handshake (26.0): not synced before SyncStep2,
 * synced with exactly one more `synced` event after it.
 * @param opened - The document.
 * @throws {AssertionError} When the precondition does not hold.
 */
function handshake(opened: Opened): void {
  const events = opened.events.synced;
  server.release('authenticated', opened.name);
  server.release('serverStep1', opened.name);
  expect(opened.provider.synced).toBe(false);
  server.release('serverStep2', opened.name);
  expect(opened.provider.synced).toBe(true);
  expect(opened.events.synced).toBe(events + 1);
}

/**
 * The `seen` frames of one document since a mark.
 * @param name - Canonical document name.
 * @param from - The first frame index.
 * @returns The kinds.
 * @throws {never} Never.
 */
function seen(name: string, from = 0): string[] {
  return server.order(name, from).filter((kind) => kind.startsWith('seen('));
}

/**
 * One document's handshake and `seen` frames since a mark, without receipts and Updates.
 * @param name - Canonical document name.
 * @param from - The first frame index.
 * @returns The kinds.
 * @throws {never} Never.
 */
function handshakeOrder(name: string, from: number): string[] {
  return server.order(name, from).filter((kind) => kind !== 'confirm' && kind !== 'update');
}

/**
 * Writes one item the size gate does not see, and waits until its Update reached the server.
 * @param name - Canonical document name.
 * @param doc - The document.
 * @param write - The write.
 * @returns Resolves once the Update was recorded.
 * @throws {AssertionError} When it never leaves.
 */
async function writeAndSend(name: string, doc: Y.Doc, write: (doc: Y.Doc) => void): Promise<void> {
  const from = server.mark();
  doc.transact(() => { write(doc); });
  await until(() => server.order(name, from).includes('update'), `the Update of ${name} reaches the server`);
}

/**
 * The write of W10-01 (ii): one key on a map no Space reads, so it fits every Space type.
 * @param doc - The document.
 * @throws {never} Never.
 */
function writeInflight(doc: Y.Doc): void {
  doc.getMap('w10').set('inflight', 1);
}

/**
 * The content W10-02 compares between the client and the server: canvas nodes or the document body.
 * @param name - Canonical document name.
 * @param doc - The document.
 * @returns A comparable rendering.
 * @throws {never} Never.
 */
function contentOf(name: string, doc: Y.Doc): string {
  return name === CANVAS ? JSON.stringify(doc.getMap('nodesMap').toJSON()) : documentBodyFragment(doc).toString();
}

/**
 * The write of W10-02: a canvas node, or a passage at the end of the document body.
 * @param name - Canonical document name.
 * @returns The write.
 * @throws {never} Never.
 */
function contentWrite(name: string): (doc: Y.Doc) => void {
  return (doc) => {
    if (name === CANVAS) doc.getMap('nodesMap').set('w1', new Y.Map());
    else {
      const body = documentBodyFragment(doc);
      body.insert(body.length, [new Y.XmlText('w10-write')]);
    }
  };
}

/**
 * The account gate `useSocket` needs.
 * @param props - The children.
 * @param props.children - What renders under the gate.
 * @returns The gate.
 * @throws {never} Never.
 */
function Gate({ children }: { children: React.ReactNode }): React.JSX.Element {
  return <CollabSocketProvider userId={USER}>{children}</CollabSocketProvider>;
}

/**
 * Renders `useSocket` for a document under the account gate.
 * @param name - Canonical document name.
 * @param doc - The document.
 * @returns A reader of its current `synced`, `status` and `hasEverSynced`.
 * @throws {never} Never.
 */
function mountSocket(name: string, doc: Y.Doc): () => Connection {
  const { result } = renderHook(() => useSocket({ name, doc }), { wrapper: Gate });
  return () => ({ synced: result.current.synced, status: result.current.status, hasEverSynced: result.current.hasEverSynced });
}

/**
 * Leaves a document rebuilt after a size refusal (W10-02, W10-03): an
 * acknowledged full push, a local write whose Update the server answered with
 * SyncStatus(1) on the old provider, then the refusal CLOSE.
 * @param name - Canonical document name.
 * @returns The old provider's document and the frame index of the CLOSE.
 * @throws {AssertionError} When a step does not happen.
 */
async function refuseAndRetire(name: string): Promise<{ old: Opened; close: number; oldSends: ReturnType<typeof vi.spyOn> }> {
  const old = await open(name);
  handshake(old);
  server.push(name, P_FULL, 10);
  expect(seen(name)).toEqual(['seen(10)']);
  await writeAndSend(name, old.doc, contentWrite(name));
  server.syncStatus(name, 1);
  const oldSends = vi.spyOn(old.provider, 'sendStateless');
  const close = server.mark();
  server.closeDocument(name, COLLAB_DOCUMENT_TOO_LARGE_REASON);
  await until(() => readDocProvider(name) === null, 'the refusal retires the provider');
  expect(readDocSize(name).phase).toBe('resyncing');
  return { old, close, oldSends };
}

beforeEach(() => {
  server = resetServer();
  server.stepping = true;
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

describe('26.1 synced turns true only on the server SyncStep2', () => {
  const W10_01 = SPACES.flatMap(([label, name]) => (['none', 'in flight'] as const).flatMap((inflight) => ([
    ['after the new step1, push before it', 'before'],
    ['after the new step1, push after it', 'after'],
    ['in the same task as the CLOSE', 'same-task'],
  ] as const).map(([when, timing]) => [label, inflight, when, name, timing] as const)));

  it.each(W10_01)('W10-01 %s, Update %s: a stale SyncStatus(1) behind a reauth CLOSE does not sync the reopened provider (%s)', async (_label, inflight, _when, name, timing) => {
    const opened = await open(name);
    handshake(opened);
    // Collab answers the client SyncStep2 with SyncStatus(1), so the count is 0
    // here as in production and the stale receipt below can reach 0 again.
    server.syncStatus(name, 1);
    server.push(name, P_WARNING, 5);
    expect(seen(name)).toEqual(['seen(5)']);
    if (inflight === 'in flight') await writeAndSend(name, opened.doc, writeInflight);
    expect(readDocFacts(name).hasEverSynced).toBe(true);
    const close = server.mark();
    const events = opened.events.synced;

    /**
     * Releases `authenticated`, pushes the full size and checks nothing acknowledged it inside its callback.
     * @throws {AssertionError} When a `seen` left.
     */
    const pushFull = (): void => {
      server.release('authenticated', name);
      const at = server.mark();
      server.push(name, P_FULL, 9);
      expect(seen(name, at)).toEqual([]);
    };
    if (timing === 'same-task') {
      server.closeDocument(name, COLLAB_REAUTH_REASONS.permissionChanged, true);
      server.syncStatus(name, 1);
      await untilHandshakeStarts(name, close);
      pushFull();
    } else {
      server.closeDocument(name, COLLAB_REAUTH_REASONS.permissionChanged);
      await untilHandshakeStarts(name, close);
      if (timing === 'before') {
        pushFull();
        server.syncStatus(name, 1);
      } else {
        server.syncStatus(name, 1);
        pushFull();
      }
    }
    expect(opened.provider.synced).toBe(false);
    expect(opened.events.synced).toBe(events);
    expect(seen(name, close)).toEqual([]);
    expect(readDocFacts(name).hasEverSynced).toBe(true);
    await settle();
    expect(opened.provider.synced).toBe(false);
    expect(seen(name, close)).toEqual([]);

    const beforeStep1 = server.mark();
    server.release('serverStep1', name);
    expect(handshakeOrder(name, beforeStep1)).toEqual(['step2']);
    expect(seen(name, close)).toEqual([]);

    server.release('serverStep2', name);
    expect(opened.provider.synced).toBe(true);
    expect(opened.events.synced).toBe(events + 1);
    expect(seen(name, close)).toEqual(['seen(9)']);
    expect(handshakeOrder(name, close)).toEqual(['auth', 'step1', 'step2', 'seen(9)']);
    expect(readDocFacts(name).hasEverSynced).toBe(true);
  });

  it.each([
    ['document', DOCUMENT],
    ['canvas', CANVAS],
  ] as const)('W10-02 %s: a stale SyncStatus(1) behind a refusal CLOSE leaves the rebuilt provider resyncing until its SyncStep2', async (_label, name) => {
    const { old, close, oldSends } = await refuseAndRetire(name);
    const fresh = await open(name);
    expect(fresh.provider).not.toBe(old.provider);
    server.syncStatus(name, 1);

    expect(fresh.provider.synced).toBe(false);
    expect(fresh.events.synced).toBe(0);
    expect(readDocSize(name).phase).toBe('resyncing');
    expect(readDocFacts(name).hasEverSynced).toBe(false);
    const write = vi.fn();
    expect(writeSpaceDoc(name, { kind: 'add' }, write)).toEqual({ ok: false, reason: 'resyncing' });
    expect(write).toHaveBeenCalledTimes(0);
    expect(seen(name, close)).toEqual([]);

    server.release('authenticated', name);
    server.push(name, P_WARNING, 12);
    server.release('serverStep1', name);
    server.release('serverStep2', name);
    expect(fresh.provider.synced).toBe(true);
    expect(fresh.events.synced).toBe(1);
    expect(readDocSize(name).phase).toBe('warning');
    expect(readDocFacts(name).hasEverSynced).toBe(true);
    expect(contentOf(name, fresh.doc)).toBe(contentOf(name, server.docOf(name)));
    expect(contentOf(name, fresh.doc)).toMatch(name === CANVAS ? /"w1"/ : /w10-write/);
    await settle();
    expect(handshakeOrder(name, close)).toEqual(['auth', 'step1', 'step2', 'seen(12)']);
    expect(seen(name, close)).toEqual(['seen(12)']);
    expect(oldSends.mock.calls.filter(([payload]) => String(payload).includes('doc:size-seen'))).toEqual([]);
  });

  it('W10-03 useSocket on the rebuilt document stays connecting through a stale SyncStatus(1) until its SyncStep2', async () => {
    // Binds the account first, so the gates rendered below do not reset the transport.
    renderHook(() => null, { wrapper: Gate });
    const { close } = await refuseAndRetire(DOCUMENT);
    const doc = getDoc(DOCUMENT);
    const first = mountSocket(DOCUMENT, doc);
    await untilHandshakeStarts(DOCUMENT, close);
    expect(first()).toEqual(CONNECTING);

    act(() => { server.syncStatus(DOCUMENT, 1); });
    expect(first()).toEqual(CONNECTING);
    const second = mountSocket(DOCUMENT, doc);
    expect(second()).toEqual(CONNECTING);

    act(() => {
      server.release('authenticated', DOCUMENT);
      server.release('serverStep1', DOCUMENT);
      server.release('serverStep2', DOCUMENT);
    });
    expect(first()).toEqual(CONNECTED);
    expect(second()).toEqual(CONNECTED);
  });

  it.each([
    ['document', DOCUMENT],
    ['timeline', TIMELINE],
  ] as const)('W10-04 %s (regression guard): SyncStatus(1) after the handshake only lowers the unsynced count', async (_label, name) => {
    const opened = await open(name);
    server.release('authenticated', name);
    server.release('serverStep1', name);
    expect(opened.provider.hasUnsyncedChanges).toBe(true);
    expect(opened.provider.synced).toBe(false);

    server.release('serverStep2', name);
    expect(opened.provider.synced).toBe(true);
    expect(opened.events.synced).toBe(1);
    expect(opened.provider.hasUnsyncedChanges).toBe(true);

    server.syncStatus(name, 1);
    expect(opened.provider.hasUnsyncedChanges).toBe(false);
    expect(opened.events.unsynced.at(-1)).toBe(0);
    expect(opened.provider.synced).toBe(true);
    expect(opened.events.synced).toBe(1);

    await writeAndSend(name, opened.doc, writeInflight);
    expect(opened.provider.hasUnsyncedChanges).toBe(true);
    expect(opened.events.unsynced.at(-1)).toBe(1);

    server.syncStatus(name, 1);
    expect(opened.provider.hasUnsyncedChanges).toBe(false);
    expect(opened.events.unsynced.at(-1)).toBe(0);
    expect(opened.provider.synced).toBe(true);
    expect(opened.events.synced).toBe(1);
    expect(seen(name)).toEqual([]);
  });

  it('W10-05 (regression guard): useSocket follows the handshake, its receipt, a drop and the reconnect', async () => {
    const doc = getDoc(DOCUMENT);
    const first = mountSocket(DOCUMENT, doc);
    await untilHandshakeStarts(DOCUMENT);
    expect(first()).toEqual(CONNECTING);

    act(() => {
      server.release('authenticated', DOCUMENT);
      server.release('serverStep1', DOCUMENT);
      server.release('serverStep2', DOCUMENT);
    });
    expect(first()).toEqual(CONNECTED);
    act(() => { server.syncStatus(DOCUMENT, 1); });
    expect(first()).toEqual(CONNECTED);
    const second = mountSocket(DOCUMENT, doc);
    expect(second()).toEqual(CONNECTED);

    const old = newest();
    const from = server.mark();
    act(() => { old.drop(); });
    expect(first()).toEqual(DISCONNECTED);
    expect(second()).toEqual(DISCONNECTED);
    await until(() => newest() !== old, 'the provider dials again');
    await untilHandshakeStarts(DOCUMENT, from);

    act(() => {
      server.release('authenticated', DOCUMENT);
      server.release('serverStep1', DOCUMENT);
      server.release('serverStep2', DOCUMENT);
    });
    expect(first()).toEqual(CONNECTED);
    expect(second()).toEqual(CONNECTED);
    act(() => { server.syncStatus(DOCUMENT, 1); });
    expect(first()).toEqual(CONNECTED);
    expect(second()).toEqual(CONNECTED);
  });

  it.each([
    ['(a) before the server SyncStep1 of the first connection', 'first'],
    ['(b) after the handshake, before the receipt of the client SyncStep2', 'synced'],
    ['(c) after a reauth CLOSE, once the new step1 left', 'reauth'],
  ] as const)('W10-06 (regression guard) a read-only document ignores SyncStatus(0) %s', async (_label, when) => {
    const opened = await open(DOCUMENT, { scope: 'readonly' });
    let from = 0;
    if (when !== 'first') handshake(opened);
    if (when === 'reauth') {
      from = server.mark();
      server.closeDocument(DOCUMENT, COLLAB_REAUTH_REASONS.permissionChanged);
      await untilHandshakeStarts(DOCUMENT, from);
    }
    const synced = opened.provider.synced;
    expect(synced).toBe(when === 'synced');
    expect(opened.provider.hasUnsyncedChanges).toBe(true);
    const events = opened.events.synced;
    const counts = opened.events.unsynced.length;
    const frames = server.mark();

    server.syncStatus(DOCUMENT, 0);
    expect(opened.provider.synced).toBe(synced);
    expect(opened.provider.hasUnsyncedChanges).toBe(true);
    expect(opened.events.synced).toBe(events);
    expect(opened.events.unsynced).toHaveLength(counts);
    expect(server.mark()).toBe(frames);

    if (when === 'synced') {
      const at = server.mark();
      server.push(DOCUMENT, P_FULL, 3);
      expect(seen(DOCUMENT, at)).toEqual(['seen(3)']);
      return;
    }
    server.release('authenticated', DOCUMENT);
    server.push(DOCUMENT, P_FULL, 3);
    expect(seen(DOCUMENT, from)).toEqual([]);
    server.release('serverStep1', DOCUMENT);
    expect(opened.provider.synced).toBe(false);
    server.release('serverStep2', DOCUMENT);
    expect(opened.provider.synced).toBe(true);
    expect(opened.events.synced).toBe(events + 1);
    await settle();
    expect(handshakeOrder(DOCUMENT, from).slice(-2)).toEqual(['step2', 'seen(3)']);
  });
});
