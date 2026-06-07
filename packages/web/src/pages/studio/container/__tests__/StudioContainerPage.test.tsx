// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import * as React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

import StudioContainerPage from '@web/pages/studio/container/StudioContainerPage';
import { expectNoA11yViolations } from '@web/test-utils/a11y';
import type { ProjectSummary, StudioDetail, StudioSummary } from '@breatic/shared';

vi.mock('@web/data/api/studios', () => ({
  studiosApi: {
    get: vi.fn(),
    listUserStudios: vi.fn(),
    listProjects: vi.fn(),
  },
}));
vi.mock('@web/data/api/projects', () => ({
  projectsApi: { create: vi.fn() },
}));
import { studiosApi } from '@web/data/api/studios';
import { projectsApi } from '@web/data/api/projects';

const TEAM: StudioDetail = {
  id: 's-acme',
  slug: 'acme-studio',
  name: 'Acme Studio',
  type: 'team',
  memberCount: 4,
  myStudioRole: 'admin',
};
const PERSONAL: StudioDetail = {
  id: 's-alex',
  slug: 'alex',
  name: 'Alex',
  type: 'personal',
  memberCount: 1,
  myStudioRole: 'admin',
};
const STUDIOS: readonly StudioSummary[] = [
  { id: 's-alex', slug: 'alex', name: 'Alex', type: 'personal', memberCount: 1 },
  { id: 's-acme', slug: 'acme-studio', name: 'Acme Studio', type: 'team', memberCount: 4 },
];
const PROJECTS: readonly ProjectSummary[] = [
  {
    id: 'p-real-1',
    studioId: 's-acme',
    name: 'Real Studio Project',
    slug: 'real-studio-project',
    visibility: 'studio',
    thumbnailUrl: null,
    myRole: 'owner',
    createdAt: new Date('2026-06-07T00:00:00.000Z'),
    updatedAt: new Date('2026-06-07T00:00:00.000Z'),
  },
];

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(studiosApi.get).mockImplementation(async (slug: string) =>
    slug === 'alex' ? PERSONAL : TEAM,
  );
  vi.mocked(studiosApi.listUserStudios).mockResolvedValue([...STUDIOS]);
  vi.mocked(studiosApi.listProjects).mockResolvedValue([...PROJECTS]);
  vi.mocked(projectsApi.create).mockResolvedValue({
    id: 'p-new',
    studioId: 's-acme',
    createdByUserId: 'u-1',
    name: 'Fresh',
    description: null,
    thumbnailUrl: null,
    myRole: 'owner',
    createdAt: '2026-06-07T00:00:00.000Z',
    updatedAt: '2026-06-07T00:00:00.000Z',
    deletedAt: null,
  });
});

function setup(slug = 'acme-studio', strict = false) {
  // A non-zero gcTime so StrictMode's transient unmount/remount reuses the
  // cached query (proving the shell fetches once, not twice).
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const ui = (
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[`/studio/${slug}`]}>
        <Routes>
          <Route path='/studio/:slug' element={<StudioContainerPage />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>
  );
  return render(strict ? <React.StrictMode>{ui}</React.StrictMode> : ui);
}

describe('StudioContainerPage', () => {
  it('renders the top-bar banner, the studio header and a 5-tab tablist (shell from the real query)', async () => {
    setup('acme-studio');
    expect(screen.getByRole('banner')).toBeInTheDocument();
    // The studio name appears in the switcher trigger (GET /studios) and the
    // shead (GET /studio/:slug) once both queries resolve.
    expect(
      (await screen.findAllByText('Acme Studio')).length,
    ).toBeGreaterThanOrEqual(2);
    expect(screen.getByText('Team')).toBeInTheDocument();
    expect(screen.getAllByRole('tab')).toHaveLength(5);
  });

  it('defaults to the Projects tab panel', async () => {
    setup('acme-studio');
    expect(await screen.findByRole('tab', { name: 'Projects' })).toHaveAttribute(
      'aria-selected',
      'true',
    );
  });

  it('switches the visible panel when another tab is clicked', async () => {
    const user = userEvent.setup();
    setup('acme-studio');
    await user.click(await screen.findByRole('tab', { name: 'Credits' }));
    expect(screen.getByRole('tab', { name: 'Credits' })).toHaveAttribute(
      'aria-selected',
      'true',
    );
  });

  it('renders 4 tabs for a personal studio (no Members)', async () => {
    setup('alex');
    expect(await screen.findAllByRole('tab')).toHaveLength(4);
    expect(screen.queryByRole('tab', { name: 'Members' })).toBeNull();
  });

  it('shows the error state when the studio cannot be loaded', async () => {
    vi.mocked(studiosApi.get).mockRejectedValueOnce(new Error('not found'));
    setup('ghost');
    expect(await screen.findByRole('alert')).toHaveTextContent(/couldn't load/i);
  });

  it('fetches the studio once under StrictMode (no double request — invariant 5)', async () => {
    setup('acme-studio', true);
    await screen.findByText('Team');
    expect(vi.mocked(studiosApi.get)).toHaveBeenCalledTimes(1);
  });

  it('renders the studio projects from the real API (slice 2)', async () => {
    setup('acme-studio');
    expect(
      await screen.findByText('Real Studio Project'),
    ).toBeInTheDocument();
  });

  it('creates a project via the real API with the chosen visibility', async () => {
    const user = userEvent.setup();
    setup('acme-studio');
    await screen.findByText('Real Studio Project');
    await user.click(screen.getByRole('button', { name: 'New project' }));
    await user.type(screen.getByLabelText('Name'), 'Fresh');
    await user.type(screen.getByLabelText('Handle'), 'fresh-proj');
    await user.click(screen.getByLabelText(/invite only/));
    await user.click(screen.getByRole('button', { name: 'Create' }));
    expect(vi.mocked(projectsApi.create)).toHaveBeenCalledWith({
      name: 'Fresh',
      slug: 'fresh-proj',
      visibility: 'private',
      description: undefined,
    });
  });

  it('has no a11y violations', async () => {
    const { container } = setup('acme-studio');
    await screen.findByText('Team');
    await expectNoA11yViolations(container);
  });
});
