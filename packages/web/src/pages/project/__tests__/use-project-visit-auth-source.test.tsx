// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

import * as React from 'react';
import { act, renderHook, type RenderHookResult } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as ProjectApiModule from '@web/data/api/projects';

vi.mock('@web/data/api/projects', async (importOriginal) => ({
  ...(await importOriginal<typeof ProjectApiModule>()),
  projectsApi: { recordOpen: vi.fn(), getOpenReceipt: vi.fn() },
}));

import { projectsApi } from '@web/data/api/projects';
import { ApiException } from '@web/data/api/types';
import { PROJECT_VISIT_ACCOUNT_SOURCE } from '@web/pages/project/project-visit-account';
import type { ProjectVisitHandle } from '@web/pages/project/project-visit';
import { useRecordProjectOpen, type ProjectVisitScope } from '@web/pages/project/use-record-project-open';
import { useCurrentUserStore, type CurrentUser } from '@web/stores/current-user';

const ACCOUNT_A = '00000000-0000-4000-8000-000000000001';
const ACCOUNT_B = '00000000-0000-4000-8000-000000000002';
const PROJECT = '00000000-0000-4000-8000-000000000011';
const CONFIRMED_AT = '2026-11-02T23:59:59.123456Z';

type Input = { enabled: boolean; projectId: string; scope: ProjectVisitScope };
type Harness = RenderHookResult<ProjectVisitHandle, Input> & { initial: Input; client: QueryClient };
type Receipt = { account_id: string; project_id: string; visit_id: string; occurred_at: string };

/** Builds an authenticated account snapshot for the real production store. @throws {never} Never. */
function account(id: string): CurrentUser {
  return { id, email: `${id}@example.com`, name: 'Account', personalStudio: { slug: 'account', name: 'Account', avatarUrl: null }, membershipTier: 'base' };
}

/** Flushes React and transport promise work. @throws {Error} If React work fails. */
async function flush(): Promise<void> { await act(async () => { await Promise.resolve(); }); }

/** Holds one server answer until the owning test releases it. @throws {never} Never. */
function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => { resolve = yes; });
  return { promise, resolve };
}

/** Returns the immutable server result for an original identity. @throws {never} Never. */
function receipt(projectId: string, visitId: string, accountId = ACCOUNT_A): Receipt {
  return { account_id: accountId, project_id: projectId, visit_id: visitId, occurred_at: CONFIRMED_AT };
}

/** Mounts the real entry Hook under StrictMode and its QueryClient. @throws {Error} If rendering fails. */
function setup(input: Partial<Input> = {}): Harness {
  const client = new QueryClient();
  const initial: Input = {
    enabled: true, projectId: PROJECT,
    scope: { accountId: ACCOUNT_A, navigationKey: 'entry-a', accountSource: PROJECT_VISIT_ACCOUNT_SOURCE },
    ...input,
  };
  /** Owns the query cache for one Hook lifetime. @throws {never} Never. */
  function Wrapper({ children }: { children: React.ReactNode }): React.JSX.Element {
    return <React.StrictMode><QueryClientProvider client={client}>{children}</QueryClientProvider></React.StrictMode>;
  }
  const hook = renderHook(({ projectId, enabled, scope }: Input) => useRecordProjectOpen(projectId, enabled, scope), { initialProps: initial, wrapper: Wrapper });
  return { ...hook, initial, client };
}

/** Applies a real auth-store identity transition after any page has left. @throws {Error} If React work fails. */
async function changeAccount(user: CurrentUser | null): Promise<void> {
  await act(async () => { useCurrentUserStore.setState({ user }); });
}

beforeEach(() => {
  vi.clearAllMocks();
  useCurrentUserStore.setState({ user: account(ACCOUNT_A), bootstrapped: true });
  vi.mocked(projectsApi.recordOpen).mockImplementation(async (projectId, visitId) => ({ ok: true, ...receipt(projectId, visitId) }));
  vi.mocked(projectsApi.getOpenReceipt).mockImplementation(async (projectId, visitId) => ({ status: 'unconfirmed', account_id: ACCOUNT_A, project_id: projectId, visit_id: visitId }));
});

afterEach(async () => { await changeAccount(null); });

describe('project visit original admission gate (inner#1893)', () => {
  it.each(['refresh', 'recover'] as const)('keeps an initially unloaded handle.%s behind its first page-entry gate', async (method) => {
    const h = setup({ enabled: false }); await flush();
    const original = h.result.current;
    await act(async () => { await original[method](); });
    expect(projectsApi.recordOpen).not.toHaveBeenCalled();
    expect(projectsApi.getOpenReceipt).not.toHaveBeenCalled();
    expect(original.receipt).toBeNull();
    h.rerender({ ...h.initial, enabled: true }); await flush();
    expect(projectsApi.recordOpen).toHaveBeenCalledTimes(1);
    expect(h.result.current.receipt).toEqual(receipt(PROJECT, h.result.current.visitId!));
  });

  it.each(['refresh', 'recover'] as const)('keeps a demo handle.%s behind the real Project gate', async (method) => {
    const h = setup({ projectId: 'demo' }); await flush();
    await act(async () => { await h.result.current[method](); });
    expect(projectsApi.recordOpen).not.toHaveBeenCalled(); expect(projectsApi.getOpenReceipt).not.toHaveBeenCalled();
    expect(h.result.current.visitId).toBeNull(); expect(h.result.current.receipt).toBeNull();
  });

  it.each(['refresh', 'recover'] as const)('keeps a no-account handle.%s behind authentication', async (method) => {
    const h = setup({ scope: { accountId: null, navigationKey: 'entry-a', accountSource: PROJECT_VISIT_ACCOUNT_SOURCE } }); await flush();
    await act(async () => { await h.result.current[method](); });
    expect(projectsApi.recordOpen).not.toHaveBeenCalled(); expect(projectsApi.getOpenReceipt).not.toHaveBeenCalled();
    expect(h.result.current.visitId).toBeNull(); expect(h.result.current.receipt).toBeNull();
  });
});

describe('project visit auth ownership after page unmount (inner#1893)', () => {
  it.each(['different-account', 'logout-and-same-account'] as const)('permanently retires a departed idle handle after %s', async (scenario) => {
    vi.mocked(projectsApi.recordOpen).mockRejectedValueOnce(new ApiException({ status: 0, message: 'response lost', network: true }));
    const h = setup(); await flush(); const original = h.result.current;
    const generation = PROJECT_VISIT_ACCOUNT_SOURCE.getGeneration?.();
    h.unmount(); await flush();
    if (scenario === 'different-account') await changeAccount(account(ACCOUNT_B));
    else { await changeAccount(null); await changeAccount(account(ACCOUNT_A)); }
    const reads = vi.mocked(projectsApi.getOpenReceipt).mock.calls.length;
    await act(async () => { await original.refresh(); await original.recover(); });
    expect(projectsApi.getOpenReceipt).toHaveBeenCalledTimes(reads);
    expect(projectsApi.recordOpen).toHaveBeenCalledTimes(1);
    expect(original.status).toBe('inactive'); expect(original.receipt).toBeNull();
    expect(PROJECT_VISIT_ACCOUNT_SOURCE.getGeneration?.()).toBe((generation ?? 0) + (scenario === 'different-account' ? 1 : 2));
  });

  it.each(['post', 'lookup'] as const)('aborts an original pending %s after its page is gone and auth changes', async (kind) => {
    const post = deferred<{ ok: true } & Receipt>();
    const lookup = deferred<{ status: 'recorded' } & Receipt>();
    if (kind === 'post') vi.mocked(projectsApi.recordOpen).mockReturnValueOnce(post.promise);
    else {
      vi.mocked(projectsApi.recordOpen).mockRejectedValueOnce(new ApiException({ status: 0, message: 'response lost', network: true }));
      vi.mocked(projectsApi.getOpenReceipt).mockReturnValueOnce(lookup.promise);
    }
    const h = setup(); await flush(); const original = h.result.current; const visitId = original.visitId!;
    const signal = kind === 'post'
      ? vi.mocked(projectsApi.recordOpen).mock.calls[0]?.[2]
      : vi.mocked(projectsApi.getOpenReceipt).mock.calls[0]?.[2];
    expect(signal).toHaveProperty('aborted', false);
    h.unmount(); await flush(); await changeAccount(account(ACCOUNT_B));
    expect(signal).toHaveProperty('aborted', true);
    const reads = vi.mocked(projectsApi.getOpenReceipt).mock.calls.length;
    await act(async () => {
      if (kind === 'post') post.resolve({ ok: true, ...receipt(PROJECT, visitId) });
      else lookup.resolve({ status: 'recorded', ...receipt(PROJECT, visitId) });
      await original.refresh(); await original.recover();
    });
    expect(projectsApi.getOpenReceipt).toHaveBeenCalledTimes(reads); expect(projectsApi.recordOpen).toHaveBeenCalledTimes(1);
    expect(original.status).toBe('inactive'); expect(original.receipt).toEqual(receipt(PROJECT, visitId));
  });

  it('keeps the auth generation and visit stable across same-account payload refresh', async () => {
    const h = setup(); await flush(); const original = h.result.current; const visitId = original.visitId;
    const generation = PROJECT_VISIT_ACCOUNT_SOURCE.getGeneration?.();
    await changeAccount({ ...account(ACCOUNT_A), name: 'Refreshed account', membershipTier: 'pro' });
    expect(PROJECT_VISIT_ACCOUNT_SOURCE.getGeneration?.()).toBe(generation);
    expect(h.result.current.visitId).toBe(visitId); expect(original.status).toBe('recorded');
    expect(projectsApi.recordOpen).toHaveBeenCalledTimes(1);
    h.unmount(); await flush();
    await changeAccount({ ...account(ACCOUNT_A), name: 'Refreshed while away' });
    const reads = vi.mocked(projectsApi.getOpenReceipt).mock.calls.length;
    await act(async () => { await original.refresh(); });
    expect(projectsApi.getOpenReceipt).toHaveBeenCalledTimes(reads + 1);
    expect(PROJECT_VISIT_ACCOUNT_SOURCE.getGeneration?.()).toBe(generation);
    expect(original.status).toBe('inactive'); expect(original.receipt).toEqual(receipt(PROJECT, visitId!));
    expect(projectsApi.recordOpen).toHaveBeenCalledTimes(1);
  });
});
