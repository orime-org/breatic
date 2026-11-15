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
vi.mock('@web/data/api/directory', () => ({
  directoryApi: { studio: vi.fn(async () => ({ region: 'sg' })) },
}));
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
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={client}>
        <MemoryRouter initialEntries={['/studio/far-studio']}>
          <Routes>
            <Route path='/studio/:slug' element={<StudioContainerPage />} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    );

    expect(await screen.findByText('Far Studio')).toBeInTheDocument();
    expect(rememberStudioRegion).toHaveBeenCalledWith(['far-studio'], 'sg');
    await waitFor(() => expect(rememberStudioRegion).toHaveBeenCalledWith(['far-studio', 's-far'], 'sg'));
  });
});
