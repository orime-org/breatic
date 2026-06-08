// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { ReactElement } from 'react';
import { MemoryRouter } from 'react-router-dom';

import { ProjectsTab } from '@web/pages/studio/container/tabs/ProjectsTab';
import { CreditsTab } from '@web/pages/studio/container/tabs/CreditsTab';
import { MembersTab } from '@web/pages/studio/container/tabs/MembersTab';
import { SettingsTab } from '@web/pages/studio/container/tabs/SettingsTab';
import type {
  ContainerProject,
  CreditWallet,
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
  updatedAt: '2026-06-01T00:00:00.000Z',
};
const PRIVATE_UNINVOLVED: ContainerProject = {
  id: 'b',
  slug: 'hidden',
  name: 'Hidden Project',
  thumbnailUrl: null,
  visibility: 'private',
  myRole: null,
  updatedAt: '2026-06-01T00:00:00.000Z',
};

describe('ProjectsTab (spec §4 invariant 1: visibility filter)', () => {
  it('hides a private uninvolved project from a Member', () => {
    withRouter(
      <ProjectsTab
        projects={[STUDIO_VISIBLE, PRIVATE_UNINVOLVED]}
        studioRole='member'
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

  it('offers create to an admin/creator, never to a member or guest (spec §7.1)', () => {
    const admin = withRouter(
      <ProjectsTab projects={[STUDIO_VISIBLE]} studioRole='admin' />,
    );
    expect(
      screen.getByRole('button', { name: 'New project' }),
    ).toBeInTheDocument();
    admin.unmount();

    const creator = withRouter(
      <ProjectsTab projects={[STUDIO_VISIBLE]} studioRole='creator' />,
    );
    expect(
      screen.getByRole('button', { name: 'New project' }),
    ).toBeInTheDocument();
    creator.unmount();

    // A plain member cannot create — studio credits are shared, so creating is
    // limited to admin/creator (spec §0.2 / §8.2).
    const member = withRouter(
      <ProjectsTab projects={[STUDIO_VISIBLE]} studioRole='member' />,
    );
    expect(screen.queryByRole('button', { name: 'New project' })).toBeNull();
    member.unmount();

    // A guest viewing the public shell never sees the create entry.
    withRouter(<ProjectsTab projects={[STUDIO_VISIBLE]} studioRole={null} />);
    expect(screen.queryByRole('button', { name: 'New project' })).toBeNull();
  });
});

// ── CreditsTab — invariant 4 (read cached total, team has no gift) ──────────
const TEAM_WALLET: CreditWallet = {
  balanceCached: 999, // deliberately != sum of lots, to prove it is read, not summed
  paidLots: [
    {
      id: 'l1',
      source: 'paid',
      amountInitial: 10000,
      amountRemaining: 8000,
      isRefundable: true,
      expiresAt: null,
    },
  ],
  giftLots: [],
  ledger: [],
};
const PERSONAL_WALLET: CreditWallet = {
  balanceCached: 5200,
  paidLots: [
    {
      id: 'l2',
      source: 'paid',
      amountInitial: 3000,
      amountRemaining: 2000,
      isRefundable: true,
      expiresAt: null,
    },
  ],
  giftLots: [
    {
      id: 'g1',
      source: 'promo',
      amountInitial: 2000,
      amountRemaining: 1200,
      isRefundable: false,
      expiresAt: '2026-06-11T00:00:00.000Z',
    },
  ],
  ledger: [],
};
const NOW = Date.UTC(2026, 5, 5);

describe('CreditsTab (spec §4 invariant 4: read-only cached balance)', () => {
  it('renders the cached balance verbatim, never recomputed from lots', () => {
    render(<CreditsTab wallet={TEAM_WALLET} studioRole='admin' now={NOW} />);
    expect(screen.getByTestId('wallet-balance').textContent).toBe('999');
  });

  it('hides the gift section for a team studio (no gift lots)', () => {
    render(<CreditsTab wallet={TEAM_WALLET} studioRole='admin' now={NOW} />);
    expect(screen.queryByText('Gift credits')).toBeNull();
  });

  it('shows the gift section for a personal studio', () => {
    render(<CreditsTab wallet={PERSONAL_WALLET} studioRole='admin' now={NOW} />);
    expect(screen.getByText('Gift credits')).toBeInTheDocument();
  });

  it('shows refund only to an Admin', () => {
    const { rerender } = render(
      <CreditsTab wallet={TEAM_WALLET} studioRole='admin' now={NOW} />,
    );
    expect(
      screen.getByRole('button', { name: 'Request refund' }),
    ).toBeInTheDocument();
    rerender(<CreditsTab wallet={TEAM_WALLET} studioRole='member' now={NOW} />);
    expect(screen.queryByRole('button', { name: 'Request refund' })).toBeNull();
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

describe('MembersTab (spec §3.7)', () => {
  it('shows the invite button to an Admin', () => {
    render(<MembersTab members={MEMBERS} studioRole='admin' />);
    expect(
      screen.getByRole('button', { name: 'Invite member' }),
    ).toBeInTheDocument();
  });

  it('hides the invite button from a Member', () => {
    render(<MembersTab members={MEMBERS} studioRole='member' />);
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
  myStudioRole: 'admin',
};
const PERSONAL: StudioDetail = {
  id: 's2',
  slug: 'alex',
  name: 'Alex',
  type: 'personal',
  memberCount: 1,
  myStudioRole: 'admin',
};

describe('SettingsTab (spec §3.11 danger zone)', () => {
  it('shows transfer / delete for a team studio Admin', () => {
    render(<SettingsTab studio={TEAM} />);
    expect(screen.getByText('Danger zone')).toBeInTheDocument();
  });

  it('never shows the danger zone for a personal studio', () => {
    render(<SettingsTab studio={PERSONAL} />);
    expect(screen.queryByText('Danger zone')).toBeNull();
  });

  it('hides the danger zone from a team Member', () => {
    render(<SettingsTab studio={{ ...TEAM, myStudioRole: 'member' }} />);
    expect(screen.queryByText('Danger zone')).toBeNull();
  });
});
