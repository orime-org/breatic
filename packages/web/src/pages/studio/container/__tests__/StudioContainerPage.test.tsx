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
// A studio the viewer is NOT a member of (decision A: 200 + null role). The
// container renders the non-member view (no tabs) for this case (spec §6.3).
const STRANGER: StudioDetail = {
  id: 's-stranger',
  slug: 'stranger-studio',
  name: 'Stranger Studio',
  type: 'team',
  memberCount: 9,
  myStudioRole: null,
};
const STUDIOS: readonly StudioSummary[] = [
  {
    id: 's-alex',
    slug: 'alex',
    name: 'Alex',
    type: 'personal',
    memberCount: 1,
    myStudioRole: 'admin',
  },
  {
    id: 's-acme',
    slug: 'acme-studio',
    name: 'Acme Studio',
    type: 'team',
    memberCount: 4,
    myStudioRole: 'member',
  },
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
  vi.mocked(studiosApi.get).mockImplementation(async (slug: string) => {
    if (slug === 'alex') return PERSONAL;
    if (slug === 'stranger-studio') return STRANGER;
    return TEAM;
  });
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
  it('renders the studio header and a 6-tab tablist (shell from the real query)', async () => {
    setup('acme-studio');
    // The top bar moved to the layout route, so the container renders the
    // studio header (name + type badge) + the tab list, not a banner. The tab
    // set is 6 for a team studio (projects / collections / works / members /
    // credits / settings — Works added at the 3rd position, spec §6.1).
    expect(await screen.findByText('Acme Studio')).toBeInTheDocument();
    expect(screen.getByText('Team')).toBeInTheDocument();
    expect(screen.getAllByRole('tab')).toHaveLength(6);
  });

  it('defaults to the Projects tab panel', async () => {
    setup('acme-studio');
    // The tab's accessible name now includes its count chip ("Projects 1"),
    // so match by substring.
    expect(await screen.findByRole('tab', { name: /Projects/ })).toHaveAttribute(
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

  it('renders 5 tabs for a personal studio (no Members, Works kept)', async () => {
    setup('alex');
    // Works is non-team-only, so a personal studio keeps it: projects /
    // collections / works / credits / settings (Members dropped).
    expect(await screen.findAllByRole('tab')).toHaveLength(5);
    expect(screen.queryByRole('tab', { name: 'Members' })).toBeNull();
    expect(screen.getByRole('tab', { name: 'Works' })).toBeInTheDocument();
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

  it('creates a project via the real API with the current studio id, chosen visibility and space type', async () => {
    const user = userEvent.setup();
    setup('acme-studio');
    await screen.findByText('Real Studio Project');
    await user.click(screen.getByRole('button', { name: 'New project' }));
    await user.type(screen.getByLabelText('Name'), 'Fresh');
    await user.type(screen.getByLabelText('Handle'), 'fresh-proj');
    await user.click(screen.getByLabelText(/invite only/));
    await user.click(screen.getByRole('button', { name: 'Create' }));
    // studioId is the current studio (s-acme), and the first space defaults to
    // canvas (the only selectable type today). The studio selector that would
    // let the user target a different studio is a later slice (§7).
    expect(vi.mocked(projectsApi.create)).toHaveBeenCalledWith({
      studioId: 's-acme',
      name: 'Fresh',
      slug: 'fresh-proj',
      visibility: 'private',
      spaceType: 'canvas',
      description: undefined,
    });
  });

  it('has no a11y violations', async () => {
    const { container } = setup('acme-studio');
    await screen.findByText('Team');
    await expectNoA11yViolations(container);
  });

  // ── fork by myStudioRole (spec §6, invariant 5) ──────────────────────────
  it('renders the non-member view (no tabs) when myStudioRole is null', async () => {
    setup('stranger-studio');
    // The header still renders (the studio is a public façade, decision A),
    // but a non-member sees the works empty state and NO tabs.
    expect(await screen.findByText('Stranger Studio')).toBeInTheDocument();
    expect(
      screen.getByText('This studio has no published works.'),
    ).toBeInTheDocument();
    expect(screen.queryByRole('tablist')).toBeNull();
    expect(screen.queryByRole('tab')).toBeNull();
  });

  it('renders tabs (member view) when myStudioRole is non-null', async () => {
    setup('acme-studio');
    expect(await screen.findByRole('tablist')).toBeInTheDocument();
    // No non-member empty state leaks into the member view.
    expect(
      screen.queryByText('This studio has no published works.'),
    ).toBeNull();
  });

  it('shows the Works tab empty state when the Works tab is selected', async () => {
    const user = userEvent.setup();
    setup('acme-studio');
    await user.click(await screen.findByRole('tab', { name: 'Works' }));
    expect(screen.getByText('No works yet')).toBeInTheDocument();
  });
});
