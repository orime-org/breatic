// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fc from 'fast-check';
import * as Y from 'yjs';
import {
  applyTimelineEdit,
  initializeTimelineDocument,
  readTimelineDocument,
  timelineSpaceDocName,
  type NativeEditRecord,
  type TimelineClientLimits,
  type TimelinePersistenceRequest,
  type TimelinePersistenceResponse,
} from '@breatic/shared';

import { createTimelinePersistenceController, getTimelinePersistenceController } from '@web/data/yjs/timeline-persistence-controller';
import type { RpcCapableProvider } from '@web/data/yjs/space-rpc-client';
import { destroyDoc, getDoc } from '@web/data/yjs/manager';

type Controller = ReturnType<typeof createTimelinePersistenceController>;
type ControllerSend = NonNullable<Parameters<typeof createTimelinePersistenceController>[1]['send']>;

interface PendingCall {
  provider: RpcCapableProvider;
  request: Omit<TimelinePersistenceRequest, 'id'>;
  signal: AbortSignal;
  resolve: (response: TimelinePersistenceResponse) => void;
  reject: (error: Error) => void;
}

const limits: TimelineClientLimits['persistence'] = {
  batchSize: 2,
  pollIntervalMs: 700,
  rpcTimeoutMs: 300,
  retryMinIntervalMs: 250,
};
const controllers: Controller[] = [];
const documents: Y.Doc[] = [];
let nextId = 0;

/**
 * Produce deterministic valid identities without sharing source or action ids.
 * @returns The next test UUID.
 * @throws {never} Never.
 */
function identity(): string {
  nextId += 1;
  return `00000000-0000-4000-8000-${String(nextId).padStart(12, '0')}`;
}

/**
 * Make the exact provider shape used by the controller's injected sender.
 * @returns A provider whose own transport must not be called in these unit tests.
 * @throws {never} Never.
 */
function provider(): RpcCapableProvider {
  return { sendStateless: vi.fn(), on: vi.fn(), off: vi.fn() };
}

/**
 * Make an initialized real content document and track its cleanup.
 * @returns The valid V1 Timeline, including its canonical visual track.
 * @throws {Error} When the shared initializer rejects the fixture.
 */
function document(): Y.Doc {
  const doc = new Y.Doc();
  initializeTimelineDocument(doc, { width: 1920, height: 1080, fps: { num: 24, den: 1 } });
  documents.push(doc);
  return doc;
}

/**
 * Write an actual shared-layout transaction and its immutable receipt.
 * @param doc - The fixture's content document.
 * @param startFrame - A non-overlapping start for this one-second video.
 * @returns The exact accepted record, rather than a second hand-built receipt shape.
 * @throws {Error} When the shared editor rejects the fixture.
 */
function addVideo(doc: Y.Doc, startFrame = 0): NativeEditRecord {
  const sourceId = identity();
  return applyTimelineEdit(doc, {
    actionId: identity(),
    operation: 'add_video',
    parameters: {
      source: {
        id: sourceId, kind: 'video', assetId: identity(), timebase: { num: 24, den: 1 },
        extentFrames: 24, durationSeconds: '1', durationOrigin: 'registered',
      },
      clip: {
        id: identity(), trackId: 'visual-1', kind: 'video', sourceId, startFrame,
        sourceInFrame: 0, durationFrames: 24, rate: { num: 1, den: 1 }, gain: 1, mute: false,
        transform: { x: 0, y: 0, scaleX: 1, scaleY: 1, rotation: 0 },
      },
    },
  });
}

/**
 * Drain promise continuations without advancing the polling clock.
 * @returns After the bounded microtask drain.
 * @throws {never} Never.
 */
async function flush(): Promise<void> {
  for (let turn = 0; turn < 48; turn += 1) await Promise.resolve();
}

/**
 * Form the actual response contract for one captured request.
 * @param call - The request whose action set is being answered.
 * @param records - Records read from persisted bytes in this scenario.
 * @param attempt - An optional store attempt independent from record inclusion.
 * @returns A valid V1 persistence response with explicit missing identities.
 * @throws {never} Never.
 */
function success(call: PendingCall, records: NativeEditRecord[], attempt?: 'stored' | 'refused' | 'deferred' | 'gone'): TimelinePersistenceResponse {
  const included = new Set(records.map((record) => record.actionId));
  return {
    version: 1, id: 'test-response', type: 'timeline:persistence:result', ok: true,
    result: {
      documentVersion: 1,
      persistedRecords: records,
      missingActionIds: call.request.payload.actionIds.filter((id) => !included.has(id)),
      ...(attempt === undefined ? {} : { attempt }),
    },
  };
}

/**
 * Own a real document/controller and an explicitly gated persistence boundary.
 * @param doc - The initialized Timeline whose receipts are observed.
 * @returns The controller, pending-operation observer and captured RPC calls.
 * @throws {Error} When controller construction fails.
 */
function harness(doc: Y.Doc = document()): {
  doc: Y.Doc; controller: Controller; calls: PendingCall[]; pending: ReturnType<typeof vi.fn<(pending: boolean) => void>>;
} {
  const calls: PendingCall[] = [];
  const send: ControllerSend = (connection, request, signal) => new Promise<TimelinePersistenceResponse>((resolve, reject) => {
    calls.push({ provider: connection, request: structuredClone(request), signal, resolve, reject });
  });
  const pending = vi.fn<(pending: boolean) => void>();
  const controller = createTimelinePersistenceController(doc, { limits, send, onPendingChange: pending });
  controllers.push(controller);
  return { doc, controller, calls, pending };
}

/**
 * Build through the real manager and cache, retaining the injected RPC boundary.
 * @param name - Canonical document name owned by this test.
 * @param state - Previously persisted content to restore into a new managed document.
 * @returns The actual cached controller and transport inspection points.
 * @throws {Error} When fixture initialization or cache construction fails.
 */
function managedHarness(name: string, state?: Uint8Array): ReturnType<typeof harness> {
  const doc = getDoc(name);
  if (state === undefined) initializeTimelineDocument(doc, { width: 1920, height: 1080, fps: { num: 24, den: 1 } });
  else Y.applyUpdate(doc, state);
  const calls: PendingCall[] = [];
  const send: ControllerSend = (connection, request, signal) => new Promise<TimelinePersistenceResponse>((resolve, reject) => {
    calls.push({ provider: connection, request: structuredClone(request), signal, resolve, reject });
  });
  const pending = vi.fn<(pending: boolean) => void>();
  const controller = getTimelinePersistenceController(doc, name, { limits, send, onPendingChange: pending });
  return { doc, controller, calls, pending };
}

beforeEach(() => {
  nextId = 0;
  vi.useFakeTimers();
});

afterEach(() => {
  controllers.splice(0).forEach((controller) => controller.destroy());
  documents.splice(0).forEach((doc) => doc.destroy());
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('Timeline persistence confirmation controller', () => {
  it('does not query on construction or claim an empty action set is already saved', () => {
    const h = harness();
    expect(h.calls).toEqual([]);
    expect(h.controller.getSnapshot()).toMatchObject({ pendingCount: 0, error: null });
    expect(h.controller.getSnapshot().status).not.toBe('saved');
    expect(h.pending.mock.calls.flat()).not.toContain(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('queries an empty action set and waits for a real SQL V1 answer before saved', async () => {
    const h = harness();
    const connection = provider();
    h.controller.setConnection(connection);
    await flush();
    expect(h.calls).toHaveLength(1);
    expect(h.calls[0]!.request).toEqual({ version: 1, type: 'timeline:persistence:query', payload: { actionIds: [] } });
    expect(h.calls[0]!.provider).toBe(connection);
    expect(h.controller.getSnapshot()).toEqual({ status: 'checking', pendingCount: 0, error: null });
    expect(h.pending.mock.calls.flat()).not.toContain(true);

    h.calls[0]!.resolve(success(h.calls[0]!, []));
    await flush();
    expect(h.controller.getSnapshot()).toEqual({ status: 'saved', pendingCount: 0, error: null });
  });

  it('does not treat a missing empty document as saved', async () => {
    const h = harness();
    h.controller.setConnection(provider());
    await flush();
    h.calls[0]!.resolve({ version: 1, id: 'missing', type: 'timeline:persistence:result', ok: false,
      error: { code: 'NOT_FOUND', message: 'Timeline was not found' } });
    await flush();
    expect(h.controller.getSnapshot()).toEqual({ status: 'error', pendingCount: 0, error: 'Timeline was not found' });
    expect(h.pending.mock.calls.flat()).not.toContain(true);
  });

  it('confirms only matching complete records and clears the pending-operation callback', async () => {
    const doc = document();
    const record = addVideo(doc);
    const h = harness(doc);
    expect(h.controller.getSnapshot().pendingCount).toBe(1);
    expect(h.pending).toHaveBeenLastCalledWith(true);
    h.controller.setConnection(provider());
    await flush();
    expect(h.calls[0]!.request.payload.actionIds).toEqual([record.actionId]);
    expect(h.controller.getSnapshot().status).toBe('saving');

    h.calls[0]!.resolve(success(h.calls[0]!, [record]));
    await flush();
    expect(h.controller.getSnapshot()).toEqual({ status: 'saved', pendingCount: 0, error: null });
    expect(h.pending).toHaveBeenLastCalledWith(false);
  });

  it('rejects a same-action response whose complete parameters differ', async () => {
    const doc = document();
    const record = addVideo(doc);
    const h = harness(doc);
    h.controller.setConnection(provider());
    await flush();
    if (record.operation !== 'add_video') throw new Error('Expected add-video receipt');
    const different: NativeEditRecord = { ...record, parameters: { ...record.parameters,
      clip: { ...record.parameters.clip, startFrame: 24 } } };
    h.calls[0]!.resolve(success(h.calls[0]!, [different]));
    await flush();
    expect(h.controller.getSnapshot().status).toBe('incompatible');
    expect(h.controller.getSnapshot().pendingCount).toBe(1);
    expect(h.pending).toHaveBeenLastCalledWith(true);
    expect(readTimelineDocument(doc).nativeEdits[record.actionId]).toEqual(record);
  });

  it('keeps a missing action pending even when a store attempt reports stored', async () => {
    const doc = document();
    const record = addVideo(doc);
    const h = harness(doc);
    h.controller.setConnection(provider());
    await flush();
    h.calls[0]!.resolve(success(h.calls[0]!, [], 'stored'));
    await flush();
    expect(h.controller.getSnapshot()).toMatchObject({ status: 'saving', pendingCount: 1 });
    expect(h.pending).toHaveBeenLastCalledWith(true);

    vi.advanceTimersByTime(limits.pollIntervalMs);
    await flush();
    expect(h.calls).toHaveLength(2);
    expect(h.calls[1]!.request).toEqual({ version: 1, type: 'timeline:persistence:query', payload: { actionIds: [record.actionId] } });
    h.calls[1]!.resolve(success(h.calls[1]!, [record]));
    await flush();
    expect(h.controller.getSnapshot()).toEqual({ status: 'saved', pendingCount: 0, error: null });
  });

  it.each(['rejected', 'server-error'] as const)('reports %s and polls SQL again without replaying the edit', async (failure) => {
    const doc = document();
    const record = addVideo(doc);
    const before = Y.encodeStateAsUpdate(doc);
    const h = harness(doc);
    h.controller.setConnection(provider());
    await flush();
    if (failure === 'rejected') h.calls[0]!.reject(new Error('Persistence request timed out'));
    else h.calls[0]!.resolve({ version: 1, id: 'error', type: 'timeline:persistence:result', ok: false,
      error: { code: 'INTERNAL', message: 'Cannot read persisted Timeline' } });
    await flush();
    expect(h.controller.getSnapshot()).toEqual({ status: 'error', pendingCount: 1,
      error: failure === 'rejected' ? 'Persistence request timed out' : 'Cannot read persisted Timeline' });

    vi.advanceTimersByTime(limits.pollIntervalMs - 1);
    await flush();
    expect(h.calls).toHaveLength(1);
    vi.advanceTimersByTime(1);
    await flush();
    expect(h.calls).toHaveLength(2);
    expect(h.calls[1]!.request.type).toBe('timeline:persistence:query');
    h.calls[1]!.resolve(success(h.calls[1]!, [record]));
    await flush();
    expect(h.controller.getSnapshot()).toEqual({ status: 'saved', pendingCount: 0, error: null });
    expect(Y.encodeStateAsUpdate(doc)).toEqual(before);
  });

  it('does not mark a Viewer retry refusal saved or discard its accepted document', async () => {
    const doc = document();
    const record = addVideo(doc);
    const before = Y.encodeStateAsUpdate(doc);
    const h = harness(doc);
    h.controller.setConnection(provider());
    await flush();
    h.calls[0]!.resolve(success(h.calls[0]!, []));
    await flush();
    const retried = h.controller.retry();
    await flush();
    expect(h.calls).toHaveLength(2);
    expect(h.calls[1]!.request).toEqual({ version: 1, type: 'timeline:persistence:retry', payload: { actionIds: [record.actionId] } });
    h.calls[1]!.resolve({ version: 1, id: 'readonly', type: 'timeline:persistence:result', ok: false,
      error: { code: 'FORBIDDEN', message: 'Timeline is read-only' } });
    await retried;
    await flush();
    expect(h.controller.getSnapshot()).toEqual({ status: 'error', pendingCount: 1, error: 'Timeline is read-only' });
    expect(Y.encodeStateAsUpdate(doc)).toEqual(before);
  });

  it('shares concurrent retries and starts a later retry without replaying edits', async () => {
    const doc = document();
    addVideo(doc);
    const before = Y.encodeStateAsUpdate(doc);
    const h = harness(doc);
    h.controller.setConnection(provider());
    await flush();
    h.calls[0]!.resolve(success(h.calls[0]!, []));
    await flush();
    const first = h.controller.retry();
    const second = h.controller.retry();
    await flush();
    expect(h.calls).toHaveLength(2);
    expect(h.calls[1]!.request.type).toBe('timeline:persistence:retry');
    h.calls[1]!.resolve(success(h.calls[1]!, [], 'deferred'));
    await Promise.all([first, second]);
    await flush();
    expect(h.controller.getSnapshot()).toMatchObject({ status: 'saving', pendingCount: 1 });
    expect(Y.encodeStateAsUpdate(doc)).toEqual(before);

    vi.advanceTimersByTime(limits.retryMinIntervalMs);
    const third = h.controller.retry();
    await flush();
    expect(h.calls).toHaveLength(3);
    expect(h.calls[2]!.request.type).toBe('timeline:persistence:retry');
    h.calls[2]!.resolve(success(h.calls[2]!, [], 'deferred'));
    await third;
  });

  it('observes new native edits and never lets an older batch confirm a later action', async () => {
    const h = harness();
    h.controller.setConnection(provider());
    await flush();
    h.calls[0]!.resolve(success(h.calls[0]!, []));
    await flush();
    const first = addVideo(h.doc);
    await flush();
    expect(h.calls).toHaveLength(2);
    expect(h.calls[1]!.request.payload.actionIds).toEqual([first.actionId]);
    const second = addVideo(h.doc, 24);
    await flush();
    expect(h.controller.getSnapshot().pendingCount).toBe(2);

    h.calls[1]!.resolve(success(h.calls[1]!, [first]));
    await flush();
    expect(h.controller.getSnapshot()).toMatchObject({ status: 'saving', pendingCount: 1 });
    expect(h.pending).toHaveBeenLastCalledWith(true);
    vi.advanceTimersByTime(limits.pollIntervalMs);
    await flush();
    const current = h.calls.at(-1)!;
    expect(current.request.payload.actionIds).toContain(second.actionId);
    current.resolve(success(current, [second]));
    await flush();
    expect(h.controller.getSnapshot()).toEqual({ status: 'saved', pendingCount: 0, error: null });
    expect(Object.keys(readTimelineDocument(h.doc).nativeEdits)).toHaveLength(2);
  });

  it('ignores an old provider response after reconnect and queries on the current provider', async () => {
    const doc = document();
    const record = addVideo(doc);
    const h = harness(doc);
    const first = provider();
    const second = provider();
    h.controller.setConnection(first);
    await flush();
    const stale = h.calls[0]!;
    h.controller.setConnection(second);
    await flush();
    expect(stale.signal.aborted).toBe(true);
    expect(h.calls).toHaveLength(2);
    expect(h.calls[1]!.provider).toBe(second);
    stale.resolve(success(stale, [record]));
    await flush();
    expect(h.controller.getSnapshot()).toMatchObject({ status: 'saving', pendingCount: 1 });
    h.calls[1]!.resolve(success(h.calls[1]!, [record]));
    await flush();
    expect(h.controller.getSnapshot()).toEqual({ status: 'saved', pendingCount: 0, error: null });
    h.controller.setConnection(second);
    await flush();
    expect(h.calls).toHaveLength(2);
  });

  it('aborts a disconnected generation and waits to query until a provider returns', async () => {
    const doc = document();
    const record = addVideo(doc);
    const h = harness(doc);
    const connection = provider();
    h.controller.setConnection(connection);
    await flush();
    const stale = h.calls[0]!;
    h.controller.setConnection(null);
    expect(stale.signal.aborted).toBe(true);
    expect(h.controller.getSnapshot()).toMatchObject({ status: 'disconnected', pendingCount: 1 });
    stale.resolve(success(stale, [record]));
    vi.advanceTimersByTime(limits.pollIntervalMs * 3);
    await flush();
    expect(h.calls).toHaveLength(1);
    expect(h.controller.getSnapshot().status).toBe('disconnected');

    h.controller.setConnection(connection);
    await flush();
    expect(h.calls).toHaveLength(2);
    h.calls[1]!.resolve(success(h.calls[1]!, [record]));
    await flush();
    expect(h.controller.getSnapshot().status).toBe('saved');
  });

  it('preserves confirmed facts within one controller when a reconnect reads older bytes', async () => {
    const doc = document();
    const record = addVideo(doc);
    const h = harness(doc);
    h.controller.setConnection(provider());
    await flush();
    h.calls[0]!.resolve(success(h.calls[0]!, [record]));
    await flush();
    expect(h.controller.getSnapshot()).toMatchObject({ status: 'saved', pendingCount: 0 });
    const confirmedCalls = h.pending.mock.calls.length;

    h.controller.setConnection(provider());
    await flush();
    h.calls[1]!.resolve(success(h.calls[1]!, []));
    await flush();
    expect(h.controller.getSnapshot().pendingCount).toBe(0);
    expect(h.controller.getSnapshot().status).toBe('saved');
    expect(h.controller.getSnapshot().error).toEqual(expect.stringMatching(/\S/));
    expect(h.pending.mock.calls.slice(confirmedCalls).flat()).not.toContain(true);
    expect(h.pending).toHaveBeenLastCalledWith(false);
  });

  it('reports unsupported document responses as incompatible and leaves pending actions intact', async () => {
    const doc = document();
    addVideo(doc);
    const h = harness(doc);
    h.controller.setConnection(provider());
    await flush();
    h.calls[0]!.resolve({ version: 1, id: 'unsupported', type: 'timeline:persistence:result', ok: false,
      error: { code: 'UNSUPPORTED_DOCUMENT', message: 'Timeline format is unsupported' } });
    await flush();
    expect(h.controller.getSnapshot()).toEqual({ status: 'incompatible', pendingCount: 1, error: 'Timeline format is unsupported' });
    expect(h.pending).toHaveBeenLastCalledWith(true);
  });

  it('notifies subscribers on state changes and stops notifying an unsubscribed consumer', async () => {
    const h = harness();
    const notified = vi.fn();
    const unsubscribe = h.controller.subscribe(notified);
    h.controller.setConnection(provider());
    await flush();
    const afterConnecting = notified.mock.calls.length;
    expect(afterConnecting).toBeGreaterThanOrEqual(1);
    h.calls[0]!.resolve(success(h.calls[0]!, []));
    await flush();
    expect(notified.mock.calls.length).toBeGreaterThan(afterConnecting);
    unsubscribe();
    const afterUnsubscribe = notified.mock.calls.length;
    addVideo(h.doc);
    await flush();
    expect(notified).toHaveBeenCalledTimes(afterUnsubscribe);
  });

  it('destroys pending resources, clears the close guard, and ignores late replies and document changes', async () => {
    const doc = document();
    const record = addVideo(doc);
    const h = harness(doc);
    const notified = vi.fn();
    h.controller.subscribe(notified);
    h.controller.setConnection(provider());
    await flush();
    const original = h.calls[0]!;
    h.controller.destroy();
    expect(original.signal.aborted).toBe(true);
    expect(h.pending).toHaveBeenLastCalledWith(false);
    expect(vi.getTimerCount()).toBe(0);
    const notifications = notified.mock.calls.length;
    original.resolve(success(original, [record]));
    addVideo(doc, 24);
    vi.advanceTimersByTime(limits.pollIntervalMs * 3);
    await flush();
    expect(h.calls).toHaveLength(1);
    expect(notified).toHaveBeenCalledTimes(notifications);
    h.controller.setConnection(provider());
    await h.controller.retry();
    await flush();
    expect(h.calls).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(0);
    h.controller.destroy();
    expect(h.pending).toHaveBeenLastCalledWith(false);
  });

  it('clears a scheduled poll when destroyed after a failed read', async () => {
    const h = harness();
    h.controller.setConnection(provider());
    await flush();
    h.calls[0]!.reject(new Error('Read failed'));
    await flush();
    expect(vi.getTimerCount()).toBe(1);
    h.controller.destroy();
    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(limits.pollIntervalMs * 3);
    await flush();
    expect(h.calls).toHaveLength(1);
  });

  it('retains one controller per managed document and evicts its resources on destroyDoc', async () => {
    const name = timelineSpaceDocName(identity(), identity());
    try {
      const h = managedHarness(name);
      const record = addVideo(h.doc);
      const same = getTimelinePersistenceController(getDoc(name), name, { limits });
      expect(same).toBe(h.controller);
      expect(getDoc(name)).toBe(h.doc);
      h.controller.setConnection(provider());
      await flush();
      expect(h.calls).toHaveLength(1);
      expect(h.pending).toHaveBeenLastCalledWith(true);
      const inFlight = h.calls[0]!;

      destroyDoc(name);
      expect(inFlight.signal.aborted).toBe(true);
      expect(h.pending).toHaveBeenLastCalledWith(false);
      expect(vi.getTimerCount()).toBe(0);
      inFlight.resolve(success(inFlight, [record]));
      vi.advanceTimersByTime(limits.pollIntervalMs * 3);
      await flush();
      expect(h.calls).toHaveLength(1);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      destroyDoc(name);
    }
  });

  it('reopens a fresh cached controller without inherited confirmations and leaves another document alive', async () => {
    const firstName = timelineSpaceDocName(identity(), identity());
    const secondName = timelineSpaceDocName(identity(), identity());
    try {
      const first = managedHarness(firstName);
      const firstRecord = addVideo(first.doc);
      const bytes = Y.encodeStateAsUpdate(first.doc);
      const second = managedHarness(secondName);
      const secondRecord = addVideo(second.doc);
      first.controller.setConnection(provider());
      second.controller.setConnection(provider());
      await flush();
      first.calls[0]!.resolve(success(first.calls[0]!, [firstRecord]));
      await flush();
      expect(first.controller.getSnapshot()).toEqual({ status: 'saved', pendingCount: 0, error: null });
      expect(second.controller.getSnapshot()).toMatchObject({ status: 'saving', pendingCount: 1 });

      destroyDoc(firstName);
      expect(second.calls[0]!.signal.aborted).toBe(false);
      expect(second.pending).toHaveBeenLastCalledWith(true);
      expect(getTimelinePersistenceController(getDoc(secondName), secondName, { limits })).toBe(second.controller);
      const reopened = managedHarness(firstName, bytes);
      expect(reopened.doc).not.toBe(first.doc);
      expect(reopened.controller).not.toBe(first.controller);
      expect(reopened.controller.getSnapshot().pendingCount).toBe(1);
      expect(reopened.controller.getSnapshot().status).not.toBe('saved');
      expect(reopened.pending).toHaveBeenLastCalledWith(true);
      reopened.controller.setConnection(provider());
      await flush();
      expect(reopened.calls).toHaveLength(1);
      expect(reopened.calls[0]!.request).toEqual({ version: 1, type: 'timeline:persistence:query', payload: { actionIds: [firstRecord.actionId] } });
      reopened.calls[0]!.resolve(success(reopened.calls[0]!, [firstRecord]));
      second.calls[0]!.resolve(success(second.calls[0]!, [secondRecord]));
      await flush();
      expect(reopened.controller.getSnapshot()).toEqual({ status: 'saved', pendingCount: 0, error: null });
      expect(second.controller.getSnapshot()).toEqual({ status: 'saved', pendingCount: 0, error: null });
    } finally {
      destroyDoc(firstName);
      destroyDoc(secondName);
    }
  });

  it.each(['replacement', 'disconnect', 'destroy'] as const)('invalidates an old queued retry on %s before its query completes', async (transition) => {
    const doc = document();
    const record = addVideo(doc);
    const h = harness(doc);
    h.controller.setConnection(provider());
    await flush();
    const oldQuery = h.calls[0]!;
    const queued = h.controller.retry();
    await flush();
    expect(h.calls).toHaveLength(1);
    const newProvider = provider();
    if (transition === 'replacement') h.controller.setConnection(newProvider);
    else if (transition === 'disconnect') h.controller.setConnection(null);
    else h.controller.destroy();
    expect(oldQuery.signal.aborted).toBe(true);
    await flush();
    oldQuery.resolve(success(oldQuery, []));
    await flush();

    if (transition === 'replacement') {
      expect(h.calls).toHaveLength(2);
      expect(h.calls[1]!.provider).toBe(newProvider);
      expect(h.calls[1]!.request.type).toBe('timeline:persistence:query');
      h.calls[1]!.resolve(success(h.calls[1]!, []));
      await flush();
      expect(h.calls).toHaveLength(2);
    } else {
      expect(h.calls).toHaveLength(1);
    }
    await queued;
    if (transition === 'destroy') {
      expect(h.pending).toHaveBeenLastCalledWith(false);
      expect(vi.getTimerCount()).toBe(0);
      return;
    }
    if (transition === 'disconnect') {
      h.controller.setConnection(newProvider);
      await flush();
      expect(h.calls).toHaveLength(2);
      expect(h.calls[1]!.request.type).toBe('timeline:persistence:query');
      h.calls[1]!.resolve(success(h.calls[1]!, []));
      await flush();
      expect(h.calls).toHaveLength(2);
    }

    vi.advanceTimersByTime(limits.retryMinIntervalMs);
    const explicitlyRetried = h.controller.retry();
    await flush();
    expect(h.calls).toHaveLength(3);
    expect(h.calls[2]!.provider).toBe(newProvider);
    expect(h.calls[2]!.request).toEqual({ version: 1, type: 'timeline:persistence:retry', payload: { actionIds: [record.actionId] } });
    h.calls[2]!.resolve(success(h.calls[2]!, [record], 'stored'));
    await explicitlyRetried;
    await flush();
    expect(h.controller.getSnapshot()).toEqual({ status: 'saved', pendingCount: 0, error: null });
  });

  it('batches every action exactly once before saved across generated action counts and batch sizes', async () => {
    await fc.assert(fc.asyncProperty(
      fc.integer({ min: 0, max: 17 }),
      fc.integer({ min: 1, max: 5 }),
      async (count, batchSize) => {
        const doc = document();
        const records = Array.from({ length: count }, (_, index) => addVideo(doc, index * 24));
        const byId = new Map(records.map((record) => [record.actionId, record]));
        const requests: Omit<TimelinePersistenceRequest, 'id'>[] = [];
        const send: ControllerSend = async (connection, request, signal) => {
          requests.push(structuredClone(request));
          return success({ provider: connection, request, signal, resolve: () => {}, reject: () => {} },
            request.payload.actionIds.map((id) => {
              const record = byId.get(id);
              if (record === undefined) throw new Error(`Unexpected action ${id}`);
              return record;
            }));
        };
        const controller = createTimelinePersistenceController(doc, { limits: { ...limits, batchSize }, send });
        controllers.push(controller);
        try {
          controller.setConnection(provider());
          await flush();
          expect(controller.getSnapshot()).toEqual({ status: 'saved', pendingCount: 0, error: null });
          expect(requests.every((request) => request.type === 'timeline:persistence:query' && request.version === 1)).toBe(true);
          expect(requests.every((request) => request.payload.actionIds.length <= batchSize)).toBe(true);
          expect(requests.flatMap((request) => request.payload.actionIds).sort()).toEqual(records.map((record) => record.actionId).sort());
          expect(requests).toHaveLength(Math.max(1, Math.ceil(count / batchSize)));
          expect(Object.values(readTimelineDocument(doc).nativeEdits)).toEqual(records);
        } finally {
          controller.destroy();
        }
      },
    ), { numRuns: 20 });
  });
});
