// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * The Studio page in a build with regions (inner#1955) remembers the Studio's
 * region under its slug and, once the Studio has loaded, under its id, so
 * requests that name either reach the Studio's region.
 */

import { describe, it, expect, vi } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { StudioDetail } from '@breatic/shared';

vi.mock('@web/data/api/regions', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@web/data/api/regions')>()),
  rememberStudioRegion: vi.fn(),
  getRegionConfig: () => ({ global: 'us-west', regions: {} }),
}));
const directory = vi.hoisted(() => ({ studio: vi.fn(async (_slug: string) => ({ region: 'sg' as string | null })) }));
vi.mock('@web/data/api/directory', () => ({ directoryApi: directory }));
vi.mock('@web/data/api/studios', () => ({
  studiosApi: {
    get: vi.fn(),
    listUserStudios: vi.fn(async () => []),
    listProjects: vi.fn(async () => ({ items: [], nextCursor: null, total: 0 })),
  },
}));
vi.mock('@web/data/api/credits', () => ({
  fetchStudioCredits: vi.fn(async () => ({ spendable: '0.000000', lots: [], ledger: { items: [], nextCursor: null } })),
}));

import StudioContainerPage from '@web/pages/studio/container/StudioContainerPage';
import { renderWithTooltips as render } from '@web/test-utils/render-with-tooltips';
import { rememberStudioRegion } from '@web/data/api/regions';
import { studiosApi } from '@web/data/api/studios';
import { ApiException } from '@web/data/api/types';

/**
 * Render the Studio page for a slug.
 * @param client - The query client, possibly holding an earlier answer.
 * @returns The rendered page.
 */
function renderPage(client: QueryClient): ReturnType<typeof render> {
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={['/studio/far-studio']}>
        <Routes>
          <Route path='/studio/:slug' element={<StudioContainerPage />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

const STUDIO: StudioDetail = {
  id: 's-far',
  slug: 'far-studio',
  name: 'Far Studio',
  type: 'team',
  memberCount: 2,
  avatarUrl: null,
  bio: null,
  myStudioRole: 'admin',
  region: 'sg',
};

describe('StudioContainerPage in a build with regions', () => {
  it('remembers the Studio region under its slug and its id', async () => {
    vi.mocked(studiosApi.get).mockResolvedValue(STUDIO);
    renderPage(new QueryClient({ defaultOptions: { queries: { retry: false } } }));

    expect(await screen.findByText('Far Studio')).toBeInTheDocument();
    expect(rememberStudioRegion).toHaveBeenCalledWith(['far-studio'], 'sg');
    await waitFor(() => expect(rememberStudioRegion).toHaveBeenCalledWith(['far-studio', 's-far'], 'sg'));
  });

  // inner#1955: the slug moved to a Studio in another region since this tab
  // last looked it up, so every cache here still names the old region.
  it('asks the directory again when the cached region does not have the Studio, and reads it there', async () => {
    vi.mocked(rememberStudioRegion).mockClear();
    vi.mocked(studiosApi.get).mockReset();
    vi.mocked(studiosApi.get)
      .mockRejectedValueOnce(new ApiException({ status: 404, message: 'missing' }))
      .mockResolvedValueOnce({ ...STUDIO, id: 's-near', region: null });
    directory.studio.mockClear();
    // directoryApi.studio records the slug's region before it answers.
    directory.studio.mockImplementationOnce(async (slug: string) => {
      rememberStudioRegion([slug], 'us-west');
      return { region: 'us-west' };
    });
    // The app's own freshness window (QueryClientProvider), so the cached answer is used as it would be.
    const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: 30_000 } } });
    client.setQueryData(['studio-region', 'far-studio'], { region: 'sg' });
    client.setQueryData(['studios', 'user'], [
      { ...STUDIO, id: 's-far', slug: 'far-studio', region: 'sg' },
      { ...STUDIO, id: 's-other', slug: 'other-studio', region: 'sg' },
    ]);

    renderPage(client);

    expect(await screen.findByText('Far Studio')).toBeInTheDocument();
    expect(directory.studio).toHaveBeenCalledTimes(1);
    expect(studiosApi.get).toHaveBeenCalledTimes(2);
    // The re-read goes where the region memory now points.
    const remembered = vi.mocked(rememberStudioRegion).mock.calls.findIndex((call) => call[1] === 'us-west');
    expect(remembered).toBeGreaterThanOrEqual(0);
    expect(vi.mocked(rememberStudioRegion).mock.invocationCallOrder[remembered]).toBeLessThan(
      vi.mocked(studiosApi.get).mock.invocationCallOrder[1],
    );
    await waitFor(() => expect(rememberStudioRegion).toHaveBeenCalledWith(['far-studio', 's-near'], 'us-west'));
    // A later region refetch must not find the old switcher row again.
    directory.studio.mockResolvedValue({ region: 'us-west' });
    await client.refetchQueries({ queryKey: ['studio-region', 'far-studio'] });
    expect(client.getQueryData(['studio-region', 'far-studio'])).toEqual({ region: 'us-west' });
  });

  // inner#1955: the tab still holds the old Studio, so its lists start on the
  // old region before the re-check corrects it; they must be read again.
  it('reads the Studio lists again once the re-check moved the Studio to its new region', async () => {
    vi.mocked(studiosApi.get).mockReset();
    vi.mocked(studiosApi.get)
      .mockRejectedValueOnce(new ApiException({ status: 404, message: 'missing' }))
      .mockResolvedValueOnce({ ...STUDIO, id: 's-near', region: null });
    vi.mocked(studiosApi.listProjects).mockClear();
    directory.studio.mockClear();
    directory.studio.mockResolvedValueOnce({ region: 'us-west' });
    const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: 30_000 } } });
    client.setQueryData(['studio-region', 'far-studio'], { region: 'sg' });
    client.setQueryData(['studio', 'far-studio'], STUDIO, { updatedAt: 0 });

    renderPage(client);

    await waitFor(() => expect(studiosApi.get).toHaveBeenCalledTimes(2));
    const corrected = directory.studio.mock.invocationCallOrder[0];
    await waitFor(() => expect(Math.max(...vi.mocked(studiosApi.listProjects).mock.invocationCallOrder)).toBeGreaterThan(corrected));
  });

  it('shows not found when the directory still names the region that does not have it', async () => {
    vi.mocked(studiosApi.get).mockReset();
    vi.mocked(studiosApi.get).mockRejectedValue(new ApiException({ status: 404, message: 'missing' }));
    directory.studio.mockClear();
    directory.studio.mockResolvedValueOnce({ region: 'sg' });
    // The app's own freshness window (QueryClientProvider), so the cached answer is used as it would be.
    const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: 30_000 } } });
    client.setQueryData(['studio-region', 'far-studio'], { region: 'sg' });

    renderPage(client);

    expect(await screen.findByText('404')).toBeInTheDocument();
    expect(directory.studio).toHaveBeenCalledTimes(1);
    expect(studiosApi.get).toHaveBeenCalledTimes(1);
  });
});
