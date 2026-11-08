// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

import * as React from 'react';
import fc from 'fast-check';
import { act, renderHook, type RenderHookResult } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as ProjectApiModule from '@web/data/api/projects';

vi.mock('@web/data/api/projects', async (importOriginal) => ({
  ...(await importOriginal<typeof ProjectApiModule>()),
  projectsApi: { recordOpen: vi.fn(), getOpenReceipt: vi.fn() },
}));

import { projectsApi, studioProjectsListKey } from '@web/data/api/projects';
import { ApiException } from '@web/data/api/types';
import { useRecordProjectOpen } from '@web/pages/project/use-record-project-open';

type VisitStatus = 'pending' | 'recorded' | 'unconfirmed' | 'rejected' | 'inactive';
type Receipt = { account_id: string; project_id: string; visit_id: string; occurred_at: string };
type VisitScope = { accountId: string | null; navigationKey: string };
type VisitHandle = {
  status: VisitStatus; visitId: string | null; receipt: Receipt | null;
  recover: () => Promise<unknown>; refresh: () => Promise<unknown>;
};
type Input = { projectId: string; enabled: boolean; scope: VisitScope };
type VisitHarness = RenderHookResult<VisitHandle, Input> & { client: QueryClient; initial: Input };

const useVisit: (projectId: string, enabled: boolean, scope: VisitScope) => VisitHandle = useRecordProjectOpen;
const ACCOUNT_A = '00000000-0000-4000-8000-000000000001';
const ACCOUNT_B = '00000000-0000-4000-8000-000000000002';
const PROJECT_A = '00000000-0000-4000-8000-000000000011';
const PROJECT_B = '00000000-0000-4000-8000-000000000012';
const ORIGINAL_TIME = '2026-11-02T23:59:59.123456Z';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
let currentAccount = ACCOUNT_A;

/** Creates the trusted result the current original request belongs to. @throws {never} Never. */
function receipt(projectId: string, visitId: string, accountId = currentAccount): Receipt {
  return { account_id: accountId, project_id: projectId, visit_id: visitId, occurred_at: ORIGINAL_TIME };
}

/** Flushes React work and already-resolved transport promises. @throws {Error} If React work throws. */
async function flush(): Promise<void> { await act(async () => { await Promise.resolve(); }); }

/** Holds one transport answer until its test releases it. @throws {never} Never. */
function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void; reject: (error: unknown) => void } {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

/** Supplies the real QueryClient and StrictMode lifecycle. @throws {Error} If rendering fails. */
function setup(input: Partial<Input> = {}): VisitHarness {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  const initial: Input = { projectId: PROJECT_A, enabled: true, scope: { accountId: ACCOUNT_A, navigationKey: 'entry-a' }, ...input };
  /** Owns a query client throughout one simulated route activation. @throws {never} Never. */
  function Wrapper({ children }: { children: React.ReactNode }): React.JSX.Element {
    return <React.StrictMode><QueryClientProvider client={client}>{children}</QueryClientProvider></React.StrictMode>;
  }
  const hook = renderHook(({ projectId, enabled, scope }: Input) => useVisit(projectId, enabled, scope), { initialProps: initial, wrapper: Wrapper });
  return { ...hook, client, initial };
}

/** Records a network outcome with no authoritative HTTP reply. @throws {never} Never. */
function unknownFailure(): ApiException { return new ApiException({ status: 0, message: 'connection lost', network: true }); }

/** Builds a real rejected result instead of a failed transport. @throws {never} Never. */
function refusal(): ApiException { return new ApiException({ status: 404, message: 'not found', fromServer: true }); }

beforeEach(() => {
  vi.clearAllMocks(); currentAccount = ACCOUNT_A;
  vi.mocked(projectsApi.recordOpen).mockImplementation(async (projectId, visitId) => ({ ok: true, ...receipt(projectId, visitId) }));
  vi.mocked(projectsApi.getOpenReceipt).mockImplementation(async (projectId, visitId) => ({ status: 'unconfirmed', account_id: currentAccount, project_id: projectId, visit_id: visitId }));
});

describe('project visit identity and route lifecycle (inner#1893)', () => {
  it.each(['account', 'project'] as const)('waits until the %s arrives at the accessible page-entry gate', async (late) => {
    const h = setup({ enabled: late !== 'project', scope: { accountId: late === 'account' ? null : ACCOUNT_A, navigationKey: 'entry-a' } }); await flush();
    expect(projectsApi.recordOpen).not.toHaveBeenCalled();
    h.rerender({ ...h.initial, enabled: true, scope: { accountId: ACCOUNT_A, navigationKey: 'entry-a' } }); await flush();
    expect(projectsApi.recordOpen).toHaveBeenCalledTimes(1);
    expect(h.result.current.visitId).toMatch(UUID);
  });

  it.each([{ projectId: PROJECT_A, enabled: false }, { projectId: 'demo', enabled: true }])('keeps the page-entry gate for $projectId / $enabled', async (input) => {
    setup(input); await flush(); expect(projectsApi.recordOpen).not.toHaveBeenCalled();
  });

  it('uses one stable UUID through StrictMode, rerenders and a refetch gate cycle', async () => {
    const h = setup(); await flush(); const id = h.result.current.visitId;
    expect(id).toMatch(UUID); expect(projectsApi.recordOpen).toHaveBeenCalledTimes(1);
    h.rerender({ ...h.initial, scope: { ...h.initial.scope } }); await flush();
    h.rerender({ ...h.initial, enabled: false }); await flush();
    h.rerender(h.initial); await flush();
    expect(h.result.current.visitId).toBe(id); expect(h.result.current.status).toBe('recorded');
    expect(projectsApi.recordOpen).toHaveBeenCalledTimes(1);
    expect(projectsApi.recordOpen).toHaveBeenCalledWith(PROJECT_A, id, expect.any(AbortSignal));
  });

  it('creates new identities for A to B to A even when Back reuses the first navigation key', async () => {
    const h = setup(); await flush(); const a = h.result.current.visitId;
    h.rerender({ ...h.initial, projectId: PROJECT_B, scope: { ...h.initial.scope, navigationKey: 'entry-b' } }); await flush();
    const b = h.result.current.visitId;
    h.rerender(h.initial); await flush(); const back = h.result.current.visitId;
    expect(new Set([a, b, back]).size).toBe(3); expect(projectsApi.recordOpen).toHaveBeenCalledTimes(3);
    expect(projectsApi.recordOpen).toHaveBeenLastCalledWith(PROJECT_A, back, expect.any(AbortSignal));
  });

  it('creates a fresh identity for a new activation of the same URL', async () => {
    const h = setup(); await flush(); const first = h.result.current.visitId;
    h.rerender({ ...h.initial, scope: { ...h.initial.scope, navigationKey: 'same-url-new-entry' } }); await flush();
    expect(h.result.current.visitId).not.toBe(first); expect(projectsApi.recordOpen).toHaveBeenCalledTimes(2);
  });

  it('treats a persisted pageshow as a real new browser entry', async () => {
    const h = setup(); await flush(); const first = h.result.current.visitId;
    await act(async () => { window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true })); }); await flush();
    expect(h.result.current.visitId).not.toBe(first); expect(projectsApi.recordOpen).toHaveBeenCalledTimes(2);
    await act(async () => { window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: false })); }); await flush();
    expect(projectsApi.recordOpen).toHaveBeenCalledTimes(2);
  });

  it('keeps the same visit through a same-account credential or provider refresh', async () => {
    const h = setup(); await flush(); const id = h.result.current.visitId;
    h.rerender({ ...h.initial, scope: { accountId: ACCOUNT_A, navigationKey: 'entry-a' } }); await flush();
    await act(async () => { await h.result.current.refresh(); });
    expect(h.result.current.visitId).toBe(id); expect(projectsApi.recordOpen).toHaveBeenCalledTimes(1);
    expect(h.result.current.receipt?.occurred_at).toBe(ORIGINAL_TIME);
  });

  it('refreshes only the recent feed and studio lists after the first valid confirmation', async () => {
    const h = setup({ enabled: false });
    const listKey = studioProjectsListKey('acme', { archived: false, sort: 'opened', locale: 'en' });
    h.client.setQueryData(listKey, { pages: [], pageParams: [] });
    h.client.setQueryData(['project', PROJECT_A], { id: PROJECT_A });
    h.rerender(h.initial.enabled ? h.initial : { ...h.initial, enabled: true }); await flush();
    expect(h.client.getQueryState(listKey)?.isInvalidated).toBe(true);
    expect(h.client.getQueryState(['project', PROJECT_A])?.isInvalidated).toBe(false);
    expect(h.result.current.status).toBe('recorded');
  });

  it('uses a new UUID for each actual activation in arbitrary navigation sequences', async () => {
    await fc.assert(fc.asyncProperty(fc.array(fc.integer({ min: 0, max: 3 }), { minLength: 2, maxLength: 12 }), async (steps) => {
      vi.mocked(projectsApi.recordOpen).mockClear(); const h = setup(); await flush();
      const ids = [h.result.current.visitId]; let previous = 'entry-a'; let count = 1;
      try {
        for (const step of steps) {
          const next = `entry-${step}`;
          h.rerender({ ...h.initial, scope: { ...h.initial.scope, navigationKey: next } }); await flush();
          if (next !== previous) { count += 1; ids.push(h.result.current.visitId); }
          expect(h.result.current.visitId).toBe(ids.at(-1)); previous = next;
        }
        expect(projectsApi.recordOpen).toHaveBeenCalledTimes(count);
        expect(new Set(ids).size).toBe(count);
      } finally { h.unmount(); h.client.clear(); }
    }), { numRuns: 30 });
  });
});

describe('project visit receipts and recovery (inner#1893)', () => {
  it.each([null, {}, { ok: true }, { data: { ok: true } }])('keeps malformed receipt %j unconfirmed', async (raw) => {
    vi.mocked(projectsApi.recordOpen).mockResolvedValueOnce(raw as never);
    const h = setup(); await flush();
    expect(h.result.current.status).toBe('unconfirmed'); expect(h.result.current.receipt).toBeNull();
    expect(projectsApi.recordOpen).toHaveBeenCalledTimes(1);
  });
  it.each([
    ['account_id', ACCOUNT_B], ['project_id', PROJECT_B], ['visit_id', '00000000-0000-4000-8000-000000000999'],
    ['occurred_at', 'not-an-instant'], ['occurred_at', '2026-02-30T10:00:00Z'],
  ])('rejects a receipt with an invalid original %s', async (field, value) => {
    vi.mocked(projectsApi.recordOpen).mockImplementationOnce(async (projectId, visitId) => ({ ok: true, ...receipt(projectId, visitId), [field]: value }));
    const h = setup(); await flush();
    expect(h.result.current.status).toBe('unconfirmed'); expect(h.result.current.receipt).toBeNull();
    expect(projectsApi.getOpenReceipt).toHaveBeenCalledWith(PROJECT_A, h.result.current.visitId, expect.any(AbortSignal));
    expect(projectsApi.recordOpen).toHaveBeenCalledTimes(1);
  });

  it('retains an unknown visit and reads its original receipt after a lost response', async () => {
    vi.mocked(projectsApi.recordOpen).mockRejectedValueOnce(unknownFailure());
    vi.mocked(projectsApi.getOpenReceipt).mockImplementation(async (projectId, visitId) => ({ status: 'recorded', ...receipt(projectId, visitId) }));
    const h = setup(); await flush();
    expect(h.result.current.status).toBe('recorded'); expect(h.result.current.receipt).toEqual(receipt(PROJECT_A, h.result.current.visitId!));
    expect(projectsApi.recordOpen).toHaveBeenCalledTimes(1); expect(projectsApi.getOpenReceipt).toHaveBeenCalledTimes(1);
  });

  it('keeps an unconfirmed result across a midnight lookup without resubmitting', async () => {
    vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date('2026-11-02T23:59:59Z'));
    vi.mocked(projectsApi.recordOpen).mockRejectedValueOnce(unknownFailure());
    const h = setup(); await flush(); const id = h.result.current.visitId;
    vi.setSystemTime(new Date('2026-11-03T00:05:00Z'));
    await act(async () => { await h.result.current.refresh(); });
    expect(h.result.current.status).toBe('unconfirmed'); expect(h.result.current.visitId).toBe(id);
    expect(projectsApi.recordOpen).toHaveBeenCalledTimes(1); expect(projectsApi.getOpenReceipt).toHaveBeenLastCalledWith(PROJECT_A, id, expect.any(AbortSignal));
  });

  it.each(['account_id', 'project_id', 'visit_id', 'occurred_at'] as const)('validates the original %s on a lookup result too', async (field) => {
    vi.mocked(projectsApi.recordOpen).mockRejectedValueOnce(unknownFailure());
    vi.mocked(projectsApi.getOpenReceipt).mockImplementation(async (projectId, visitId) => ({ status: 'recorded', ...receipt(projectId, visitId), [field]: field === 'occurred_at' ? 'invalid' : '00000000-0000-4000-8000-000000000999' }));
    const h = setup(); await flush();
    expect(h.result.current.status).toBe('unconfirmed'); expect(h.result.current.receipt).toBeNull();
    expect(projectsApi.recordOpen).toHaveBeenCalledTimes(1);
  });

  it('accepts a matching late POST after a lookup found no confirmed result', async () => {
    const pending = deferred<{ ok: true } & Receipt>(); vi.mocked(projectsApi.recordOpen).mockReturnValueOnce(pending.promise);
    const h = setup(); await flush(); const id = h.result.current.visitId!;
    await act(async () => { await h.result.current.refresh(); }); expect(h.result.current.status).toBe('unconfirmed');
    await act(async () => { pending.resolve({ ok: true, ...receipt(PROJECT_A, id) }); });
    expect(h.result.current.status).toBe('recorded'); expect(h.result.current.receipt?.occurred_at).toBe(ORIGINAL_TIME);
    expect(projectsApi.recordOpen).toHaveBeenCalledTimes(1);
  });

  it('distinguishes an explicit refusal from a lost transport response', async () => {
    vi.mocked(projectsApi.recordOpen).mockRejectedValueOnce(refusal()); const h = setup(); await flush();
    expect(h.result.current.status).toBe('rejected'); expect(h.result.current.receipt).toBeNull();
    expect(projectsApi.recordOpen).toHaveBeenCalledTimes(1);
  });

  it('recovers only after checking the original result and reuses its visit identity', async () => {
    vi.mocked(projectsApi.recordOpen).mockRejectedValueOnce(unknownFailure()); const h = setup(); await flush();
    const id = h.result.current.visitId;
    await act(async () => { await h.result.current.recover(); });
    expect(projectsApi.recordOpen).toHaveBeenCalledTimes(2); expect(projectsApi.recordOpen).toHaveBeenLastCalledWith(PROJECT_A, id, expect.any(AbortSignal));
    expect(vi.mocked(projectsApi.getOpenReceipt).mock.invocationCallOrder.at(-1) ?? Infinity).toBeLessThan(vi.mocked(projectsApi.recordOpen).mock.invocationCallOrder.at(-1) ?? -Infinity);
    expect(h.result.current.status).toBe('recorded'); expect(h.result.current.receipt?.occurred_at).toBe(ORIGINAL_TIME);
  });

  it('uses a found original result during explicit recovery without another write', async () => {
    vi.mocked(projectsApi.recordOpen).mockRejectedValueOnce(unknownFailure()); const h = setup(); await flush();
    vi.mocked(projectsApi.getOpenReceipt).mockImplementation(async (projectId, visitId) => ({ status: 'recorded', ...receipt(projectId, visitId) }));
    await act(async () => { await h.result.current.recover(); });
    expect(h.result.current.status).toBe('recorded'); expect(projectsApi.recordOpen).toHaveBeenCalledTimes(1);
  });

  it('keeps confirmed results when a later lookup fails or contradicts them', async () => {
    const h = setup(); await flush(); const original = h.result.current.receipt;
    vi.mocked(projectsApi.getOpenReceipt).mockRejectedValueOnce(unknownFailure());
    await act(async () => { await h.result.current.refresh(); });
    expect(h.result.current.status).toBe('recorded'); expect(h.result.current.receipt).toEqual(original);
    await act(async () => { await h.result.current.refresh(); });
    expect(h.result.current.status).toBe('recorded'); expect(h.result.current.receipt).toEqual(original);
    await act(async () => { await h.result.current.recover(); }); expect(projectsApi.recordOpen).toHaveBeenCalledTimes(1);
  });

  it('keeps a departed entry query-only while its original account is valid', async () => {
    vi.mocked(projectsApi.recordOpen).mockRejectedValueOnce(unknownFailure()); const h = setup(); await flush();
    const original = h.result.current; const id = original.visitId; h.unmount();
    await act(async () => { await original.recover(); });
    expect(projectsApi.recordOpen).toHaveBeenCalledTimes(1); expect(projectsApi.getOpenReceipt).toHaveBeenLastCalledWith(PROJECT_A, id, expect.any(AbortSignal));
    expect(original.status).toBe('inactive');
  });

  it('archives a matching late POST on its departed original entry', async () => {
    const pending = deferred<{ ok: true } & Receipt>(); vi.mocked(projectsApi.recordOpen).mockReturnValueOnce(pending.promise);
    const h = setup(); await flush(); const original = h.result.current; const id = original.visitId!;
    h.unmount(); await flush();
    await act(async () => { pending.resolve({ ok: true, ...receipt(PROJECT_A, id) }); });
    expect(original.status).toBe('inactive'); expect(original.receipt).toEqual(receipt(PROJECT_A, id));
    expect(projectsApi.recordOpen).toHaveBeenCalledTimes(1);
  });

  it('stops and cancels the original account requests when the account changes', async () => {
    const pending = deferred<{ ok: true } & Receipt>(); vi.mocked(projectsApi.recordOpen).mockReturnValueOnce(pending.promise);
    const h = setup(); await flush(); const a = h.result.current; const aId = a.visitId!;
    const signal = vi.mocked(projectsApi.recordOpen).mock.calls[0]?.[2];
    currentAccount = ACCOUNT_B; h.rerender({ ...h.initial, scope: { accountId: ACCOUNT_B, navigationKey: 'entry-a' } }); await flush();
    const bId = h.result.current.visitId; expect(bId).not.toBe(aId); expect(signal).toHaveProperty('aborted', true);
    expect(h.result.current.receipt?.account_id).toBe(ACCOUNT_B);
    const reads = vi.mocked(projectsApi.getOpenReceipt).mock.calls.length;
    await act(async () => { await a.refresh(); await a.recover(); pending.resolve({ ok: true, ...receipt(PROJECT_A, aId, ACCOUNT_A) }); });
    expect(projectsApi.getOpenReceipt).toHaveBeenCalledTimes(reads); expect(projectsApi.recordOpen).toHaveBeenCalledTimes(2);
    expect(h.result.current.visitId).toBe(bId); expect(h.result.current.receipt?.account_id).toBe(ACCOUNT_B);
  });

  it('stops old queries after logout and creates a fresh identity when the same account returns', async () => {
    vi.mocked(projectsApi.recordOpen).mockRejectedValueOnce(unknownFailure()); const h = setup(); await flush();
    const original = h.result.current; const oldId = original.visitId;
    h.rerender({ ...h.initial, scope: { accountId: null, navigationKey: 'entry-a' } }); await flush();
    const reads = vi.mocked(projectsApi.getOpenReceipt).mock.calls.length;
    await act(async () => { await original.refresh(); await original.recover(); });
    expect(projectsApi.getOpenReceipt).toHaveBeenCalledTimes(reads); expect(projectsApi.recordOpen).toHaveBeenCalledTimes(1);
    h.rerender(h.initial); await flush(); expect(h.result.current.visitId).not.toBe(oldId); expect(projectsApi.recordOpen).toHaveBeenCalledTimes(2);
  });

  it('cancels an in-flight original lookup when its account changes', async () => {
    const pending = deferred<{ status: 'recorded' } & Receipt>();
    vi.mocked(projectsApi.recordOpen).mockRejectedValueOnce(unknownFailure());
    vi.mocked(projectsApi.getOpenReceipt).mockReturnValueOnce(pending.promise);
    const h = setup(); await flush(); const old = h.result.current; const id = old.visitId!;
    const signal = vi.mocked(projectsApi.getOpenReceipt).mock.calls[0]?.[2];
    currentAccount = ACCOUNT_B; h.rerender({ ...h.initial, scope: { accountId: ACCOUNT_B, navigationKey: 'entry-a' } }); await flush();
    const bId = h.result.current.visitId; expect(signal).toHaveProperty('aborted', true);
    await act(async () => { pending.resolve({ status: 'recorded', ...receipt(PROJECT_A, id, ACCOUNT_A) }); });
    expect(h.result.current.visitId).toBe(bId); expect(h.result.current.receipt?.account_id).toBe(ACCOUNT_B);
    expect(projectsApi.recordOpen).toHaveBeenCalledTimes(2);
  });
});

type MatrixEvent = 'first-send' | 'found' | 'not-found' | 'transport-failed' | 'refused' | 'passive-refresh' | 'recover' | 'leave' | 'new-entry';
const STATES: VisitStatus[] = ['pending', 'recorded', 'unconfirmed', 'rejected', 'inactive'];
const EVENTS: MatrixEvent[] = ['first-send', 'found', 'not-found', 'transport-failed', 'refused', 'passive-refresh', 'recover', 'leave', 'new-entry'];

/** Reaches a public lifecycle state using the actual Hook and transport outcomes. @throws {Error} If React work fails. */
async function atState(state: VisitStatus): Promise<{ h: VisitHarness; handle: VisitHandle }> {
  if (state === 'pending') vi.mocked(projectsApi.recordOpen).mockReturnValueOnce(deferred<{ ok: true } & Receipt>().promise);
  if (state === 'unconfirmed' || state === 'inactive') vi.mocked(projectsApi.recordOpen).mockRejectedValueOnce(unknownFailure());
  if (state === 'rejected') vi.mocked(projectsApi.recordOpen).mockRejectedValueOnce(refusal());
  const h = setup(); await flush(); const handle = h.result.current;
  if (state === 'inactive') { h.unmount(); await flush(); }
  return { h, handle };
}

describe('project visit state and event matrix (inner#1893)', () => {
  it.each(STATES.flatMap((state) => EVENTS.map((event) => ({ state, event }))))('$state with $event preserves its original identity and contract', async ({ state, event }) => {
    const { h, handle } = await atState(state);
    expect(handle.status).toBe(state); const id = handle.visitId!;
    const writes = vi.mocked(projectsApi.recordOpen).mock.calls.length;
    const initialReceipt = handle.receipt;
    let expected: VisitStatus = state;

    if (event === 'first-send') {
      // A completed first-send process cannot be started by a passive rerender;
      // an inactive controller has no mounted first-send source.
      if (state !== 'inactive') { h.rerender({ ...h.initial, scope: { ...h.initial.scope } }); await flush(); }
    } else if (event === 'found') {
      vi.mocked(projectsApi.getOpenReceipt).mockResolvedValueOnce({ status: 'recorded', ...receipt(PROJECT_A, id) });
      await act(async () => { await handle.refresh(); }); expected = state === 'inactive' ? 'inactive' : 'recorded';
      expect(handle.receipt).toEqual(receipt(PROJECT_A, id));
    } else if (event === 'not-found') {
      await act(async () => { await handle.refresh(); }); expected = state === 'pending' ? 'unconfirmed' : state;
    } else if (event === 'transport-failed') {
      vi.mocked(projectsApi.getOpenReceipt).mockRejectedValueOnce(unknownFailure());
      await act(async () => { await handle.refresh(); }); expected = state === 'pending' ? 'unconfirmed' : state;
    } else if (event === 'refused') {
      vi.mocked(projectsApi.getOpenReceipt).mockRejectedValueOnce(refusal());
      await act(async () => { await handle.refresh(); }); expected = state === 'pending' || state === 'unconfirmed' ? 'rejected' : state;
    } else if (event === 'passive-refresh') {
      const lookup = deferred<{ status: 'unconfirmed'; account_id: string; project_id: string; visit_id: string }>();
      vi.mocked(projectsApi.getOpenReceipt).mockReturnValueOnce(lookup.promise);
      let refreshing: Promise<unknown> | undefined;
      await act(async () => { refreshing = handle.refresh(); });
      expect(handle.status).toBe(state); expect(projectsApi.recordOpen).toHaveBeenCalledTimes(writes);
      await act(async () => { lookup.resolve({ status: 'unconfirmed', account_id: ACCOUNT_A, project_id: PROJECT_A, visit_id: id }); await refreshing; });
      expected = state === 'pending' ? 'unconfirmed' : state;
    } else if (event === 'recover') {
      await act(async () => { await handle.recover(); }); expected = state === 'inactive' ? 'inactive' : 'recorded';
      expect(projectsApi.recordOpen).toHaveBeenCalledTimes(writes + (state === 'recorded' || state === 'inactive' ? 0 : 1));
    } else if (event === 'leave') {
      if (state !== 'inactive') { h.unmount(); await flush(); }
      expected = 'inactive';
    } else {
      let next: ReturnType<typeof setup>;
      if (state === 'inactive') next = setup({ scope: { accountId: ACCOUNT_A, navigationKey: 'entry-after-leave' } });
      else {
        h.rerender({ ...h.initial, scope: { accountId: ACCOUNT_A, navigationKey: 'entry-after-leave' } });
        next = h;
      }
      await flush(); expect(next.result.current.visitId).not.toBe(id); expect(next.result.current.status).toBe('recorded');
      expect(projectsApi.recordOpen).toHaveBeenCalledTimes(writes + 1); expected = 'inactive';
    }

    expect(handle.status).toBe(expected); expect(handle.visitId).toBe(id);
    if (state === 'recorded') expect(handle.receipt).toEqual(initialReceipt);
    if (event !== 'recover' && event !== 'new-entry') expect(projectsApi.recordOpen).toHaveBeenCalledTimes(writes);
  });
});
