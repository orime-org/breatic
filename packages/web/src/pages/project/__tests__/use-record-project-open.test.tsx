// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as React from 'react';
import { render, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type * as ProjectApiModule from '@web/data/api/projects';

vi.mock('@web/data/api/projects', async (importOriginal) => ({
  ...(await importOriginal<typeof ProjectApiModule>()),
  projectsApi: { recordOpen: vi.fn(), getOpenReceipt: vi.fn() },
}));
import { projectsApi, studioProjectsListKey } from '@web/data/api/projects';
import { useRecordProjectOpen } from '@web/pages/project/use-record-project-open';

const ACCOUNT_ID = '00000000-0000-4000-8000-000000000001';
const scope = { accountId: ACCOUNT_ID, navigationKey: 'entry-a' };

function Harness({
  projectId,
  enabled,
}: {
  projectId: string;
  enabled: boolean;
}): null {
  useRecordProjectOpen(projectId, enabled, scope);
  return null;
}

function setup(
  projectId: string,
  enabled: boolean,
  client = new QueryClient(),
) {
  // StrictMode double-invokes the effect (mount → cleanup → remount); the
  // record must still fire exactly once. Unlike a react-query query (which the
  // cache dedupes), this is a direct POST guarded only by the hook's own ref.
  render(
    <React.StrictMode>
      <QueryClientProvider client={client}>
        <Harness projectId={projectId} enabled={enabled} />
      </QueryClientProvider>
    </React.StrictMode>,
  );
  return client;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(projectsApi.recordOpen).mockImplementation(async (projectId, visitId) => ({
    ok: true, account_id: ACCOUNT_ID, project_id: projectId, visit_id: visitId, occurred_at: '2026-11-02T10:00:00.000Z',
  }));
  vi.mocked(projectsApi.getOpenReceipt).mockImplementation(async (projectId, visitId) => ({
    status: 'unconfirmed', account_id: ACCOUNT_ID, project_id: projectId, visit_id: visitId,
  }));
});

describe('useRecordProjectOpen (critical path: StrictMode-safe one-shot)', () => {
  it('fires recordOpen EXACTLY ONCE under StrictMode double-invoke', async () => {
    setup('00000000-0000-4000-8000-000000000011', true);
    await waitFor(() =>
      expect(projectsApi.recordOpen).toHaveBeenCalledTimes(1),
    );
    expect(projectsApi.recordOpen).toHaveBeenCalledWith('00000000-0000-4000-8000-000000000011', expect.any(String), expect.any(AbortSignal));
  });

  it('does not record while disabled (project not loaded yet)', () => {
    setup('00000000-0000-4000-8000-000000000011', false);
    expect(projectsApi.recordOpen).not.toHaveBeenCalled();
  });

  it('does not record for the demo placeholder route', () => {
    setup('demo', true);
    expect(projectsApi.recordOpen).not.toHaveBeenCalled();
  });

  it('invalidates the recent feed query after a successful record', async () => {
    const client = new QueryClient();
    const invalidateSpy = vi.spyOn(client, 'invalidateQueries');
    setup('00000000-0000-4000-8000-000000000012', true, client);
    await waitFor(() =>
      expect(invalidateSpy).toHaveBeenCalledWith({
        queryKey: ['studios', 'recent'],
      }),
    );
  });

  it('refreshes every studio projects list after a successful record, so last-opened order is current', async () => {
    const client = new QueryClient();
    client.setQueryData(studioProjectsListKey('acme', { archived: false, sort: 'opened', locale: 'en' }), {
      pages: [],
      pageParams: [],
    });
    client.setQueryData(['project', '00000000-0000-4000-8000-000000000014'], { id: '00000000-0000-4000-8000-000000000014' });
    setup('00000000-0000-4000-8000-000000000014', true, client);

    await waitFor(() =>
      expect(
        client.getQueryState(studioProjectsListKey('acme', { archived: false, sort: 'opened', locale: 'en' }))
          ?.isInvalidated,
      ).toBe(true),
    );
    expect(client.getQueryState(['project', '00000000-0000-4000-8000-000000000014'])?.isInvalidated).toBe(false);
  });

  it('swallows a failed record (best-effort, render never throws)', async () => {
    vi.mocked(projectsApi.recordOpen).mockRejectedValue(new Error('nope'));
    setup('00000000-0000-4000-8000-000000000013', true);
    await waitFor(() =>
      expect(projectsApi.recordOpen).toHaveBeenCalledTimes(1),
    );
    // No assertion on a thrown error: the test reaching here is the proof that
    // the rejected POST was swallowed and never bubbled out of the effect.
  });
});
