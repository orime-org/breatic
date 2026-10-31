// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as React from 'react';
import * as Y from 'yjs';
import { applyAwarenessUpdate, Awareness, encodeAwarenessUpdate } from 'y-protocols/awareness';
import type { SpaceType } from '@breatic/shared';

import { useSpaceTaskStatus } from '@web/pages/project/chrome/tab-bar/use-space-task-status';
import { useSpaceOperationsStore } from '@web/stores/space-operations';
import { useUploadMarksStore } from '@web/stores/upload-marks';
import { resetRunOnceForTests, runOnce, taskActionKey, useTaskActionsInFlight } from '@web/stores/task-actions-in-flight';
import { acquireDocProvider, releaseDocProvider, _resetCollabSocketForTests } from '@web/data/yjs/collab-socket';
import { docName, getDoc, _resetForTests } from '@web/data/yjs/manager';

vi.mock('@hocuspocus/provider', async () => {
  const { Awareness: RealAwareness } = await import('y-protocols/awareness');
  return {
    HocuspocusProviderWebsocket: class {
      on(): void {}
      destroy(): void {}
    },
    HocuspocusProvider: class {
      awareness: Awareness;
      constructor(config: { document: Y.Doc }) { this.awareness = new RealAwareness(config.document); }
      on(): void {}
      off(): void {}
      attach(): void {}
      destroy(): void { this.awareness.destroy(); }
    },
  };
});
vi.mock('@web/data/yjs/collab-failure-report', () => ({ reportCollabFailure: vi.fn() }));

const PROJECT = 'project-one';
const SPACE = 'space-one';
const peers: Awareness[] = [];
const peerDocs: Y.Doc[] = [];

/** Seed one real content node in the canonical document. @throws {never} Never. */
function seedNode(projectId = PROJECT, spaceId = SPACE, running = 0, type = 'image'): Y.Map<unknown> {
  const document = getDoc(docName.canvasSpace(projectId, spaceId));
  const node = new Y.Map<unknown>();
  const data = new Y.Map<unknown>();
  data.set('name', 'Image');
  data.set('createdBy', 'collaborator');
  data.set('createdAt', 1);
  data.set('locked', false);
  data.set('attachments', new Y.Array());
  data.set('taskCounts', { running, done: 0, failed: 0, expired: 0 });
  node.set('type', type);
  node.set('position', { x: 0, y: 0 });
  node.set('data', data);
  document.getMap<Y.Map<unknown>>('nodesMap').set('node-one', node);
  return data;
}

/** Hold an existing runOnce request until the test releases its response. @throws {never} Never. */
function holdRequest(intent: string): () => Promise<void> {
  let respond: () => void = () => undefined;
  const answer = new Promise<void>((resolve) => { respond = resolve; });
  const work = runOnce(intent, { scope: 'generate', prepare: () => true, send: () => answer });
  return async () => { respond(); await work; };
}

/** Deliver a genuine awareness update from another client. @throws {never} Never. */
function addPeer(awareness: Awareness, nodeId = 'node-one', identified = true): Awareness {
  const document = new Y.Doc();
  const peer = new Awareness(document);
  peerDocs.push(document);
  peers.push(peer);
  peer.setLocalState({ ...(identified ? { user: { id: 'collaborator' } } : {}), activity: [{ nodeId, action: 'upload', at: 1 }] });
  applyAwarenessUpdate(awareness, encodeAwarenessUpdate(peer, [peer.clientID]), 'test');
  return peer;
}

/** Remove one peer's published activity through the protocol. @throws {never} Never. */
function endPeer(awareness: Awareness, peer: Awareness): void {
  peer.setLocalStateField('activity', []);
  applyAwarenessUpdate(awareness, encodeAwarenessUpdate(peer, [peer.clientID]), 'test');
}

describe('useSpaceTaskStatus existing sources', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    _resetCollabSocketForTests();
    _resetForTests();
    resetRunOnceForTests();
    useSpaceOperationsStore.setState({ operations: {} });
    useUploadMarksStore.setState({ marks: {} });
    useTaskActionsInFlight.setState({ running: new Map(), inFlight: new Set() });
  });

  afterEach(() => {
    cleanup();
    resetRunOnceForTests();
    _resetCollabSocketForTests();
    for (const peer of peers.splice(0)) peer.destroy();
    for (const document of peerDocs.splice(0)) document.destroy();
    _resetForTests();
    vi.useRealTimers();
  });

  it.each<SpaceType>(['canvas', 'document'])('counts existing %s operation references and isolates other Spaces', (type) => {
    const { result } = renderHook(() => useSpaceTaskStatus(PROJECT, SPACE, type));
    expect(result.current).toBe(false);
    act(() => useSpaceOperationsStore.getState().register('space-other', 'upload'));
    expect(result.current).toBe(false);
    act(() => {
      useSpaceOperationsStore.getState().register(SPACE, 'upload');
      useSpaceOperationsStore.getState().register(SPACE, 'upload');
    });
    expect(result.current).toBe(true);
    act(() => useSpaceOperationsStore.getState().unregister(SPACE, 'upload'));
    expect(result.current).toBe(true);
    act(() => useSpaceOperationsStore.getState().unregister(SPACE, 'upload'));
    expect(result.current).toBe(false);
  });

  it('reads waiting marks and releases them on answers or failures', () => {
    const { result } = renderHook(() => useSpaceTaskStatus(PROJECT, SPACE, 'canvas'));
    let op = '';
    act(() => { op = useUploadMarksStore.getState().begin(SPACE, 'node-one', 'upload'); });
    expect(result.current).toBe(true);
    act(() => useUploadMarksStore.getState().answer(SPACE, 'node-one', op));
    expect(result.current).toBe(false);
    act(() => { op = useUploadMarksStore.getState().begin(SPACE, 'node-one', 'readText'); });
    act(() => useUploadMarksStore.getState().fail(SPACE, 'node-one', op, { text: 'Failed' }));
    expect(result.current).toBe(false);
  });

  it.each(['generate', 'understand', 'transcribe', 'mini-tool'])('reads the existing %s request and releases it with the original response', async (kind) => {
    const { result } = renderHook(() => useSpaceTaskStatus(PROJECT, SPACE, 'canvas'));
    let finish: () => Promise<void> = async () => undefined;
    await act(async () => { finish = holdRequest(`${kind}:${SPACE}:node-one${kind === 'mini-tool' ? ':image.crop' : ''}`); });
    expect(result.current).toBe(true);
    await act(async () => finish());
    expect(result.current).toBe(false);
  });

  it('ignores neighbouring Space IDs and unrelated business intents', async () => {
    const { result } = renderHook(() => useSpaceTaskStatus(PROJECT, SPACE, 'canvas'));
    let neighbouring: () => Promise<void> = async () => undefined;
    let unrelated: () => Promise<void> = async () => undefined;
    await act(async () => {
      neighbouring = holdRequest(`generate:${SPACE}-extra:node-one`);
      unrelated = holdRequest(`checkout:${SPACE}:node-one`);
    });
    expect(result.current).toBe(false);
    await act(async () => { await neighbouring(); await unrelated(); });
  });

  it('includes Retry while excluding dismiss and other Project or Space requests', () => {
    const { result } = renderHook(() => useSpaceTaskStatus(PROJECT, SPACE, 'canvas'));
    const store = useTaskActionsInFlight.getState();
    act(() => {
      store.start(taskActionKey(PROJECT, SPACE, 'one', 'dismiss'));
      store.start(taskActionKey('other-project', SPACE, 'one', 'retry'));
      store.start(taskActionKey(PROJECT, 'other-space', 'one', 'retry'));
    });
    expect(result.current).toBe(false);
    const key = taskActionKey(PROJECT, SPACE, 'one', 'retry');
    act(() => store.start(key));
    expect(result.current).toBe(true);
    act(() => store.end(key));
    expect(result.current).toBe(false);
  });

  it('reads a real document running count and node removal', () => {
    const data = seedNode();
    const { result } = renderHook(() => useSpaceTaskStatus(PROJECT, SPACE, 'canvas'));
    for (const [running, expected] of [[0, false], [2, true], [1, true], [0, false]] as const) {
      act(() => data.set('taskCounts', { running, done: 4, failed: 3, expired: 2 }));
      expect(result.current).toBe(expected);
    }
    act(() => data.set('taskCounts', { running: 1, done: 0, failed: 0, expired: 0 }));
    expect(result.current).toBe(true);
    act(() => getDoc(docName.canvasSpace(PROJECT, SPACE)).getMap('nodesMap').delete('node-one'));
    expect(result.current).toBe(false);
  });

  it('accepts a collaborator task received through a genuine Yjs update', () => {
    const remote = new Y.Doc();
    const document = getDoc(docName.canvasSpace(PROJECT, SPACE));
    const { result } = renderHook(() => useSpaceTaskStatus(PROJECT, SPACE, 'canvas'));
    const remoteNode = new Y.Map<unknown>();
    const remoteData = new Y.Map<unknown>();
    remoteData.set('name', 'Collaborator task');remoteData.set('createdBy', 'other-user');remoteData.set('locked', false);
    remoteData.set('taskCounts', { running: 1, done: 0, failed: 0, expired: 0 });
    remoteNode.set('type', 'image');remoteNode.set('data', remoteData);remoteNode.set('position', { x: 0, y: 0 });
    remote.getMap('nodesMap').set('peer-node', remoteNode);
    act(() => Y.applyUpdate(document, Y.encodeStateAsUpdate(remote)));
    expect(result.current).toBe(true);
    remoteData.set('taskCounts', { running: 0, done: 1, failed: 0, expired: 0 });
    act(() => Y.applyUpdate(document, Y.encodeStateAsUpdate(remote)));
    expect(result.current).toBe(false);
    remote.destroy();
  });

  it('preserves another source when one concurrent source finishes', () => {
    const data = seedNode(PROJECT, SPACE, 1);
    const { result } = renderHook(() => useSpaceTaskStatus(PROJECT, SPACE, 'canvas'));
    act(() => useSpaceOperationsStore.getState().register(SPACE, 'upload'));
    act(() => data.set('taskCounts', { running: 0, done: 1, failed: 0, expired: 0 }));
    expect(result.current).toBe(true);
    act(() => useSpaceOperationsStore.getState().unregister(SPACE, 'upload'));
    expect(result.current).toBe(false);
  });

  it('observes existing peer activity and its removal using real awareness', () => {
    seedNode();
    const document = getDoc(docName.canvasSpace(PROJECT, SPACE));
    const provider = acquireDocProvider(docName.canvasSpace(PROJECT, SPACE), document);
    const awareness = provider.awareness as Awareness;
    const { result } = renderHook(() => useSpaceTaskStatus(PROJECT, SPACE, 'canvas'));
    let peer: Awareness = awareness;
    act(() => { peer = addPeer(awareness); });
    expect(result.current).toBe(true);
    act(() => endPeer(awareness, peer));
    expect(result.current).toBe(false);
    act(() => { addPeer(awareness, 'missing-node'); addPeer(awareness, 'node-one', false); });
    expect(result.current).toBe(false);
    act(() => awareness.setLocalState({ user: { id: 'self' }, activity: [{ nodeId: 'node-one', action: 'upload', at: 1 }] }));
    expect(result.current).toBe(false);
  });

  it('notices a provider created after subscription and its final release', () => {
    seedNode();
    const name = docName.canvasSpace(PROJECT, SPACE);
    const { result } = renderHook(() => useSpaceTaskStatus(PROJECT, SPACE, 'canvas'));
    act(() => {
      const provider = acquireDocProvider(name, getDoc(name));
      addPeer(provider.awareness as Awareness);
    });
    expect(result.current).toBe(true);
    act(() => { releaseDocProvider(name);vi.runOnlyPendingTimers(); });
    expect(result.current).toBe(false);
  });

  it('uses the new Space after an identity change and releases old document observers on unmount', () => {
    const data = seedNode();
    const oldDocument = getDoc(docName.canvasSpace(PROJECT, SPACE));
    const unobserve = vi.spyOn(oldDocument.getMap('nodesMap'), 'unobserveDeep');
    const { result, rerender, unmount } = renderHook(({ space }) => useSpaceTaskStatus(PROJECT, space, 'canvas'), { initialProps: { space: SPACE } });
    rerender({ space: 'space-two' });
    act(() => data.set('taskCounts', { running: 1, done: 0, failed: 0, expired: 0 }));
    expect(result.current).toBe(false);
    expect(unobserve).toHaveBeenCalled();
    unmount();
  });

  it('continues observing outside a hidden or unvisited content Activity under StrictMode', () => {
    const data = seedNode();
    const { result, unmount } = renderHook(() => useSpaceTaskStatus(PROJECT, SPACE, 'canvas'), {
      wrapper: ({ children }) => <React.StrictMode>{children}<React.Activity mode='hidden'><span>Content</span></React.Activity></React.StrictMode>,
    });
    act(() => data.set('taskCounts', { running: 1, done: 0, failed: 0, expired: 0 }));
    expect(result.current).toBe(true);
    unmount();
  });
});
