// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { describe, it, expect, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactElement } from 'react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

import { ProjectsTab } from '@web/pages/studio/container/tabs/ProjectsTab';
import { ArchivedTab } from '@web/pages/studio/container/tabs/ArchivedTab';
import type { StudioProjectList } from '@web/pages/studio/container/use-studio-projects-paging';
import { MembersTab } from '@web/pages/studio/container/tabs/MembersTab';
import { SettingsTab } from '@web/pages/studio/container/tabs/SettingsTab';
import type {
  ContainerProject,
  StudioDetail,
  StudioMember,
} from '@web/pages/studio/container/container-types';

function withRouter(ui: ReactElement) {
  return render(<MemoryRouter>{ui}</MemoryRouter>);
}

// ── ProjectsTab ────────────────────────────────────────────────────────────
const STUDIO_VISIBLE: ContainerProject = {
  id: 'a',
  slug: 'open',
  name: 'Open Project',
  thumbnailUrl: null,
  myRole: 'viewer',
  createdAt: '2026-06-01T00:00:00.000Z',
  archivedAt: null,
  lastOpenedAt: null,
  lastEditedAt: '2026-06-01T00:00:00.000Z',
  canManageMeta: false,
  canDuplicate: false,
  canArchive: false,
  canRestore: false,
  canLeave: false,
};
const NOT_JOINED: ContainerProject = {
  id: 'b',
  slug: 'other',
  name: 'Other Project',
  thumbnailUrl: null,
  myRole: null,
  createdAt: '2026-06-01T00:00:00.000Z',
  archivedAt: null,
  lastOpenedAt: null,
  lastEditedAt: '2026-06-01T00:00:00.000Z',
  canManageMeta: false,
  canDuplicate: false,
  canArchive: false,
  canRestore: false,
  canLeave: false,
};


/**
 * A loaded list holding these projects, with nothing more to fetch.
 * @param projects - The projects.
 * @param extra - States to override.
 * @returns The list state a tab renders from.
 */
function listOf(
  projects: readonly ContainerProject[],
  extra: Partial<StudioProjectList> = {},
): StudioProjectList {
  return {
    projects,
    total: projects.length,
    isPending: false,
    firstPageFailed: false,
    retryFirstPage: vi.fn(),
    isFetchingNextPage: false,
    hasNextPage: false,
    pageFailed: false,
    loadMore: vi.fn(),
    sentinelRef: vi.fn(),
    scrollerRef: vi.fn(),
    ...extra,
  };
}

const LIST_CONTROLS = {
  sort: 'opened' as const,
  onSortChange: vi.fn(),
  view: 'grid' as const,
  onViewChange: vi.fn(),
};

describe('ProjectsTab', () => {
  it('shows a guest every project the server listed, including ones they are not on', () => {
    withQuery(
      <ProjectsTab list={listOf([STUDIO_VISIBLE, NOT_JOINED])} {...LIST_CONTROLS} studioRole='guest' />,
    );
    expect(screen.getByText('Open Project')).toBeInTheDocument();
    expect(screen.getByText('Other Project')).toBeInTheDocument();
  });

  it('offers create to an admin/maintainer, never to a guest or non-member (spec §7.1)', () => {
    const admin = withRouter(
      <ProjectsTab list={listOf([STUDIO_VISIBLE])} {...LIST_CONTROLS} studioRole='admin' />,
    );
    expect(
      screen.getByRole('button', { name: 'New project' }),
    ).toBeInTheDocument();
    admin.unmount();

    const maintainer = withRouter(
      <ProjectsTab list={listOf([STUDIO_VISIBLE])} {...LIST_CONTROLS} studioRole='maintainer' />,
    );
    expect(
      screen.getByRole('button', { name: 'New project' }),
    ).toBeInTheDocument();
    maintainer.unmount();

    // A plain guest cannot create — creating is limited to admin/maintainer
    // (spec §0.2 / §8.2).
    const guest = withRouter(
      <ProjectsTab list={listOf([STUDIO_VISIBLE])} {...LIST_CONTROLS} studioRole='guest' />,
    );
    expect(screen.queryByRole('button', { name: 'New project' })).toBeNull();
    guest.unmount();

    // A non-member viewing the public shell never sees the create entry.
    withRouter(<ProjectsTab list={listOf([STUDIO_VISIBLE])} {...LIST_CONTROLS} studioRole={null} />);
    expect(screen.queryByRole('button', { name: 'New project' })).toBeNull();
  });
});

// ── MembersTab — Admin-only invite ─────────────────────────────────────────
const MEMBERS: readonly StudioMember[] = [
  {
    id: 'u1',
    name: 'Alex',
    email: 'alex@x.example',
    avatarUrl: null,
    studioRole: 'admin',
    joinedAt: '2026-04-01T00:00:00.000Z',
  },
];

function withQuery(ui: ReactElement) {
  const qc = new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: 0 },
      mutations: { retry: false },
    },
  });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>{ui}</MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('ProjectsTab — views and loading', () => {
  it('lists the projects as table rows with the six columns in the list view, the sorted column marked', () => {
    withQuery(
      <ProjectsTab
        list={listOf([STUDIO_VISIBLE, NOT_JOINED])}
        {...LIST_CONTROLS}
        sort='name'
        view='list'
        studioRole='guest'
      />,
    );
    const table = screen.getByRole('table');
    const headers = within(table).getAllByRole('columnheader').map((h) => h.textContent);
    expect(headers).toEqual(['', 'Name', 'Last opened', 'Last edited', 'Created', 'My role']);
    expect(within(table).getByRole('columnheader', { name: 'Name' })).toHaveAttribute('aria-sort', 'ascending');
    expect(within(table).getAllByRole('row')).toHaveLength(3);
    expect(within(table).getByRole('link', { name: 'Open Project' })).toHaveAttribute('href', '/project/open-a');
  });

  it('shows placeholders and no count while the first page loads', () => {
    withRouter(
      <ProjectsTab
        list={listOf([], { isPending: true, total: null })}
        {...LIST_CONTROLS}
        studioRole='guest'
      />,
    );
    expect(screen.getAllByTestId('project-placeholder').length).toBeGreaterThan(0);
    expect(screen.queryByTestId('container-toolbar-count')).not.toBeInTheDocument();
  });

  it('offers to retry a first page that did not arrive', async () => {
    const list = listOf([], { firstPageFailed: true, total: null });
    withRouter(<ProjectsTab list={list} {...LIST_CONTROLS} studioRole='guest' />);
    await userEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(list.retryFirstPage).toHaveBeenCalled();
  });

  it('keeps the loaded projects and offers to retry when the next page did not arrive', async () => {
    const list = listOf([STUDIO_VISIBLE], { hasNextPage: true, pageFailed: true, total: 2 });
    withRouter(<ProjectsTab list={list} {...LIST_CONTROLS} studioRole='guest' />);
    expect(screen.getByText('Open Project')).toBeInTheDocument();
    expect(screen.getByText('The rest of the projects did not load')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(list.loadMore).toHaveBeenCalled();
  });

  it('shows placeholders at the end while the next page loads', () => {
    withRouter(
      <ProjectsTab
        list={listOf([STUDIO_VISIBLE], { hasNextPage: true, isFetchingNextPage: true, total: 2 })}
        {...LIST_CONTROLS}
        studioRole='guest'
      />,
    );
    expect(screen.getAllByTestId('project-placeholder').length).toBeGreaterThan(0);
  });

  it('says how many projects there are once all of them are loaded, and shows the total in the toolbar', () => {
    withQuery(
      <ProjectsTab list={listOf([STUDIO_VISIBLE, NOT_JOINED])} {...LIST_CONTROLS} studioRole='guest' />,
    );
    expect(screen.getByText('2 projects')).toBeInTheDocument();
    expect(screen.getByTestId('container-toolbar-count')).toHaveTextContent('2');
  });
});

describe('ArchivedTab', () => {
  it('offers the archive sorts and shows the archive time in the list view', () => {
    withRouter(
      <ArchivedTab
        list={listOf([{ ...STUDIO_VISIBLE, archivedAt: '2026-06-02T00:00:00.000Z' }])}
        sort='archived'
        onSortChange={vi.fn()}
        view='list'
        onViewChange={vi.fn()}
      />,
    );
    const headers = within(screen.getByRole('table')).getAllByRole('columnheader').map((h) => h.textContent);
    expect(headers).toEqual(['', 'Name', 'Archived', 'Last edited', 'Created', 'My role']);
  });
});

describe('MembersTab (spec §3.7)', () => {
  it('shows the invite button to an Admin', () => {
    withQuery(
      <MembersTab slug='acme' members={MEMBERS} studioRole='admin' studioType='team' pendingInvitations={[]} />,
    );
    expect(
      screen.getByRole('button', { name: 'Invite member' }),
    ).toBeInTheDocument();
  });

  it('hides the invite button from a Member', () => {
    withQuery(
      <MembersTab slug='acme' members={MEMBERS} studioRole='guest' studioType='team' pendingInvitations={[]} />,
    );
    expect(screen.queryByRole('button', { name: 'Invite member' })).toBeNull();
  });
});

// ── SettingsTab — danger zone gating ───────────────────────────────────────
const TEAM: StudioDetail = {
  id: 's1',
  slug: 'acme',
  name: 'Acme',
  type: 'team',
  memberCount: 3,
  avatarUrl: null,
  bio: null,
  myStudioRole: 'admin',
};
const PERSONAL: StudioDetail = {
  id: 's2',
  slug: 'alex',
  name: 'Alex',
  type: 'personal',
  memberCount: 1,
  avatarUrl: null,
  bio: null,
  myStudioRole: 'admin',
};

describe('SettingsTab — the danger zone, wired up', () => {
  it('shows the danger zone to a team studio Admin', () => {
    withQuery(<SettingsTab studio={TEAM} members={[]} />);
    expect(screen.getByText('Danger zone')).toBeInTheDocument();
  });

  // A personal studio gets the box too, holding the one action that is
  // destructive for one. Its slug is its owner's handle: changing it frees
  // that name for the next claimant and 404s every link pointing at them.
  // Transfer and leave are the two that mean nothing for a personal studio,
  // and that is a fact about them, not about the box.
  it('shows a personal studio the danger zone, holding only the slug action', () => {
    withQuery(<SettingsTab studio={PERSONAL} members={[]} />);
    expect(screen.getByText('Danger zone')).toBeInTheDocument();
    expect(screen.getByTestId('settings-slug-open')).toBeInTheDocument();
    expect(screen.queryByTestId('settings-transfer-open')).toBeNull();
    expect(screen.queryByTestId('settings-delete')).toBeNull();
    expect(screen.queryByTestId('settings-leave-open')).toBeNull();
  });

  // A member sees the danger zone too, with different contents. Hiding it
  // from non-admins hid the leave button from the only people who can use it
  // — an admin has to transfer the studio rather than leave it.
  it('shows a team Member the danger zone, holding their leave action', () => {
    withQuery(
      <SettingsTab studio={{ ...TEAM, myStudioRole: 'guest' }} members={[]} />,
    );
    expect(screen.getByText('Danger zone')).toBeInTheDocument();
    expect(screen.getByTestId('settings-leave-open')).toBeInTheDocument();
    // Transfer belongs to the admin.
    expect(screen.queryByTestId('settings-transfer-open')).toBeNull();
  });

  it('shows the Admin transfer / slug, and no delete or leave action', () => {
    withQuery(<SettingsTab studio={TEAM} members={[]} />);
    expect(screen.getByTestId('settings-transfer-open')).toBeInTheDocument();
    expect(screen.queryByTestId('settings-delete')).toBeNull();
    expect(screen.getByTestId('settings-slug-open')).toBeInTheDocument();
    expect(screen.queryByTestId('settings-leave-open')).toBeNull();
  });

  it('shows no danger zone to a non-member viewing the front door', () => {
    withQuery(
      <SettingsTab studio={{ ...TEAM, myStudioRole: null }} members={[]} />,
    );
    expect(screen.queryByText('Danger zone')).toBeNull();
  });
});
