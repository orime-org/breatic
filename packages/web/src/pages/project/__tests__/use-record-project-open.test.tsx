// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as React from 'react';
import { render, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

vi.mock('@web/data/api/projects', () => ({
  projectsApi: { recordOpen: vi.fn() },
}));
import { projectsApi } from '@web/data/api/projects';
import { useRecordProjectOpen } from '@web/pages/project/use-record-project-open';

function Harness({
  projectId,
  enabled,
}: {
  projectId: string;
  enabled: boolean;
}): null {
  useRecordProjectOpen(projectId, enabled);
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
});

describe('useRecordProjectOpen (critical path: StrictMode-safe one-shot)', () => {
  it('fires recordOpen EXACTLY ONCE under StrictMode double-invoke', async () => {
    vi.mocked(projectsApi.recordOpen).mockResolvedValue({ ok: true });
    setup('proj-1', true);
    await waitFor(() =>
      expect(projectsApi.recordOpen).toHaveBeenCalledTimes(1),
    );
    expect(projectsApi.recordOpen).toHaveBeenCalledWith('proj-1');
  });

  it('does not record while disabled (project not loaded yet)', () => {
    setup('proj-1', false);
    expect(projectsApi.recordOpen).not.toHaveBeenCalled();
  });

  it('does not record for the demo placeholder route', () => {
    setup('demo', true);
    expect(projectsApi.recordOpen).not.toHaveBeenCalled();
  });

  it('invalidates the recent feed query after a successful record', async () => {
    vi.mocked(projectsApi.recordOpen).mockResolvedValue({ ok: true });
    const client = new QueryClient();
    const invalidateSpy = vi.spyOn(client, 'invalidateQueries');
    setup('proj-2', true, client);
    await waitFor(() =>
      expect(invalidateSpy).toHaveBeenCalledWith({
        queryKey: ['studios', 'recent'],
      }),
    );
  });

  it('swallows a failed record (best-effort, render never throws)', async () => {
    vi.mocked(projectsApi.recordOpen).mockRejectedValue(new Error('nope'));
    setup('proj-3', true);
    await waitFor(() =>
      expect(projectsApi.recordOpen).toHaveBeenCalledTimes(1),
    );
    // No assertion on a thrown error: the test reaching here is the proof that
    // the rejected POST was swallowed and never bubbled out of the effect.
  });
});
