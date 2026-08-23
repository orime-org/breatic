// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { ReactElement } from 'react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

import { ProjectsTab } from '@web/pages/studio/container/tabs/ProjectsTab';
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

// ── ProjectsTab — invariant 1 (visibility filter) ──────────────────────────
const STUDIO_VISIBLE: ContainerProject = {
  id: 'a',
  slug: 'open',
  name: 'Open Project',
  thumbnailUrl: null,
  visibility: 'studio',
  myRole: 'viewer',
  createdAt: '2026-06-01T00:00:00.000Z',
};
const PRIVATE_UNINVOLVED: ContainerProject = {
  id: 'b',
  slug: 'hidden',
  name: 'Hidden Project',
  thumbnailUrl: null,
  visibility: 'private',
  myRole: null,
  createdAt: '2026-06-01T00:00:00.000Z',
};

describe('ProjectsTab (spec §4 invariant 1: visibility filter)', () => {
  it('hides a private uninvolved project from a Member', () => {
    withRouter(
      <ProjectsTab
        projects={[STUDIO_VISIBLE, PRIVATE_UNINVOLVED]}
        studioRole='guest'
      />,
    );
    expect(screen.getByText('Open Project')).toBeInTheDocument();
    expect(screen.queryByText('Hidden Project')).toBeNull();
  });

  it('shows every project to an Admin', () => {
    withRouter(
      <ProjectsTab
        projects={[STUDIO_VISIBLE, PRIVATE_UNINVOLVED]}
        studioRole='admin'
      />,
    );
    expect(screen.getByText('Open Project')).toBeInTheDocument();
    expect(screen.getByText('Hidden Project')).toBeInTheDocument();
  });

  it('offers create to an admin/maintainer, never to a guest or non-member (spec §7.1)', () => {
    const admin = withRouter(
      <ProjectsTab projects={[STUDIO_VISIBLE]} studioRole='admin' />,
    );
    expect(
      screen.getByRole('button', { name: 'New project' }),
    ).toBeInTheDocument();
    admin.unmount();

    const maintainer = withRouter(
      <ProjectsTab projects={[STUDIO_VISIBLE]} studioRole='maintainer' />,
    );
    expect(
      screen.getByRole('button', { name: 'New project' }),
    ).toBeInTheDocument();
    maintainer.unmount();

    // A plain guest cannot create — creating is limited to admin/maintainer
    // (spec §0.2 / §8.2).
    const guest = withRouter(
      <ProjectsTab projects={[STUDIO_VISIBLE]} studioRole='guest' />,
    );
    expect(screen.queryByRole('button', { name: 'New project' })).toBeNull();
    guest.unmount();

    // A non-member viewing the public shell never sees the create entry.
    withRouter(<ProjectsTab projects={[STUDIO_VISIBLE]} studioRole={null} />);
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
  it('shows transfer / delete for a team studio Admin', () => {
    withQuery(<SettingsTab studio={TEAM} members={[]} />);
    expect(screen.getByText('Danger zone')).toBeInTheDocument();
  });

  // A personal studio gets the box too, holding the one action that is
  // destructive for one. Its slug is its owner's handle: changing it frees
  // that name for the next claimant and 404s every link pointing at them.
  // Transfer, delete and leave are the three that mean nothing for a personal
  // studio, and that is a fact about them, not about the box.
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
    // Transfer and delete belong to the admin.
    expect(screen.queryByTestId('settings-transfer-open')).toBeNull();
  });

  it('shows the Admin transfer / delete / slug, and no leave action', () => {
    withQuery(<SettingsTab studio={TEAM} members={[]} />);
    expect(screen.getByTestId('settings-transfer-open')).toBeInTheDocument();
    expect(screen.getByTestId('settings-delete')).toBeInTheDocument();
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
