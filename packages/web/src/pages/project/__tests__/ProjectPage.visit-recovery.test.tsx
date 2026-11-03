// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

import * as React from 'react';
import { act, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createMemoryRouter, RouterProvider } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { HocuspocusProvider } from '@hocuspocus/provider';
import type { ProjectVisitOpened, ProjectVisitLookup } from '@breatic/shared';
import type { ProjectDetail } from '@web/data/api/projects';
import { ApiException } from '@web/data/api/types';
import { TooltipProvider } from '@web/components/ui/tooltip';
import { useCurrentUserStore, useUIStore } from '@web/stores';

const boundary = vi.hoisted(() => {
  const listeners = new Map<string, Set<(data: unknown) => void>>();
  return {
    get: vi.fn(), post: vi.fn(), lookup: vi.fn(), listeners,
    provider: {
      on: (event: string, callback: (data: unknown) => void): void => {
        if (!listeners.has(event)) listeners.set(event, new Set());
        listeners.get(event)?.add(callback);
      },
      off: (event: string, callback: (data: unknown) => void): void => { listeners.get(event)?.delete(callback); },
    },
  };
});

vi.mock('@web/data/api/projects', async (original) => {
  const actual = await original<typeof import('@web/data/api/projects')>();
  return { ...actual, projectsApi: { ...actual.projectsApi, get: boundary.get, recordOpen: boundary.post, getOpenReceipt: boundary.lookup } };
});
vi.mock('@web/data/yjs/project-meta', async (original) => ({
  ...await original<typeof import('@web/data/yjs/project-meta')>(),
  useProjectMeta: (): ReturnType<typeof import('@web/data/yjs/project-meta').useProjectMeta> => ({
    spaces: [], users: new Map(), synced: true, status: 'connected',
    provider: boundary.provider as unknown as HocuspocusProvider, authFailedReason: null,
  }),
}));
vi.mock('@web/data/yjs/collab-socket', async (original) => ({
  ...await original<typeof import('@web/data/yjs/collab-socket')>(),
  CollabSocketProvider: ({ children }: { children: React.ReactNode }): React.JSX.Element => <>{children}</>,
}));
vi.mock('@web/pages/project/chrome/AgentColumn', () => ({ AgentColumn: (): null => null }));
vi.mock('@web/pages/project/chrome/top-bar/TopBar', async (original) => ({
  ...await original<typeof import('@web/pages/project/chrome/top-bar/TopBar')>(),
  TopBar: (): React.JSX.Element => <div data-testid='recovery-project-content' />,
}));

import ProjectPage from '@web/pages/project/ProjectPage';

const ACCOUNT = '00000000-0000-4000-8000-000000000001';
const PROJECT = '00000000-0000-4000-8000-000000000011';
const ORIGINAL_AT = '2026-11-02T23:59:59.123456Z';
const RECOVERIES = ['authenticated', 'reauth-close', 'query'] as const;
type Recovery = typeof RECOVERIES[number];
const project: ProjectDetail = {
  id: PROJECT, name: 'Recovery Project', description: null, thumbnailUrl: null,
  createdAt: '', updatedAt: '', studioId: '00000000-0000-4000-8000-000000000021',
  createdByUserId: ACCOUNT, myRole: 'owner', deletedAt: null, archivedAt: null, canRestore: false,
};

/** Preserve the actual receipt identity and full precision server instant. @throws {never} Never. */
function receipt(visitId: string): ProjectVisitOpened {
  return { ok: true, account_id: ACCOUNT, project_id: PROJECT, visit_id: visitId, occurred_at: ORIGINAL_AT };
}

/** Let one actual mocked transport remain in flight. @throws {never} Never. */
function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => { resolve = yes; });
  return { promise, resolve };
}

/** Mount production page, route, controller and query wiring; only I/O boundaries are replaced. @throws {Error} If rendering fails. */
async function setup(admitted = true): Promise<{ client: QueryClient; router: ReturnType<typeof createMemoryRouter>; unmount: () => void }> {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, retryDelay: 0, staleTime: Infinity, gcTime: Infinity } } });
  client.setQueryData(['studios', 'recent'], []);
  client.setQueryData(['project', PROJECT, 'credits'], null);
  client.setQueryData(['project-members', PROJECT], []);
  const router = createMemoryRouter([{ path: '/project/:projectId', element: <ProjectPage /> }, { path: '/studio', element: <div>Studio</div> }], { initialEntries: [`/project/${PROJECT}`] });
  const h = render(<React.StrictMode><QueryClientProvider client={client}><TooltipProvider>
    <RouterProvider router={router} />
  </TooltipProvider></QueryClientProvider></React.StrictMode>);
  if (admitted) {
    await screen.findByTestId('recovery-project-content');
    await waitFor(() => expect(boundary.post).toHaveBeenCalledTimes(1));
  }
  return { client, router, unmount: h.unmount };
}

/** Deliver real provider authentication or actual query completion to production listeners. @throws {Error} If the query refetch fails. */
async function restore(client: QueryClient, signal: Recovery): Promise<void> {
  await act(async () => {
    if (signal === 'authenticated') for (const callback of boundary.listeners.get('authenticated') ?? []) callback({ scope: 'read-write' });
    else if (signal === 'reauth-close') for (const callback of boundary.listeners.get('close') ?? []) callback({ event: { reason: 'Project archived' } });
    else await client.refetchQueries({ queryKey: ['project', PROJECT], exact: true });
  });
}

beforeEach(() => {
  vi.clearAllMocks(); boundary.listeners.clear();
  useUIStore.setState({ chatPanelCollapsed: true });
  useCurrentUserStore.setState({ user: { id: ACCOUNT, name: 'Account', email: 'account@example.test', personalStudio: { name: 'Account', slug: 'account' }, membershipTier: 'base' }, bootstrapped: true });
  boundary.get.mockResolvedValue(project);
  boundary.post.mockImplementation(async (_projectId: string, visitId: string) => receipt(visitId));
  boundary.lookup.mockImplementation(async (_projectId: string, visitId: string): Promise<ProjectVisitLookup> => ({ status: 'recorded', ...receipt(visitId) }));
});
afterEach(async () => { await act(async () => { useCurrentUserStore.setState({ user: null }); }); });

describe('ProjectPage original visit recovery from production signals (inner#1893)', () => {
  it.each(RECOVERIES.flatMap((signal) => ['unconfirmed', 'failed'].map((initial) => ({ signal, initial }))))('queries an original visit after $initial lookup and real $signal recovery without another POST', async ({ signal, initial }) => {
    boundary.post.mockRejectedValueOnce(new ApiException({ status: 0, message: 'original response lost', network: true }));
    if (initial === 'failed') boundary.lookup.mockRejectedValueOnce(new ApiException({ status: 0, message: 'original lookup unavailable', network: true }));
    else boundary.lookup.mockImplementationOnce(async (_projectId: string, visitId: string): Promise<ProjectVisitLookup> => ({ status: 'unconfirmed', account_id: ACCOUNT, project_id: PROJECT, visit_id: visitId }));
    const h = await setup();
    await waitFor(() => expect(boundary.lookup).toHaveBeenCalledTimes(1));
    const originalId = boundary.post.mock.calls[0]?.[1] as string;
    expect(h.client.getQueryState(['studios', 'recent'])?.isInvalidated).toBe(false);
    await restore(h.client, signal);
    await waitFor(() => expect(boundary.lookup).toHaveBeenCalledTimes(2));
    expect(boundary.lookup.mock.calls[1]?.slice(0, 2)).toEqual([PROJECT, originalId]);
    await waitFor(() => expect(h.client.getQueryState(['studios', 'recent'])?.isInvalidated).toBe(true));
    expect(boundary.post).toHaveBeenCalledTimes(1);
  });

  it.each(RECOVERIES)('queries the original pending visit after %s without resubmitting it', async (signal) => {
    const pending = deferred<ProjectVisitOpened>(); boundary.post.mockReturnValueOnce(pending.promise);
    const h = await setup(); const originalId = boundary.post.mock.calls[0]?.[1] as string;
    expect(boundary.lookup).not.toHaveBeenCalled();
    await restore(h.client, signal);
    await waitFor(() => expect(boundary.lookup).toHaveBeenCalledTimes(1));
    expect(boundary.lookup.mock.calls[0]?.slice(0, 2)).toEqual([PROJECT, originalId]);
    await waitFor(() => expect(h.client.getQueryState(['studios', 'recent'])?.isInvalidated).toBe(true));
    expect(boundary.post).toHaveBeenCalledTimes(1);
    await act(async () => { pending.resolve(receipt(originalId)); });
  });

  it.each(RECOVERIES.flatMap((signal) => ['recorded', 'rejected'].map((initial) => ({ signal, initial }))))('does not query or repost a $initial visit after $signal', async ({ signal, initial }) => {
    if (initial === 'rejected') boundary.post.mockRejectedValueOnce(new ApiException({ status: 403, message: 'not allowed', fromServer: true }));
    const h = await setup();
    if (initial === 'recorded') await waitFor(() => expect(h.client.getQueryState(['studios', 'recent'])?.isInvalidated).toBe(true));
    else await act(async () => { await Promise.resolve(); });
    await restore(h.client, signal);
    expect(boundary.lookup).not.toHaveBeenCalled();
    expect(boundary.post).toHaveBeenCalledTimes(1);
  });

  it.each(RECOVERIES.flatMap((signal) => ['logout', 'route-left'].map((end) => ({ signal, end }))))('stops original event recovery after $end when $signal arrives', async ({ signal, end }) => {
    boundary.post.mockRejectedValueOnce(new ApiException({ status: 0, message: 'original response lost', network: true }));
    boundary.lookup.mockImplementationOnce(async (_projectId: string, visitId: string): Promise<ProjectVisitLookup> => ({ status: 'unconfirmed', account_id: ACCOUNT, project_id: PROJECT, visit_id: visitId }));
    const h = await setup(); await waitFor(() => expect(boundary.lookup).toHaveBeenCalledTimes(1));
    if (end === 'logout') await act(async () => { useCurrentUserStore.setState({ user: null }); });
    // Route departure unmounts this real Page. Using its actual cleanup also
    // avoids jsdom AbortSignal versus Node Request realm mismatch in navigate.
    else h.unmount();
    await restore(h.client, signal);
    expect(boundary.lookup).toHaveBeenCalledTimes(1);
    expect(boundary.post).toHaveBeenCalledTimes(1);
    expect(h.client.getQueryState(['studios', 'recent'])?.isInvalidated).toBe(false);
  });

  it.each(['authenticated', 'reauth-close'] as const)('keeps %s behind the first accessible Project gate', async (signal) => {
    const loading = deferred<ProjectDetail>(); boundary.get.mockReturnValueOnce(loading.promise);
    const h = await setup(false);
    await restore(h.client, signal);
    expect(boundary.post).not.toHaveBeenCalled(); expect(boundary.lookup).not.toHaveBeenCalled();
    h.unmount(); await act(async () => { loading.resolve(project); });
  });

  it.each(['manual-project-data', 'different-project'] as const)('does not confuse $0 with a successful original Project refetch', async (change) => {
    boundary.post.mockRejectedValueOnce(new ApiException({ status: 0, message: 'original response lost', network: true }));
    boundary.lookup.mockImplementationOnce(async (_projectId: string, visitId: string): Promise<ProjectVisitLookup> => ({ status: 'unconfirmed', account_id: ACCOUNT, project_id: PROJECT, visit_id: visitId }));
    const h = await setup(); await waitFor(() => expect(boundary.lookup).toHaveBeenCalledTimes(1));
    await act(async () => {
      if (change === 'manual-project-data') h.client.setQueryData(['project', PROJECT], { ...project, name: 'Manual cache write' });
      else await h.client.fetchQuery({ queryKey: ['project', '00000000-0000-4000-8000-000000000099'], queryFn: async () => project });
    });
    expect(boundary.lookup).toHaveBeenCalledTimes(1); expect(boundary.post).toHaveBeenCalledTimes(1);
    expect(h.client.getQueryState(['studios', 'recent'])?.isInvalidated).toBe(false);
  });

  it('waits for the original Project query to recover successfully after a failed refresh', async () => {
    boundary.post.mockRejectedValueOnce(new ApiException({ status: 0, message: 'original response lost', network: true }));
    boundary.lookup.mockImplementationOnce(async (_projectId: string, visitId: string): Promise<ProjectVisitLookup> => ({ status: 'unconfirmed', account_id: ACCOUNT, project_id: PROJECT, visit_id: visitId }));
    const h = await setup(); await waitFor(() => expect(boundary.lookup).toHaveBeenCalledTimes(1));
    const readsBeforeFailure = boundary.get.mock.calls.length;
    boundary.get.mockRejectedValue(new ApiException({ status: 503, message: 'Project read unavailable', fromServer: true }));
    await restore(h.client, 'query');
    expect(boundary.get.mock.calls.length - readsBeforeFailure).toBe(3);
    expect(boundary.lookup).toHaveBeenCalledTimes(1);
    boundary.get.mockResolvedValue(project);
    await restore(h.client, 'query');
    await waitFor(() => expect(boundary.lookup).toHaveBeenCalledTimes(2));
    expect(boundary.lookup.mock.calls[1]?.slice(0, 2)).toEqual([PROJECT, boundary.post.mock.calls[0]?.[1]]);
    await waitFor(() => expect(h.client.getQueryState(['studios', 'recent'])?.isInvalidated).toBe(true));
    expect(boundary.post).toHaveBeenCalledTimes(1);
  });
});
