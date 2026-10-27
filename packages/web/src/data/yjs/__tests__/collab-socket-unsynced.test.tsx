// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import * as Y from 'yjs';
import * as encoding from 'lib0/encoding';
import fc from 'fast-check';
import type * as RouterModule from 'react-router-dom';
import type * as ProviderModule from '@hocuspocus/provider';
import type * as ProjectMetaModule from '@web/data/yjs/project-meta';
import type * as ApiModule from '@web/data/api';

interface ProviderSpy {
  document: Y.Doc;
  isAttached: boolean;
  isAuthenticated: boolean;
  authorizedScope: string | undefined;
  sendStateless: ReturnType<typeof vi.fn>;
  emit: (event: string, data?: unknown) => void;
  destroy: ReturnType<typeof vi.fn>;
}

type BlockCondition = (args: {
  currentLocation: { pathname: string };
  nextLocation: { pathname: string; state?: unknown };
  historyAction: string;
}) => boolean;

const { providers, sockets, routerState } = vi.hoisted(() => ({
  providers: [] as ProviderSpy[],
  sockets: [] as Array<{ status: string; webSocket: { readyState: number }; receivedOnOpenPayload: Event }>,
  routerState: { condition: null as BlockCondition | null, listeners: new Set<() => void>(), blocker: { state: 'unblocked', proceed: vi.fn(), reset: vi.fn() } },
}));

vi.mock('react-router-dom', async (importOriginal) => {
  const { useSyncExternalStore } = await import('react');
  return {
    ...await importOriginal<typeof RouterModule>(),
    useBlocker: (condition: BlockCondition) => {
      useSyncExternalStore((listener) => {
        routerState.listeners.add(listener);
        return () => { routerState.listeners.delete(listener); };
      }, () => routerState.blocker.state);
      routerState.condition = condition;
      return routerState.blocker;
    },
  };
});

vi.mock('@hocuspocus/provider', async (importOriginal) => ({
  ...await importOriginal<typeof ProviderModule>(),
  HocuspocusProviderWebsocket: class {
    status = 'connected';
    webSocket = { readyState: 1 };
    receivedOnOpenPayload = new Event('open');
    on = vi.fn();
    off = vi.fn();
    destroy = vi.fn();
    constructor() { sockets.push(this); }
  },
  HocuspocusProvider: class {
    isAttached = false;
    isAuthenticated = true;
    authorizedScope: string | undefined = 'read-write';
    synced = false;
    configuration: { name: string; document: Y.Doc; websocketProvider: unknown };
    document: Y.Doc;
    sendStateless = vi.fn();
    listeners = new Map<string, Set<(data?: unknown) => void>>();
    on = vi.fn((event: string, callback: (data?: unknown) => void): void => {
      const callbacks = this.listeners.get(event) ?? new Set();
      callbacks.add(callback);
      this.listeners.set(event, callbacks);
    });
    off = vi.fn((event: string, callback: (data?: unknown) => void): void => {
      this.listeners.get(event)?.delete(callback);
    });
    emit(event: string, data?: unknown): void {
      for (const callback of [...(this.listeners.get(event) ?? [])]) callback(data);
    }
    attach = vi.fn((): void => { this.isAttached = true; });
    onOpen = vi.fn((): void => { this.isAuthenticated = false; });
    destroy = vi.fn((): void => { this.isAttached = false; });
    constructor(configuration: { name: string; document: Y.Doc; websocketProvider: unknown }) {
      this.configuration = configuration;
      this.document = configuration.document;
      providers.push(this);
    }
  },
}));
vi.mock('@web/data/yjs/collab-failure-report', () => ({ reportCollabFailure: vi.fn() }));

vi.mock('@web/data/yjs/project-meta', async (importOriginal) => ({
  ...await importOriginal<typeof ProjectMetaModule>(),
  useProjectMeta: () => ({ spaces: [], users: new Map(), synced: true, provider: null, status: 'disconnected', authFailedReason: null }),
}));
vi.mock('@web/pages/project/use-record-project-open', () => ({ useRecordProjectOpen: (): undefined => undefined }));
vi.mock('@web/data/api', async (importOriginal) => {
  const actual = await importOriginal<typeof ApiModule>();
  return {
    ...actual,
    projectsApi: {
      ...actual.projectsApi,
      get: vi.fn(async () => ({ id: '11111111-1111-4111-8111-111111111111', name: 'Demo project', description: null, thumbnailUrl: null, createdAt: '', updatedAt: '', studioId: 's1', createdByUserId: 'u-me', myRole: 'owner', deletedAt: null, archivedAt: null, canRestore: false })),
    },
    membersApi: { ...actual.membersApi, list: vi.fn(async () => ({ members: [] })) },
  };
});

import { COLLAB_REAUTH_REASONS, spaceContentDocName, projectMetaDocName } from '@breatic/shared';
import { acquireDocProvider, releaseDocProvider, _resetCollabSocketForTests } from '@web/data/yjs/collab-socket';
import { getDoc, _resetForTests } from '@web/data/yjs/manager';
import { LeaveProjectGuard } from '@web/pages/project/LeaveProjectGuard';
import { useSpaceOperationsStore } from '@web/stores/space-operations';
import { useCurrentUserStore, useUIStore } from '@web/stores';
import { TooltipProvider } from '@web/components/ui/tooltip';
import ProjectPage from '@web/pages/project/ProjectPage';

const PID = '11111111-1111-4111-8111-111111111111';
const OTHER = '33333333-3333-4333-8333-333333333333';
const SID = '22222222-2222-4222-8222-222222222222';

/**
 * Mounts the actual guard with the same project route parameter as the page.
 * @returns Nothing.
 * @throws {Error} When rendering fails.
 */
function mountGuard(): void {
  render(<MemoryRouter initialEntries={[`/project/demo-${PID}`]}><Routes><Route path='/project/:projectId' element={<LeaveProjectGuard />} /></Routes></MemoryRouter>);
}

/**
 * Invokes the production route predicate after an event changes the registry.
 * @returns Whether an ordinary navigation away is blocked.
 * @throws {AssertionError} When the guard did not register its predicate.
 */
function blocked(): boolean {
  expect(typeof routerState.condition).toBe('function');
  return routerState.condition!({ currentLocation: { pathname: `/project/demo-${PID}` }, nextLocation: { pathname: '/studio' }, historyAction: 'PUSH' });
}

/**
 * Acquires a real registered Y.Doc with an isolated transport.
 * @returns The owned document and its provider spy.
 * @throws {Error} When acquiring fails.
 */
function content(kind: 'canvas' | 'document' = 'canvas', projectId = PID): { name: string; doc: Y.Doc; provider: ProviderSpy } {
  const name = spaceContentDocName(projectId, SID, kind);
  const doc = getDoc(name);
  const provider = acquireDocProvider(name, doc) as unknown as ProviderSpy;
  return { name, doc, provider };
}

/**
 * Delivers the raw incoming Step1 observed by the production listener.
 * @returns Nothing.
 * @throws {Error} When an event handler fails.
 */
function receiveStep1(name: string, provider: ProviderSpy): void {
  const encoder = encoding.createEncoder();
  encoding.writeVarString(encoder, name);
  encoding.writeVarUint(encoder, 0);
  encoding.writeVarUint(encoder, 0);
  encoding.writeVarUint8Array(encoder, new Uint8Array([0]));
  provider.emit('message', { event: { data: encoding.toUint8Array(encoder) } });
}

/**
 * Completes the authenticated handshake input and lets receipt microtasks run.
 * @returns Nothing.
 * @throws {Error} When an event handler fails.
 */
async function handshake(name: string, provider: ProviderSpy): Promise<void> {
  provider.isAuthenticated = true;
  provider.authorizedScope = 'read-write';
  await act(async () => {
    provider.emit('authenticated', { scope: 'read-write' });
    receiveStep1(name, provider);
    await Promise.resolve();
  });
}

/**
 * Returns only actual sync confirmation requests recorded on the provider.
 * @returns The request payloads in send order.
 * @throws {SyntaxError} When the implementation sends invalid JSON.
 */
function requests(provider: ProviderSpy): Array<{ type: string; id: string }> {
  return provider.sendStateless.mock.calls.map(([body]) => JSON.parse(String(body)) as { type: string; id: string }).filter((body) => body.type === 'sync:confirm');
}

/**
 * Delivers a response on the same content provider.
 * @returns Nothing.
 * @throws {Error} When an event handler fails.
 */
async function confirm(provider: ProviderSpy, id: string, ok = true): Promise<void> {
  await act(async () => { provider.emit('stateless', { payload: JSON.stringify({ type: 'sync:confirmed', id, ok }) }); await Promise.resolve(); });
}

beforeEach(() => {
  providers.length = 0;
  sockets.length = 0;
  routerState.condition = null;
  routerState.blocker.state = 'unblocked';
  routerState.blocker.proceed.mockClear();
  routerState.blocker.reset.mockClear();
  useSpaceOperationsStore.setState({ operations: {} });
  mountGuard();
});

afterEach(() => {
  cleanup();
  _resetCollabSocketForTests();
  _resetForTests();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('ProjectPage refresh and browser leave entry points (inner#1641)', () => {
  let reload: ReturnType<typeof vi.fn>;
  let queryClient: QueryClient;

  beforeEach(async () => {
    cleanup();
    useUIStore.setState({ chatPanelCollapsed: true });
    useCurrentUserStore.setState({
      user: { id: 'u-me', name: 'Me', email: 'me@example.test', personalStudio: { name: 'Me', slug: 'me', avatarUrl: null }, membershipTier: 'base' },
      role: null, loading: false, bootstrapped: true,
    });
    reload = vi.fn();
    vi.spyOn(window, 'location', 'get').mockReturnValue({ ...window.location, reload });
    queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false } } });
    render(<QueryClientProvider client={queryClient}><TooltipProvider><MemoryRouter initialEntries={[`/project/demo-${PID}`]}><Routes><Route path='/project/:projectId' element={<ProjectPage />} /></Routes></MemoryRouter></TooltipProvider></QueryClientProvider>);
    await screen.findByTestId('connection-banner-reload');
  });

  afterEach(() => {
    cleanup();
    queryClient.clear();
  });

  it.each(['canvas', 'document'] as const)('reads a new %s edit at beforeunload event time', (kind) => {
    const item = content(kind);
    const clean = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(clean);
    expect(clean.defaultPrevented).toBe(false);
    act(() => { item.doc.getText('body').insert(0, 'retain this'); });
    const dirty = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(dirty);
    expect(dirty.defaultPrevented).toBe(true);
    expect(item.doc.getText('body').toString()).toBe('retain this');
  });

  it('keeps the existing operation guard active without a local edit', () => {
    act(() => { useSpaceOperationsStore.getState().register(SID, 'upload'); });
    const event = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
  });

  it('refreshes immediately while disconnected without edits or operations', () => {
    fireEvent.click(screen.getByTestId('connection-banner-reload'));
    expect(reload).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('alertdialog')).toBeNull();
  });

  it('asks before refreshing and keeps the document unchanged on cancel', async () => {
    const item = content('document');
    act(() => { item.doc.getText('body').insert(0, 'keep my edit'); });
    const bytes = Y.encodeStateAsUpdate(item.doc);
    const trigger = screen.getByTestId('connection-banner-reload');
    trigger.focus();
    fireEvent.click(trigger);
    expect(reload).toHaveBeenCalledTimes(0);
    const dialog = screen.getByRole('alertdialog');
    fireEvent.click(within(dialog).getByRole('button', { name: /cancel/i }));
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(reload).toHaveBeenCalledTimes(0);
    expect(Y.encodeStateAsUpdate(item.doc)).toEqual(bytes);
    await waitFor(() => expect(trigger).toHaveFocus());
  });

  it('cancels refresh with Escape and restores focus without changing content', async () => {
    const item = content();
    act(() => { item.doc.getText('body').insert(0, 'keep'); });
    const bytes = Y.encodeStateAsUpdate(item.doc);
    const trigger = screen.getByTestId('connection-banner-reload');
    trigger.focus();
    fireEvent.click(trigger);
    expect(reload).toHaveBeenCalledTimes(0);
    expect(screen.getByRole('alertdialog')).toBeInTheDocument();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(Y.encodeStateAsUpdate(item.doc)).toEqual(bytes);
    expect(reload).toHaveBeenCalledTimes(0);
    await waitFor(() => expect(trigger).toHaveFocus());
  });

  it('gives a blocked route priority over the pending refresh choice', () => {
    const item = content();
    act(() => { item.doc.getText('body').insert(0, 'keep'); });
    fireEvent.click(screen.getByTestId('connection-banner-reload'));
    expect(reload).toHaveBeenCalledTimes(0);
    act(() => { routerState.blocker.state = 'blocked'; routerState.listeners.forEach((listener) => listener()); });
    const dialogs = screen.getAllByRole('alertdialog');
    expect(dialogs).toHaveLength(1);
    fireEvent.click(within(dialogs[0]).getByRole('button', { name: /leave/i }));
    expect(routerState.blocker.proceed).toHaveBeenCalledTimes(1);
    expect(routerState.blocker.reset).toHaveBeenCalledTimes(0);
    expect(reload).toHaveBeenCalledTimes(0);
    act(() => { routerState.blocker.state = 'unblocked'; routerState.listeners.forEach((listener) => listener()); });
    expect(screen.queryByRole('alertdialog')).toBeNull();
  });

  it('clears the native allowance when the approved reload throws', () => {
    const item = content();
    act(() => { item.doc.getText('body').insert(0, 'keep'); });
    fireEvent.click(screen.getByTestId('connection-banner-reload'));
    expect(reload).toHaveBeenCalledTimes(0);
    reload.mockImplementation(() => { throw new Error('reload failed'); });
    const onError = (event: ErrorEvent): void => { event.preventDefault(); };
    window.addEventListener('error', onError);
    try {
      fireEvent.click(within(screen.getByRole('alertdialog')).getAllByRole('button')[1]);
      expect(reload).toHaveBeenCalledTimes(1);
      expect(reload.mock.results[0]?.type).toBe('throw');
      const event = new Event('beforeunload', { cancelable: true });
      window.dispatchEvent(event);
      expect(event.defaultPrevented).toBe(true);
    } finally { window.removeEventListener('error', onError); }
  });

  it('confirms an application refresh once and consumes one native allowance', () => {
    const item = content();
    act(() => { item.doc.getText('body').insert(0, 'pending'); });
    fireEvent.click(screen.getByTestId('connection-banner-reload'));
    expect(reload).toHaveBeenCalledTimes(0);
    const dialog = screen.getByRole('alertdialog');
    const buttons = within(dialog).getAllByRole('button');
    expect(buttons).toHaveLength(2);
    fireEvent.click(buttons[1]);
    expect(reload).toHaveBeenCalledTimes(1);
    const approved = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(approved);
    expect(approved.defaultPrevented).toBe(false);
    const subsequent = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(subsequent);
    expect(subsequent.defaultPrevented).toBe(true);
  });

  it.each(['pointerdown', 'keydown'])('revokes an unconsumed native allowance on %s', (type) => {
    const item = content();
    act(() => { item.doc.getText('body').insert(0, 'pending'); });
    fireEvent.click(screen.getByTestId('connection-banner-reload'));
    expect(reload).toHaveBeenCalledTimes(0);
    fireEvent.click(within(screen.getByRole('alertdialog')).getAllByRole('button')[1]);
    expect(reload).toHaveBeenCalledTimes(1);
    window.dispatchEvent(type === 'keydown' ? new KeyboardEvent(type, { key: 'a', bubbles: true }) : new Event(type, { bubbles: true }));
    const event = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
  });

  it.each([
    ['refresh', 'edit'],
    ['refresh', 'operation'],
    ['leave', 'edit'],
    ['leave', 'operation'],
  ] as const)('updates the %s confirmation title as risks clear %s first', async (intent, first) => {
    const item = content();
    act(() => {
      item.doc.getText('body').insert(0, 'pending');
      useSpaceOperationsStore.getState().register(SID, 'upload');
    });
    await handshake(item.name, item.provider);
    expect(requests(item.provider)).toHaveLength(1);
    if (intent === 'refresh') fireEvent.click(screen.getByTestId('connection-banner-reload'));
    else act(() => { routerState.blocker.state = 'blocked'; routerState.listeners.forEach((listener) => listener()); });
    const dialog = screen.getByRole('alertdialog');
    const riskTitle = intent === 'refresh' ? 'Refresh with work in progress?' : 'Leave with work in progress?';
    expect(within(dialog).getByRole('heading')).toHaveTextContent(riskTitle);
    if (first === 'edit') await confirm(item.provider, requests(item.provider)[0].id);
    else act(() => { useSpaceOperationsStore.getState().unregister(SID, 'upload'); });
    expect(within(dialog).getByRole('heading')).toHaveTextContent(riskTitle);
    if (first === 'edit') act(() => { useSpaceOperationsStore.getState().unregister(SID, 'upload'); });
    else await confirm(item.provider, requests(item.provider)[0].id);
    expect(within(dialog).getByRole('heading')).toHaveTextContent('Ready to continue');
    expect(dialog).toHaveTextContent('Changes are synced and operations are complete.');
    expect(within(dialog).getAllByRole('button').map((button) => button.textContent)).toEqual(intent === 'refresh' ? ['Cancel', 'Refresh anyway'] : ['Stay', 'Leave anyway']);
    expect(reload).toHaveBeenCalledTimes(0);
    expect(routerState.blocker.proceed).toHaveBeenCalledTimes(0);
    expect(routerState.blocker.reset).toHaveBeenCalledTimes(0);
    act(() => { item.doc.getText('body').insert(0, 'new edit'); });
    expect(within(dialog).getByRole('heading')).toHaveTextContent(riskTitle);
  });

  it('asks before refreshing while an upload is the only remaining risk', () => {
    act(() => { useSpaceOperationsStore.getState().register(SID, 'upload'); });
    fireEvent.click(screen.getByTestId('connection-banner-reload'));
    expect(reload).toHaveBeenCalledTimes(0);
    expect(screen.getByRole('alertdialog')).toBeInTheDocument();
  });
});

describe('registered content edits drive project leave protection (inner#1641)', () => {
  it.each(['canvas', 'document'] as const)('blocks a local %s edit after the guard has mounted', (kind) => {
    const { doc } = content(kind);
    expect(blocked()).toBe(false);
    act(() => { doc.getText('body').insert(0, 'local edit'); });
    expect(blocked()).toBe(true);
    expect(doc.getText('body').toString()).toBe('local edit');
  });

  it('keeps background content contributing while another content document is open', () => {
    const background = content('document');
    content('canvas');
    act(() => { background.doc.getText('body').insert(0, 'background edit'); });
    expect(blocked()).toBe(true);
  });

  it('isolates other Projects and excludes meta and timeline documents', () => {
    const elsewhere = content('document', OTHER);
    const name = projectMetaDocName(PID);
    const meta = getDoc(name);
    acquireDocProvider(name, meta);
    const timelineName = spaceContentDocName(PID, SID, 'timeline');
    const timeline = getDoc(timelineName);
    acquireDocProvider(timelineName, timeline);
    act(() => { elsewhere.doc.getText('body').insert(0, 'elsewhere'); meta.getMap('settings').set('value', 'meta edit'); timeline.getText('body').insert(0, 'timeline edit'); });
    expect(blocked()).toBe(false);
  });

  it('keeps empty handshakes, disconnects without edits and remote updates clean', async () => {
    const item = content();
    await handshake(item.name, item.provider);
    item.provider.emit('close', { event: { reason: '' } });
    const peer = new Y.Doc();
    try {
      peer.getText('body').insert(0, 'remote');
      act(() => { Y.applyUpdate(item.doc, Y.encodeStateAsUpdate(peer), item.provider); });
      expect(blocked()).toBe(false);
      expect(requests(item.provider)).toEqual([]);
    } finally { peer.destroy(); }
  });

  it('does not count a provider-origin local transaction as a user edit', () => {
    const item = content();
    act(() => { item.doc.transact(() => item.doc.getText('body').insert(0, 'provider'), item.provider); });
    expect(blocked()).toBe(false);
  });

  it('does not trust native count zero or synced while local content is unconfirmed', () => {
    const { doc, provider } = content();
    act(() => { doc.getText('body').insert(0, 'still local'); provider.emit('unsyncedChanges', { number: 0 }); provider.emit('synced', { state: true }); });
    expect(blocked()).toBe(true);
  });

  it('sends one receipt after the current handshake and preserves a newer local version', async () => {
    const item = content();
    act(() => { item.doc.getText('body').insert(0, 'A'); });
    expect(requests(item.provider)).toEqual([]);
    await handshake(item.name, item.provider);
    expect(requests(item.provider)).toHaveLength(1);
    const first = requests(item.provider)[0].id;
    act(() => { item.doc.getText('body').insert(1, 'B'); });
    await act(async () => { await Promise.resolve(); });
    expect(requests(item.provider)).toHaveLength(1);
    await confirm(item.provider, first);
    expect(blocked()).toBe(true);
    expect(requests(item.provider)).toHaveLength(2);
    const second = requests(item.provider)[1].id;
    expect(second).not.toBe(first);
    await confirm(item.provider, first);
    expect(blocked()).toBe(true);
    await confirm(item.provider, second);
    expect(blocked()).toBe(false);
    expect(item.doc.getText('body').toString()).toBe('AB');
  });

  it.each(['attached', 'socket', 'authenticated', 'writable'])('requires the %s sending condition after a handshake', async (gate) => {
    const item = content();
    await handshake(item.name, item.provider);
    if (gate === 'attached') item.provider.isAttached = false;
    if (gate === 'socket') sockets[0].webSocket.readyState = 3;
    if (gate === 'authenticated') item.provider.isAuthenticated = false;
    if (gate === 'writable') item.provider.authorizedScope = 'readonly';
    await act(async () => { item.doc.getText('body').insert(0, 'pending'); await Promise.resolve(); });
    expect(requests(item.provider)).toEqual([]);
    expect(blocked()).toBe(true);
    item.provider.isAttached = true;
    sockets[0].webSocket.readyState = 1;
    item.provider.emit('close', { event: { reason: COLLAB_REAUTH_REASONS.permissionChanged } });
    await handshake(item.name, item.provider);
    expect(requests(item.provider)).toHaveLength(1);
  });

  it('ignores malformed and unrelated messages while preserving a pending receipt', async () => {
    const item = content();
    act(() => { item.doc.getText('body').insert(0, 'pending'); });
    await handshake(item.name, item.provider);
    expect(requests(item.provider)).toHaveLength(1);
    const id = requests(item.provider)[0].id;
    for (const payload of ['{', 'null', JSON.stringify({ type: 'activity:new' }), JSON.stringify({ type: 'sync:confirmed', id }), JSON.stringify({ type: 'sync:confirmed', id, ok: true, extra: 1 })]) {
      await act(async () => { item.provider.emit('stateless', { payload }); await Promise.resolve(); });
      expect(blocked()).toBe(true);
      expect(requests(item.provider)).toHaveLength(1);
    }
    await confirm(item.provider, id);
    expect(blocked()).toBe(false);
  });

  it.each(['edit', 'operation'])('keeps the remaining risk after clearing the %s first', async (first) => {
    const item = content();
    act(() => { item.doc.getText('body').insert(0, 'pending'); useSpaceOperationsStore.getState().register(SID, 'upload'); });
    await handshake(item.name, item.provider);
    expect(requests(item.provider)).toHaveLength(1);
    if (first === 'edit') await confirm(item.provider, requests(item.provider)[0].id);
    else act(() => { useSpaceOperationsStore.getState().unregister(SID, 'upload'); });
    expect(blocked()).toBe(true);
    if (first === 'edit') act(() => { useSpaceOperationsStore.getState().unregister(SID, 'upload'); });
    else await confirm(item.provider, requests(item.provider)[0].id);
    expect(blocked()).toBe(false);
  });

  it.each(['close', 'authenticationFailed', 'reauth'] as const)('keeps edits when an old response arrives after %s', async (event) => {
    const item = content();
    act(() => { item.doc.getText('body').insert(0, 'offline'); });
    await handshake(item.name, item.provider);
    expect(requests(item.provider)).toHaveLength(1);
    const oldId = requests(item.provider)[0].id;
    const bytes = Y.encodeStateAsUpdate(item.doc);
    act(() => {
      item.provider.emit(event === 'authenticationFailed' ? event : 'close', event === 'authenticationFailed'
        ? { reason: 'refused' }
        : { event: { reason: event === 'reauth' ? COLLAB_REAUTH_REASONS.permissionChanged : 'Reset Connection' } });
    });
    expect(blocked()).toBe(true);
    expect(Y.encodeStateAsUpdate(item.doc)).toEqual(bytes);
    await confirm(item.provider, oldId);
    expect(blocked()).toBe(true);
    expect(requests(item.provider)).toHaveLength(1);
    await handshake(item.name, item.provider);
    expect(requests(item.provider)).toHaveLength(2);
    await confirm(item.provider, requests(item.provider)[1].id);
    expect(blocked()).toBe(false);
    expect(Y.encodeStateAsUpdate(item.doc)).toEqual(bytes);
  });

  it('invalidates a queued Step1 callback when the connection closes in the same turn', async () => {
    const item = content();
    await act(async () => {
      item.doc.getText('body').insert(0, 'pending');
      receiveStep1(item.name, item.provider);
      item.provider.emit('close', { event: { reason: '' } });
      await Promise.resolve();
    });
    expect(requests(item.provider)).toEqual([]);
    expect(blocked()).toBe(true);
    await handshake(item.name, item.provider);
    expect(requests(item.provider)).toHaveLength(1);
  });

  it('holds rejected content until writable reauthentication and a new handshake', async () => {
    const item = content();
    act(() => { item.doc.getText('body').insert(0, 'local'); });
    await handshake(item.name, item.provider);
    expect(requests(item.provider)).toHaveLength(1);
    await confirm(item.provider, requests(item.provider)[0].id, false);
    expect(blocked()).toBe(true);
    item.provider.authorizedScope = 'readonly';
    act(() => { item.doc.getText('body').insert(5, ' edit'); });
    await act(async () => { await Promise.resolve(); });
    expect(requests(item.provider)).toHaveLength(1);
    item.provider.emit('close', { event: { reason: COLLAB_REAUTH_REASONS.permissionChanged } });
    await handshake(item.name, item.provider);
    expect(requests(item.provider)).toHaveLength(2);
    await confirm(item.provider, requests(item.provider)[1].id);
    expect(blocked()).toBe(false);
  });

  it('tracks a pure deletion after the preceding text is confirmed', async () => {
    const item = content('document');
    act(() => { item.doc.getText('body').insert(0, 'delete me'); });
    await handshake(item.name, item.provider);
    expect(requests(item.provider)).toHaveLength(1);
    await confirm(item.provider, requests(item.provider)[0].id);
    expect(blocked()).toBe(false);
    act(() => { item.doc.getText('body').delete(0, 9); });
    expect(item.doc.getText('body').toString()).toBe('');
    expect(blocked()).toBe(true);
    await act(async () => { await Promise.resolve(); });
    expect(requests(item.provider)).toHaveLength(2);
    await confirm(item.provider, requests(item.provider)[1].id);
    expect(blocked()).toBe(false);
  });

  it('preserves dirty facts through a StrictMode release and reacquire', () => {
    vi.useFakeTimers();
    const item = content();
    act(() => { item.doc.getText('body').insert(0, 'keep'); releaseDocProvider(item.name); });
    const provider = acquireDocProvider(item.name, item.doc);
    act(() => { vi.runOnlyPendingTimers(); });
    expect(provider).toBe(item.provider);
    expect(item.provider.destroy).toHaveBeenCalledTimes(0);
    expect(blocked()).toBe(true);
  });

  it('releases dirty facts and ignores provider events after final release', async () => {
    vi.useFakeTimers();
    const item = content();
    act(() => { item.doc.getText('body').insert(0, 'old'); });
    expect(blocked()).toBe(true);
    releaseDocProvider(item.name);
    act(() => { vi.runOnlyPendingTimers(); });
    await handshake(item.name, item.provider);
    expect(requests(item.provider)).toEqual([]);
    expect(blocked()).toBe(false);
    const fresh = content();
    expect(fresh.doc).not.toBe(item.doc);
    expect(blocked()).toBe(false);
  });

  it('preserves either remaining risk across generated edit and operation combinations', () => {
    fc.assert(fc.property(fc.boolean(), fc.boolean(), (dirty, busy) => {
      _resetCollabSocketForTests();
      _resetForTests();
      useSpaceOperationsStore.setState({ operations: {} });
      const item = content();
      act(() => {
        if (dirty) item.doc.getText('body').insert(0, 'pending');
        if (busy) useSpaceOperationsStore.getState().register(SID, 'upload');
      });
      expect(blocked()).toBe(dirty || busy);
    }), { seed: 1641, numRuns: 30 });
  });
});
