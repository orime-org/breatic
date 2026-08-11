// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import * as React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Routes, Route, useLocation } from 'react-router-dom';
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
  avatarUrl: null,
  bio: null,
  myStudioRole: 'admin',
};
const PERSONAL: StudioDetail = {
  id: 's-alex',
  slug: 'alex',
  name: 'Alex',
  type: 'personal',
  memberCount: 1,
  avatarUrl: null,
  bio: null,
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
  avatarUrl: null,
  bio: null,
  myStudioRole: null,
};
const STUDIOS: readonly StudioSummary[] = [
  {
    id: 's-alex',
    slug: 'alex',
    name: 'Alex',
    type: 'personal',
    memberCount: 1,
    avatarUrl: null,
    bio: null,
    myStudioRole: 'admin',
  },
  {
    id: 's-acme',
    slug: 'acme-studio',
    name: 'Acme Studio',
    type: 'team',
    memberCount: 4,
    // Admin of acme (consistent with the studio detail above) so the create
    // selector defaults to the current studio (spec §7.1) → studioId = s-acme.
    avatarUrl: null,
    bio: null,
    myStudioRole: 'admin',
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

/**
 * Report the current path, so a test can assert that a redirect happened and
 * where it went — the address itself is part of what the page promises.
 * @returns An element carrying the current pathname.
 */
function LocationProbe(): React.JSX.Element {
  const location = useLocation();
  return <div data-testid='location'>{location.pathname}</div>;
}

function setup(slug = 'acme-studio', strict = false, tab?: string) {
  // A non-zero gcTime so StrictMode's transient unmount/remount reuses the
  // cached query (proving the shell fetches once, not twice).
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const ui = (
    <QueryClientProvider client={client}>
      <MemoryRouter
        initialEntries={[
          tab === undefined ? `/studio/${slug}` : `/studio/${slug}/${tab}`,
        ]}
      >
        <Routes>
          <Route path='/studio/:slug' element={<StudioContainerPage />} />
          <Route path='/studio/:slug/:tab' element={<StudioContainerPage />} />
        </Routes>
        <LocationProbe />
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
    // Scoped to the section nav: the project cards below are links too, and
    // counting every link on the page would count them.
    const nav = screen.getByRole('navigation', { name: 'Studio sections' });
    expect(within(nav).getAllByRole('link')).toHaveLength(6);
  });

  it('defaults to the Projects tab panel', async () => {
    setup('acme-studio');
    // The tab's accessible name now includes its count chip ("Projects 1"),
    // so match by substring.
    expect(await screen.findByRole('link', { name: /Projects/ })).toHaveAttribute('aria-current', 'page');
  });

  it('switches the visible panel when another tab is clicked', async () => {
    const user = userEvent.setup();
    setup('acme-studio');
    await user.click(await screen.findByRole('link', { name: 'Credits' }));
    expect(screen.getByRole('link', { name: 'Credits' })).toHaveAttribute('aria-current', 'page');
  });

  it('renders all 6 tabs for a personal studio (Members read-only, A 方案)', async () => {
    setup('alex');
    // Personal studios now show all 6 tabs; the Members tab is read-only
    // (A 方案 2026-06-08): projects / collections / works / members / credits /
    // settings.
    await screen.findByRole('navigation', { name: 'Studio sections' });
    const nav = screen.getByRole('navigation', { name: 'Studio sections' });
    expect(within(nav).getAllByRole('link')).toHaveLength(6);
    expect(screen.getByRole('link', { name: /Members/ })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Works' })).toBeInTheDocument();
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

  it('creates a project via the real API with the current studio id and space type', async () => {
    const user = userEvent.setup();
    setup('acme-studio');
    await screen.findByText('Real Studio Project');
    await user.click(screen.getByRole('button', { name: 'New project' }));
    await user.type(screen.getByLabelText('Name'), 'Fresh');
    await user.type(screen.getByLabelText('Slug'), 'fresh-proj');
    await user.click(screen.getByRole('button', { name: 'Create' }));
    // studioId is the current studio (s-acme), and the first space defaults to
    // canvas (the only selectable type today). The studio selector that would
    // let the user target a different studio is a later slice (§7). An exact
    // match, so a visibility field creeping back into the request fails here.
    expect(vi.mocked(projectsApi.create)).toHaveBeenCalledWith({
      studioId: 's-acme',
      name: 'Fresh',
      slug: 'fresh-proj',
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
      screen.getByText('This Studio has no published works.'),
    ).toBeInTheDocument();
    expect(screen.queryByRole('navigation', { name: 'Studio sections' })).toBeNull();
    expect(screen.queryByRole('link')).toBeNull();
  });

  it('renders tabs (member view) when myStudioRole is non-null', async () => {
    setup('acme-studio');
    expect(await screen.findByRole('navigation', { name: 'Studio sections' })).toBeInTheDocument();
    // No non-member empty state leaks into the member view.
    expect(
      screen.queryByText('This studio has no published works.'),
    ).toBeNull();
  });

  it('shows the Works tab empty state when the Works tab is selected', async () => {
    const user = userEvent.setup();
    setup('acme-studio');
    await user.click(await screen.findByRole('link', { name: 'Works' }));
    expect(screen.getByText('No works yet')).toBeInTheDocument();
  });

  // ── the tab is in the address (task #82) ────────────────────────────────
  // A tab is a place, not a mood: it holds a different set of things, and
  // each set is worth sending someone a link to. Keeping it in component
  // state made every one of them the same address, so a link could only ever
  // say "that studio", a refresh dropped you back to Projects, and Back did
  // nothing.

  it('opens the tab the address names', async () => {
    setup('acme-studio', false, 'settings');
    // The tab strip is the visible proof: `aria-selected` names the one tab
    // the page considers current.
    const settings = await screen.findByRole('link', { name: 'Settings' });
    expect(settings).toHaveAttribute('aria-current', 'page');
  });

  it('opens Projects when the address names no tab', async () => {
    setup('acme-studio');
    // Projects / Collections / Members carry a count chip, so the accessible
    // name is the label plus the number — matched loosely on the label.
    const projects = await screen.findByRole('link', { name: /Projects/ });
    expect(projects).toHaveAttribute('aria-current', 'page');
    // The bare studio address is not rewritten to spell out its default —
    // /studio/{slug} stays what a user typed and what we hand out.
    // Exact, not substring: `/studio/acme-studio` is a prefix of every tab
    // address under it, so a substring assertion here would hold whatever the
    // page did.
    expect(screen.getByTestId('location').textContent).toBe(
      '/studio/acme-studio',
    );
  });

  it('sends an address naming no such tab back to the studio', async () => {
    setup('acme-studio', false, 'nonsense');
    // Not a blank page, and not left sitting in the bar: a wrong address
    // resolves to the one address that is certainly right.
    await waitFor(() =>
      // Exact: the address under test is `/studio/acme-studio/nonsense`, which
      // CONTAINS `/studio/acme-studio` — a substring assertion is satisfied
      // before the redirect and could never fail.
      expect(screen.getByTestId('location').textContent).toBe(
        '/studio/acme-studio',
      ),
    );
    expect(await screen.findByRole('link', { name: /Projects/ })).toHaveAttribute('aria-current', 'page');
  });

  it('sends a non-member back to the studio even when the tab name is real', async () => {
    // A non-member gets the public façade, which renders no tabs at all — so
    // `settings` is a perfectly spelled address for something not on the
    // page. Somebody pasting their own settings link to a stranger is the
    // ordinary way to arrive here.
    setup('stranger-studio', false, 'settings');
    await waitFor(() =>
      // Exact, for the same reason as the test above.
      expect(screen.getByTestId('location').textContent).toBe(
        '/studio/stranger-studio',
      ),
    );
    expect(screen.queryByRole('navigation', { name: 'Studio sections' })).toBeNull();
  });

  it('keeps the address in step when the user switches tab by clicking', async () => {
    // The address is the state, so it has to be what changes — otherwise the
    // page and the bar disagree and Back goes somewhere nobody asked for.
    const user = userEvent.setup();
    setup('acme-studio');
    await user.click(await screen.findByRole('link', { name: /Members/ }));
    await waitFor(() =>
      expect(screen.getByTestId('location').textContent).toBe(
        '/studio/acme-studio/members',
      ),
    );
  });
});
