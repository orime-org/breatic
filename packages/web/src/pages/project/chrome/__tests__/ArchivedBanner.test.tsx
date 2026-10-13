// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import * as React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider, useQuery } from '@tanstack/react-query';

vi.mock('@web/data/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@web/data/api')>()),
  projectsApi: {
    duplicate: vi.fn(),
    archive: vi.fn(),
    restore: vi.fn(),
  },
}));
vi.mock('@web/lib/toast', () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

import { projectsApi } from '@web/data/api';
import { ArchivedBanner } from '@web/pages/project/chrome/ArchivedBanner';

function renderBanner() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <ArchivedBanner projectId='p1' canRestore />
    </QueryClientProvider>,
  );
  return screen.getByRole('button', { name: 'Restore' });
}

function deferred(): { promise: Promise<never>; resolve: () => void; reject: () => void } {
  let resolve!: () => void;
  let reject!: () => void;
  const promise = new Promise<never>((res, rej) => {
    resolve = () => res(undefined as never);
    reject = () => rej(new Error('refused'));
  });
  return { promise, resolve, reject };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('ArchivedBanner restore button', () => {
  it('reads busy while the restore is in flight and settles after it succeeds', async () => {
    const reply = deferred();
    vi.mocked(projectsApi.restore).mockReturnValue(reply.promise);
    const button = renderBanner();

    fireEvent.click(button);

    await waitFor(() => expect(button).toHaveAttribute('aria-busy', 'true'));
    expect(button).toHaveAttribute('aria-disabled', 'true');
    reply.resolve();
    await waitFor(() => expect(button).not.toHaveAttribute('aria-busy'));
  });

  it('keeps reading busy until the project refetch that takes the banner away lands', async () => {
    vi.mocked(projectsApi.restore).mockResolvedValue(undefined as never);
    let landRefetch: (() => void) | null = null;
    const fetchProject = vi.fn(
      (): Promise<{ archived: boolean }> =>
        fetchProject.mock.calls.length === 1
          ? Promise.resolve({ archived: true })
          : new Promise((resolve) => {
            landRefetch = () => resolve({ archived: false });
          }),
    );
    /**
     * Stands in for the project page: it reads the project and shows the
     * banner only while the project is archived.
     * @returns The banner while archived, nothing after.
     */
    function Page(): React.JSX.Element | null {
      const project = useQuery({ queryKey: ['project', 'p1'], queryFn: fetchProject });
      return project.data?.archived ? <ArchivedBanner projectId='p1' canRestore /> : null;
    }
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={client}>
        <Page />
      </QueryClientProvider>,
    );
    const button = await screen.findByRole('button', { name: 'Restore' });

    fireEvent.click(button);

    await waitFor(() => expect(landRefetch).not.toBeNull());
    expect(button).toHaveAttribute('aria-busy', 'true');
    landRefetch!();
    await waitFor(() => expect(screen.queryByTestId('archived-banner')).toBeNull());
  });

  it('stops reading busy after the restore fails', async () => {
    const reply = deferred();
    vi.mocked(projectsApi.restore).mockReturnValue(reply.promise);
    const button = renderBanner();

    fireEvent.click(button);

    await waitFor(() => expect(button).toHaveAttribute('aria-busy', 'true'));
    reply.reject();
    await waitFor(() => expect(button).not.toHaveAttribute('aria-busy'));
  });
});
