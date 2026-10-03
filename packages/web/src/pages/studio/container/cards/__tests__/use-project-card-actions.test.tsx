// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import * as React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

vi.mock('@web/data/api/projects', () => ({
  projectsApi: {
    duplicate: vi.fn(),
    archive: vi.fn(),
    restore: vi.fn(),
  },
}));
vi.mock('@web/lib/toast', () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

import { projectsApi } from '@web/data/api/projects';
import { toast } from '@web/lib/toast';
import { ApiException } from '@web/data/api/types';
import { useProjectCardActions } from '@web/pages/studio/container/cards/use-project-card-actions';

const LISTS = [
  ['studio', 'acme', 'projects'],
  ['studio', 'acme', 'projects', 'archived'],
  ['studios', 'recent'],
  ['project', 'p1'],
] as const;

function setup() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  for (const key of LISTS) client.setQueryData([...key], []);
  const { result } = renderHook(() => useProjectCardActions('p1', 'acme'), {
    wrapper: ({ children }: { children: React.ReactNode }) => (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    ),
  });
  return { client, result };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('useProjectCardActions', () => {
  for (const action of ['duplicate', 'archive', 'restore'] as const) {
    it(`${action} refreshes both studio lists, the Recent landing and the project`, async () => {
      vi.mocked(projectsApi[action]).mockResolvedValue({ name: 'Copy' } as never);
      const { client, result } = setup();

      act(() => result.current[action]());

      await waitFor(() => expect(toast.success).toHaveBeenCalled());
      for (const key of LISTS) {
        expect(client.getQueryState([...key])?.isInvalidated).toBe(true);
      }
    });
  }

  it('names the copy in the duplicate toast', async () => {
    vi.mocked(projectsApi.duplicate).mockResolvedValue({ name: 'Alley (copy)' } as never);
    const { result } = setup();

    act(() => result.current.duplicate());

    await waitFor(() =>
      expect(toast.success).toHaveBeenCalledWith('Duplicated as “Alley (copy)”'),
    );
  });

  it('toasts the server reason when restore is refused, and refreshes nothing', async () => {
    vi.mocked(projectsApi.restore).mockRejectedValue(
      new ApiException({ status: 409, message: 'This studio is full.', fromServer: true }),
    );
    const { client, result } = setup();

    act(() => result.current.restore());

    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith('Couldn\'t restore', {
        description: 'This studio is full.',
      }),
    );
    expect(client.getQueryState(['studio', 'acme', 'projects'])?.isInvalidated).toBe(false);
  });
});
