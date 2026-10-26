// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import * as React from 'react';
import { act, cleanup, render, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import * as Y from 'yjs';
import { Awareness } from 'y-protocols/awareness';
import { deriveId, documentBodyFragment, encodeInitialSpaceContent, readBodyTree, type DocumentProposal } from '@breatic/shared';

import { assetsApi, type UploadConfig } from '@web/data/api/assets';
import {
  _resetCollabSocketForTests,
  acquireDocProvider,
  CollabSocketProvider,
  readDocConnection,
} from '@web/data/yjs/collab-socket';
import { getDoc, _resetForTests as resetDocs } from '@web/data/yjs/manager';
import { useSocket } from '@web/data/yjs/use-socket';
import {
  _resetDocumentEditorCacheForTests,
  adoptDocumentEditor,
  evictDocumentEditor,
  getDocumentEditor,
  type DocumentEditorHandle,
} from '@web/spaces/document/document-editor-cache';
import * as landing from '@web/spaces/document/document-proposal-landing';
import { useDocumentProposalPickup } from '@web/spaces/document/use-document-proposal-pickup';
import { useDocumentProposals } from '@web/stores/document-proposals';
import { bodyBindingOf } from '@web/spaces/document/document-body-binding-key';
import { commentsOn } from '@web/spaces/document/document-comment-extension';

interface TransportProvider {
  document: Y.Doc;
  isAuthenticated: boolean;
  authorizedScope: string | undefined;
  synced: boolean;
  emit: (event: string, payload?: unknown) => void;
}

const transport = vi.hoisted(() => ({ providers: [] as TransportProvider[] }));
const toast = vi.hoisted(() => ({ warning: vi.fn(), error: vi.fn() }));
vi.mock('@web/lib/toast', () => ({ toast }));
vi.mock('@web/data/yjs/collab-failure-report', () => ({ reportCollabFailure: vi.fn() }));

// Keep the registry and useSocket real; only the network transport is replaced.
vi.mock('@hocuspocus/provider', () => ({
  HocuspocusProviderWebsocket: class {
    destroy = vi.fn();
    on = vi.fn();
  },
  HocuspocusProvider: class {
    document: Y.Doc;
    isAuthenticated = false;
    authorizedScope: string | undefined;
    synced = false;
    destroy = vi.fn();
    attach = vi.fn();
    listeners: Record<string, Array<(payload?: unknown) => void>> = {};
    on = vi.fn((event: string, listener: (payload?: unknown) => void) => {
      (this.listeners[event] ??= []).push(listener);
    });
    off = vi.fn((event: string, listener: (payload?: unknown) => void) => {
      this.listeners[event] = (this.listeners[event] ?? []).filter((next) => next !== listener);
    });

    /** Delivers an event after the test updates the provider's wire facts. */
    emit(event: string, payload?: unknown): void {
      for (const listener of [...(this.listeners[event] ?? [])]) listener(payload);
    }

    constructor(config: { document: Y.Doc }) {
      this.document = config.document;
      transport.providers.push(this);
    }
  },
}));

const SPACE_ID = '44444444-4444-4444-8444-444444444444';
const NAME = `project-project/document-${SPACE_ID}`;
const PROPOSAL_ID = '33333333-3333-4333-8333-333333333333';
const CONFIG: UploadConfig = {
  assetUrlPrefix: 'https://example.invalid/assets/',
  maxUploadBytes: 1024,
  clientMaxAttempts: 3,
  clientRetryBaseDelayMs: 500,
  uploadIdleTimeoutMs: 60000,
  uploadStatusPollSeconds: 5,
};

interface Gate {
  entered: Promise<void>;
  enter: () => void;
  released: Promise<UploadConfig>;
  release: () => void;
}

const gates: Gate[] = [];
const awareness: Awareness[] = [];
const extraDocs: Y.Doc[] = [];
let executionSpy: MockInstance<typeof landing.landProposal> | undefined;

/** Observes the real landing promise so tests can await completion precisely. */
function watchExecution(): MockInstance<typeof landing.landProposal> {
  executionSpy = vi.spyOn(landing, 'landProposal');
  return executionSpy;
}

/** Creates a deterministic pause in the real asynchronous preparation path. */
function gate(): Gate {
  let enter!: () => void;
  let release!: () => void;
  const entered = new Promise<void>((resolve) => { enter = resolve; });
  const released = new Promise<UploadConfig>((resolve) => { release = () => resolve(CONFIG); });
  const result = { entered, enter, released, release };
  gates.push(result);
  return result;
}

/** Pauses each fetch independently while keeping parsing and landing real. */
function pauseConfig(...waiting: Gate[]): void {
  const fetchConfig = vi.spyOn(assetsApi, 'fetchUploadConfig').mockResolvedValue(CONFIG);
  for (const next of waiting) {
    fetchConfig.mockImplementationOnce(() => {
      next.enter();
      return next.released;
    });
  }
}

/** Builds the cached editor and an already-loaded document connection. */
function open(doc: Y.Doc = getDoc(NAME)): DocumentEditorHandle {
  if (doc !== getDoc(NAME)) extraDocs.push(doc);
  if (readBodyTree(doc).status === 'uninitialized') Y.applyUpdate(doc, encodeInitialSpaceContent('document'));
  const provider = acquireDocProvider(NAME, doc) as unknown as TransportProvider;
  provider.isAuthenticated = true;
  provider.authorizedScope = 'read-write';
  provider.emit('authenticated', { scope: 'read-write' });
  provider.synced = true;
  provider.emit('synced');
  const cursor = new Awareness(doc);
  awareness.push(cursor);
  const handle = getDocumentEditor(doc, NAME, {
    caretProvider: { awareness: cursor },
    readWho: () => ({ role: 'editor', viewerId: 'reader-1' }),
    editable: true,
  });
  const host = document.createElement('div');
  document.body.append(host);
  adoptDocumentEditor(handle, host);
  handle.editor.replaceBlocks(handle.editor.document, [
    { id: 'target', type: 'paragraph', content: 'TARGET' },
  ] as never);
  handle.undoManager.clear();
  return handle;
}

/** A contract-shaped insert proposal aimed at the current target. */
function proposal(proposalId = PROPOSAL_ID, body = 'AGENT OUTPUT'): DocumentProposal {
  return {
    proposalId,
    spaceId: SPACE_ID,
    spaceName: 'Storyboard',
    kind: 'insert',
    blockId: 'target',
    body,
    title: 'Suggestion',
    heading: '',
    original: 'TARGET',
    blockType: 'paragraph',
    lossy: false,
  };
}

/** Reads actual shared editor words rather than a mock's write count. */
function textOf(handle: DocumentEditorHandle): string {
  return handle.editor.prosemirrorState.doc.textContent;
}

/** Mirrors actual shared updates without depending on an evicted editor view. */
function replicaOf(doc: Y.Doc): Y.Doc {
  const replica = new Y.Doc();
  extraDocs.push(replica);
  Y.applyUpdate(replica, Y.encodeStateAsUpdate(doc));
  doc.on('update', (update: Uint8Array) => Y.applyUpdate(replica, update));
  return replica;
}

beforeEach(() => {
  useDocumentProposals.getState().reset();
  toast.warning.mockReset();
  toast.error.mockReset();
  transport.providers.length = 0;
  executionSpy = undefined;
});

afterEach(async () => {
  cleanup();
  // Always finish controlled work, including when the first red assertion fails.
  await act(async () => {
    for (const next of gates.splice(0)) next.release();
    // At most three requests are queued in any fixture below.
    for (let pass = 0; pass < 3; pass += 1) {
      await Promise.allSettled((executionSpy?.mock.results ?? [])
        .filter((result) => result.type === 'return')
        .map((result) => result.value));
    }
  });
  _resetDocumentEditorCacheForTests();
  for (const cursor of awareness.splice(0)) cursor.destroy();
  _resetCollabSocketForTests();
  resetDocs();
  for (const doc of extraDocs.splice(0)) doc.destroy();
  useDocumentProposals.getState().reset();
  vi.restoreAllMocks();
  document.body.innerHTML = '';
});

describe('proposal pickup completion ownership (inner#1619)', () => {
  it.each((['waiting', 'failed'] as const).flatMap((state) => (['write', 'comment'] as const).map((action) => [state, action] as const)))(
    'retains the proposal and reports an incomplete %s runtime operation for %s', async (state, action) => {
      const handle = open();
      const held = proposal();
      const binding = bodyBindingOf(handle.editor.prosemirrorState);
      if (binding === null) throw new Error('Missing actual records binding');
      const waiting = gate();
      pauseConfig(waiting);
      const execute = watchExecution();
      useDocumentProposals.getState().start(held, action);
      const { result } = renderHook(() => useDocumentProposalPickup(SPACE_ID, handle, 'granted', false, NAME));
      if (action === 'write') await waiting.entered;
      act(() => {
        if (state === 'waiting') handle.runtime.wait(['context:later']);
        else handle.runtime.fail({ phase: 'idle', error: new Error('proposal preparation failure'), batch: null,
          epoch: binding.read().epoch, accepted: binding.read().doc, selection: null, journal: null,
          lastGood: binding.read(), writeStarted: false, writeReturned: false });
      });
      const source = getDoc(NAME);
      const before = Y.encodeStateAsUpdate(source);
      await act(async () => {
        waiting.release();
        await execute.mock.results[0].value;
      });
      await waitFor(() => expect(useDocumentProposals.getState().pending).toEqual({}));
      expect(Y.encodeStateAsUpdate(source)).toEqual(before);
      expect(commentsOn(handle.editor)!.threadStore.getThreads().size).toBe(0);
      expect(handle.undoManager.undoStack).toHaveLength(0);
      expect(result.current).toBeNull();
      expect(useDocumentProposals.getState().cards[PROPOSAL_ID]).toBeUndefined();
      expect(held.body).toBe('AGENT OUTPUT');
      expect(toast.error).toHaveBeenCalledTimes(1);
      expect(toast.warning).not.toHaveBeenCalled();
    },
  );

  it('keeps an actually written proposal through publication failure and recognizes it after reopening', async () => {
    const handle = open();
    const held = proposal();
    vi.spyOn(assetsApi, 'fetchUploadConfig').mockResolvedValue(CONFIG);
    const binding = bodyBindingOf(handle.editor.prosemirrorState);
    if (binding === null) throw new Error('Missing actual records binding');
    const stop = binding.subscribeApplied(() => { throw new Error('proposal publication failure'); });
    useDocumentProposals.getState().start(held, 'write');
    const { result } = renderHook(() => useDocumentProposalPickup(SPACE_ID, handle, 'granted', false, NAME));
    await waitFor(() => expect(useDocumentProposals.getState().pending).toEqual({}));
    stop();
    expect(handle.runtime.read().status).toBe('failed');
    const source = getDoc(NAME);
    const actual = readBodyTree(source);
    if (actual.status !== 'ready') throw new Error('Expected the actual written source');
    expect(actual.view.owners.flatMap((owner) => owner.units.map((unit) => unit.value)).join('')).toBe('TARGETAGENT OUTPUT');
    expect(result.current).toBeNull();
    expect(useDocumentProposals.getState().cards[PROPOSAL_ID]).toBeUndefined();
    expect(held.body).toBe('AGENT OUTPUT');
    expect(toast.error).toHaveBeenCalledTimes(1);

    const reopenedDoc = new Y.Doc();
    extraDocs.push(reopenedDoc);
    Y.applyUpdate(reopenedDoc, Y.encodeStateAsUpdate(source));
    const cursor = new Awareness(reopenedDoc);
    awareness.push(cursor);
    const reopened = getDocumentEditor(reopenedDoc, 'document:proposal-reopened-source', {
      caretProvider: { awareness: cursor }, readWho: () => ({ role: 'editor', viewerId: 'reader-1' }), editable: true,
    });
    const before = Y.encodeStateAsUpdate(reopenedDoc);
    expect(await landing.landProposal(reopened, held, 'write', () => ({ available: true, writeAccess: 'granted' }))).toEqual({
      outcome: 'applied', how: 'write', blockId: deriveId(`document-proposal:${PROPOSAL_ID}:0`),
    });
    expect(Y.encodeStateAsUpdate(reopenedDoc)).toEqual(before);
    expect(reopened.undoManager.undoStack).toHaveLength(0);
  });

  for (const ending of ['reset', 'reportSpace'] as const) {
    it(`does not write or publish after ${ending} ends its pending request during preparation`, async () => {
      const handle = open();
      const waiting = gate();
      pauseConfig(waiting);
      const execute = watchExecution();
      useDocumentProposals.getState().start(proposal(), 'write');
      const { result } = renderHook(() => useDocumentProposalPickup(SPACE_ID, handle, 'granted', false, NAME));
      await waiting.entered;

      act(() => {
        if (ending === 'reset') useDocumentProposals.getState().reset();
        else useDocumentProposals.getState().reportSpace(SPACE_ID, 'failed');
      });
      const before = textOf(handle);
      await act(async () => {
        waiting.release();
        await execute.mock.results[0].value;
      });

      expect(textOf(handle)).toBe(before);
      expect(useDocumentProposals.getState().pending).toEqual({});
      expect(useDocumentProposals.getState().cards).toEqual({});
      expect(result.current).toBeNull();
    });
  }

  it('does not report an old completion over a new pending object with the same proposal id', async () => {
    const handle = open();
    const old = gate();
    const fresh = gate();
    pauseConfig(old, fresh);
    const execute = watchExecution();
    useDocumentProposals.getState().start(proposal(), 'write');
    renderHook(() => useDocumentProposalPickup(SPACE_ID, handle, 'granted', false, NAME));
    await old.entered;

    act(() => {
      useDocumentProposals.getState().reportSpace(SPACE_ID, 'failed');
      useDocumentProposals.getState().start(proposal(PROPOSAL_ID, 'NEW REQUEST'), 'write');
    });
    const pending = useDocumentProposals.getState().pending[PROPOSAL_ID];
    await act(async () => {
      old.release();
      await execute.mock.results[0].value;
    });

    expect(textOf(handle)).toBe('TARGET');
    expect(useDocumentProposals.getState().pending[PROPOSAL_ID]).toBe(pending);
    expect(useDocumentProposals.getState().cards[PROPOSAL_ID]).toEqual({ state: 'working', action: 'write' });
  });

  it('does not write or publish through a provider replaced during preparation', async () => {
    const handle = open();
    const oldProvider = transport.providers[0];
    const waiting = gate();
    pauseConfig(waiting);
    const execute = watchExecution();
    useDocumentProposals.getState().start(proposal(), 'write');
    const { result } = renderHook(() => useDocumentProposalPickup(SPACE_ID, handle, 'granted', false, NAME));
    await waiting.entered;
    const pending = useDocumentProposals.getState().pending[PROPOSAL_ID];

    _resetCollabSocketForTests();
    const replacement = acquireDocProvider(NAME, oldProvider.document) as unknown as TransportProvider;
    replacement.isAuthenticated = true;
    replacement.authorizedScope = 'read-write';
    replacement.emit('authenticated', { scope: 'read-write' });
    replacement.synced = true;
    replacement.emit('synced');
    await act(async () => {
      waiting.release();
      await execute.mock.results[0].value;
    });

    expect(textOf(handle)).toBe('TARGET');
    expect(result.current).toBeNull();
    expect(useDocumentProposals.getState().pending[PROPOSAL_ID]).toBe(pending);
    expect(useDocumentProposals.getState().cards[PROPOSAL_ID]).toEqual({ state: 'working', action: 'write' });
  });

  it('does not publish after its cache handle was evicted during preparation', async () => {
    const handle = open();
    const waiting = gate();
    pauseConfig(waiting);
    const execute = watchExecution();
    useDocumentProposals.getState().start(proposal(), 'write');
    const { result } = renderHook(() => useDocumentProposalPickup(SPACE_ID, handle, 'granted', false, NAME));
    await waiting.entered;
    const pending = useDocumentProposals.getState().pending[PROPOSAL_ID];
    const replica = replicaOf(transport.providers[0].document);
    const before = documentBodyFragment(replica).toString();

    act(() => evictDocumentEditor(NAME));
    await act(async () => {
      waiting.release();
      await Promise.resolve(execute.mock.results[0].value).catch(() => undefined);
    });

    expect(documentBodyFragment(replica).toString()).toBe(before);
    expect(result.current).toBeNull();
    expect(useDocumentProposals.getState().pending[PROPOSAL_ID]).toBe(pending);
    expect(useDocumentProposals.getState().cards[PROPOSAL_ID]).toEqual({ state: 'working', action: 'write' });
  });

  it('lets the current unbuildable branch end a request after its cache handle is evicted', async () => {
    const handle = open();
    const waiting = gate();
    pauseConfig(waiting);
    const execute = watchExecution();
    useDocumentProposals.getState().start(proposal(), 'write');
    const { result, rerender } = renderHook(
      ({ unbuildable }) => useDocumentProposalPickup(SPACE_ID, handle, 'granted', unbuildable, NAME),
      { initialProps: { unbuildable: false } },
    );
    await waiting.entered;
    const replica = replicaOf(transport.providers[0].document);
    const before = documentBodyFragment(replica).toString();

    act(() => evictDocumentEditor(NAME));
    rerender({ unbuildable: true });
    expect(useDocumentProposals.getState().pending).toEqual({});
    expect(useDocumentProposals.getState().cards[PROPOSAL_ID]).toBeUndefined();
    await act(async () => {
      waiting.release();
      await Promise.resolve(execute.mock.results[0].value).catch(() => undefined);
    });

    expect(documentBodyFragment(replica).toString()).toBe(before);
    expect(result.current).toBeNull();
    expect(useDocumentProposals.getState().pending).toEqual({});
    expect(useDocumentProposals.getState().cards[PROPOSAL_ID]).toBeUndefined();
  });

  it('lets a new handle own its queue while the previous handle is still preparing', async () => {
    const firstHandle = open();
    const first = gate();
    const second = gate();
    const third = gate();
    pauseConfig(first, second, third);
    const execute = watchExecution();
    useDocumentProposals.getState().start(proposal(), 'write');
    const { rerender } = renderHook(
      ({ handle }) => useDocumentProposalPickup(SPACE_ID, handle, 'granted', false, NAME),
      { initialProps: { handle: firstHandle } },
    );
    await first.entered;

    let nextHandle!: DocumentEditorHandle;
    act(() => {
      useDocumentProposals.getState().reportSpace(SPACE_ID, 'failed');
      _resetCollabSocketForTests();
      nextHandle = open(new Y.Doc());
      useDocumentProposals.getState().start(proposal('55555555-5555-4555-8555-555555555555', 'SECOND'), 'write');
    });
    rerender({ handle: nextHandle });
    await waitFor(() => expect(execute).toHaveBeenCalledTimes(2));
    await second.entered;
    act(() => {
      useDocumentProposals.getState().start(proposal('66666666-6666-4666-8666-666666666666', 'THIRD'), 'write');
    });
    await act(async () => {
      first.release();
      await Promise.resolve(execute.mock.results[0].value).catch(() => undefined);
    });

    expect(execute).toHaveBeenCalledTimes(2);
    expect(textOf(nextHandle)).toBe('TARGET');
    expect(useDocumentProposals.getState().cards['55555555-5555-4555-8555-555555555555']).toEqual({ state: 'working', action: 'write' });
    await act(async () => {
      second.release();
      await execute.mock.results[1].value;
    });
    await third.entered;
    await act(async () => {
      third.release();
      await execute.mock.results[2].value;
    });
    expect(textOf(nextHandle)).toBe('TARGETTHIRDSECOND');
  });

  it('keeps a valid published landing after its pending request and execution owner end normally', async () => {
    const handle = open();
    vi.spyOn(assetsApi, 'fetchUploadConfig').mockResolvedValue(CONFIG);
    useDocumentProposals.getState().start(proposal(), 'write');
    const { result } = renderHook(() => useDocumentProposalPickup(SPACE_ID, handle, 'granted', false, NAME));

    await waitFor(() => expect(useDocumentProposals.getState().pending).toEqual({}));

    expect(useDocumentProposals.getState().cards[PROPOSAL_ID]).toEqual({ state: 'applied', action: 'write' });
    expect(result.current).toMatchObject({ how: 'write', blockId: deriveId(`document-proposal:${PROPOSAL_ID}:0`) });
    expect(textOf(handle)).toBe('TARGETAGENT OUTPUT');
  });

  for (const action of ['view', 'write'] as const) {
    it(`publishes an existing landing for ${action} before rejecting new writes on a denied connection`, async () => {
      const handle = open();
      const blockId = deriveId(`document-proposal:${PROPOSAL_ID}:0`);
      handle.editor.insertBlocks([
        { id: blockId, type: 'paragraph', content: 'ALREADY LANDED' },
      ] as never, 'target', 'after');
      const provider = transport.providers[0];
      provider.isAuthenticated = true;
      provider.authorizedScope = 'readonly';
      provider.emit('authenticated', { scope: 'readonly' });
      const fetchConfig = vi.spyOn(assetsApi, 'fetchUploadConfig');
      if (action === 'view') useDocumentProposals.getState().view(proposal(), 'write');
      else useDocumentProposals.getState().start(proposal(), 'write');
      const { result } = renderHook(() => useDocumentProposalPickup(SPACE_ID, handle, 'denied', false, NAME));

      await waitFor(() => expect(useDocumentProposals.getState().pending).toEqual({}));

      expect(result.current).toMatchObject({ how: 'write', blockId });
      expect(textOf(handle)).toBe('TARGETALREADY LANDED');
      expect(useDocumentProposals.getState().cards[PROPOSAL_ID]).toEqual({ state: 'applied', action: 'write' });
      expect(fetchConfig).not.toHaveBeenCalled();
      expect(toast.warning).not.toHaveBeenCalled();
    });
  }

  it('recognizes an existing landing before rejecting an unknown write scope on the same loaded provider', async () => {
    const handle = open();
    const blockId = deriveId(`document-proposal:${PROPOSAL_ID}:0`);
    handle.editor.insertBlocks([
      { id: blockId, type: 'paragraph', content: 'ALREADY LANDED' },
    ] as never, 'target', 'after');
    const provider = transport.providers[0];
    provider.isAuthenticated = false;
    const fetchConfig = vi.spyOn(assetsApi, 'fetchUploadConfig');
    const connection = readDocConnection(NAME);
    expect(connection?.provider).toBe(provider);
    expect(connection?.hasEverSynced).toBe(true);
    expect(connection?.writeAccess).toBe('unknown');

    const result = await landing.landProposal(handle, proposal(), 'write', () => ({
      available: true,
      writeAccess: readDocConnection(NAME)!.writeAccess,
    }));

    expect(result).toEqual({ outcome: 'applied', how: 'write', blockId });
    expect(textOf(handle)).toBe('TARGETALREADY LANDED');
    expect(fetchConfig).not.toHaveBeenCalled();
  });
});

describe('proposal pickup admission while its body is hidden', () => {
  for (const event of ['granted', 'readonly', 'unknown', 'refused'] as const) {
    it(`uses the registry's current ${event} facts when preparation finishes under Activity`, async () => {
      const handle = open();
      const provider = transport.providers[0];
      const waiting = gate();
      pauseConfig(waiting);
      const execute = watchExecution();
      let lastBodyAccess = 'unknown';
      let lastKeeperAccess = 'unknown';

      /** Keeps the open Space's connection alive outside Activity. */
      function Keeper(): null {
        const connection = useSocket({ name: NAME, doc: provider.document });
        lastKeeperAccess = connection.writeAccess;
        return null;
      }

      /** Reproduces the document body's real connection and pickup wiring. */
      function Body(): null {
        const connection = useSocket({ name: NAME, doc: provider.document });
        lastBodyAccess = connection.writeAccess;
        useDocumentProposalPickup(SPACE_ID, handle, connection.writeAccess, false, NAME);
        return null;
      }

      /** Retains the body and its preparation across a normal Space switch. */
      function App({ visible }: { visible: boolean }): React.JSX.Element {
        return (
          <CollabSocketProvider userId='reader-1'>
            <Keeper />
            <React.Activity mode={visible ? 'visible' : 'hidden'}><Body /></React.Activity>
          </CollabSocketProvider>
        );
      }

      const app = render(<App visible />);
      await waitFor(() => expect(lastBodyAccess).toBe('granted'));
      act(() => useDocumentProposals.getState().start(proposal(), 'write'));
      await waiting.entered;
      expect(lastBodyAccess).toBe('granted');
      expect(execute).toHaveBeenCalledOnce();
      expect(execute.mock.calls[0]?.[0]).toBe(handle);
      expect(execute.mock.calls[0]?.[1]).toMatchObject({ proposalId: PROPOSAL_ID });
      expect(textOf(handle)).toBe('TARGET');
      app.rerender(<App visible={false} />);
      act(() => {
        if (event === 'readonly') {
          provider.isAuthenticated = true;
          provider.authorizedScope = 'readonly';
          provider.emit('authenticated', { scope: 'readonly' });
        } else if (event === 'unknown') {
          provider.isAuthenticated = false;
          provider.emit('open');
        } else if (event === 'refused') {
          provider.emit('authenticationFailed', { reason: 'Forbidden' });
          provider.isAuthenticated = false;
        }
      });
      if (event === 'readonly' || event === 'refused') expect(lastKeeperAccess).toBe('denied');
      if (event === 'granted') expect(lastKeeperAccess).toBe('granted');
      // Activity cleanup may render useSocket's local mirror as unknown. The
      // granted request above is still preparing and must read current facts.
      await act(async () => {
        waiting.release();
        await execute.mock.results[0].value;
      });

      expect(useDocumentProposals.getState().pending).toEqual({});
      if (event === 'granted') {
        expect(textOf(handle)).toBe('TARGETAGENT OUTPUT');
        expect(useDocumentProposals.getState().cards[PROPOSAL_ID]).toEqual({ state: 'applied', action: 'write' });
        expect(toast.warning).not.toHaveBeenCalled();
        expect(toast.error).not.toHaveBeenCalled();
      } else {
        expect(textOf(handle)).toBe('TARGET');
        expect(useDocumentProposals.getState().cards[PROPOSAL_ID]).toBeUndefined();
        if (event === 'unknown') expect(toast.error).toHaveBeenCalledWith('Could not insert. Try again.');
        else expect(toast.warning).toHaveBeenCalledWith('You can only view this Document right now.');
      }
    });
  }
});
