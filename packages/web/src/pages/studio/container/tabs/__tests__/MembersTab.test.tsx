// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactElement } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

import { MembersTab } from '@web/pages/studio/container/tabs/MembersTab';
import type { StudioMember } from '@web/pages/studio/container/container-types';
import { ApiException } from '@web/data/api/types';
import { expectNoA11yViolations } from '@web/test-utils/a11y';
import type { PendingInvitationSummary } from '@breatic/shared';

vi.mock('@web/data/api/studios', () => ({
  studiosApi: {
    inviteMember: vi.fn(),
    removeMember: vi.fn(),
    updateMemberRole: vi.fn(),
    requestTransfer: vi.fn(),
    revokeInvitation: vi.fn(),
  },
}));

vi.mock('sonner', () => ({
  toast: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn() }),
}));

import { studiosApi } from '@web/data/api/studios';
import { toast } from 'sonner';

const ADMIN: StudioMember = {
  id: 'u-admin',
  name: 'Admin Ada',
  email: 'ada@x.example',
  avatarUrl: null,
  studioRole: 'admin',
  joinedAt: '2026-04-01T00:00:00.000Z',
};
const GUEST: StudioMember = {
  id: 'u-bob',
  name: 'Bob',
  email: 'bob@x.example',
  avatarUrl: null,
  studioRole: 'guest',
  joinedAt: '2026-04-02T00:00:00.000Z',
};
const MAINTAINER: StudioMember = {
  id: 'u-cara',
  name: 'Cara',
  email: 'cara@x.example',
  avatarUrl: null,
  studioRole: 'maintainer',
  joinedAt: '2026-04-03T00:00:00.000Z',
};
const PENDING: PendingInvitationSummary = {
  invitationId: 'inv-1',
  invitedUserId: 'u-dee',
  name: 'Dee',
  email: 'dee@x.example',
  avatarUrl: null,
  role: 'guest',
  invitedByName: 'Admin Ada',
  expiresAt: '2026-06-21T00:00:00.000Z',
};

function renderTab(ui: ReactElement) {
  const qc = new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: 0 },
      mutations: { retry: false },
    },
  });
  return render(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>);
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('MembersTab — row menu visibility', () => {
  it('renders a row menu for non-admin members but never for the admin row', () => {
    renderTab(
      <MembersTab
        slug='acme'
        members={[ADMIN, GUEST, MAINTAINER]}
        studioRole='admin'
        studioType='team' pendingInvitations={[]}
      />,
    );
    expect(screen.getByTestId(`member-row-menu-${GUEST.id}`)).toBeInTheDocument();
    expect(screen.getByTestId(`member-row-menu-${MAINTAINER.id}`)).toBeInTheDocument();
    // The admin manages others, not themselves.
    expect(screen.queryByTestId(`member-row-menu-${ADMIN.id}`)).toBeNull();
  });

  it('shows no row menus to a plain member', () => {
    renderTab(
      <MembersTab
        slug='acme'
        members={[ADMIN, GUEST]}
        studioRole='guest'
        studioType='team' pendingInvitations={[]}
      />,
    );
    expect(screen.queryByTestId(`member-row-menu-${GUEST.id}`)).toBeNull();
  });
});

describe('MembersTab — invite flow', () => {
  it('opens the invite dialog and calls inviteMember with email + role', async () => {
    const user = userEvent.setup();
    vi.mocked(studiosApi.inviteMember).mockResolvedValueOnce({ ok: true });
    renderTab(
      <MembersTab slug='acme' members={[ADMIN]} studioRole='admin' studioType='team' pendingInvitations={[]} />,
    );
    await user.click(screen.getByRole('button', { name: 'Invite member' }));

    const dialog = await screen.findByTestId('invite-member-dialog');
    await user.type(within(dialog).getByLabelText('Email'), 'new@x.example');
    await user.click(within(dialog).getByRole('button', { name: 'Send invite' }));

    await waitFor(() => {
      expect(studiosApi.inviteMember).toHaveBeenCalledWith('acme', {
        email: 'new@x.example',
        role: 'guest',
      });
    });
  });

  it('shows the server error inline when the email is not registered (404)', async () => {
    const user = userEvent.setup();
    vi.mocked(studiosApi.inviteMember).mockRejectedValueOnce(
      new ApiException({
        status: 404,
        code: 'NOT_FOUND',
        message: 'That email is not registered.',
      }),
    );
    renderTab(
      <MembersTab slug='acme' members={[ADMIN]} studioRole='admin' studioType='team' pendingInvitations={[]} />,
    );
    await user.click(screen.getByRole('button', { name: 'Invite member' }));
    const dialog = await screen.findByTestId('invite-member-dialog');
    await user.type(within(dialog).getByLabelText('Email'), 'ghost@x.example');
    await user.click(within(dialog).getByRole('button', { name: 'Send invite' }));

    expect(
      await within(dialog).findByTestId('invite-member-error'),
    ).toHaveTextContent('That email is not registered.');
    // Dialog stays open so the admin can correct the email.
    expect(screen.getByTestId('invite-member-dialog')).toBeInTheDocument();
  });
});

describe('MembersTab — change role', () => {
  it('promotes a guest to maintainer via the row menu', async () => {
    const user = userEvent.setup();
    vi.mocked(studiosApi.updateMemberRole).mockResolvedValueOnce({ ok: true });
    renderTab(
      <MembersTab
        slug='acme'
        members={[ADMIN, GUEST]}
        studioRole='admin'
        studioType='team' pendingInvitations={[]}
      />,
    );
    await user.click(screen.getByTestId(`member-row-menu-${GUEST.id}`));
    await user.click(await screen.findByTestId(`member-toggle-role-${GUEST.id}`));

    await waitFor(() => {
      expect(studiosApi.updateMemberRole).toHaveBeenCalledWith('acme', GUEST.id, {
        role: 'maintainer',
      });
    });
  });

  it('demotes a maintainer to guest via the row menu', async () => {
    const user = userEvent.setup();
    vi.mocked(studiosApi.updateMemberRole).mockResolvedValueOnce({ ok: true });
    renderTab(
      <MembersTab
        slug='acme'
        members={[ADMIN, MAINTAINER]}
        studioRole='admin'
        studioType='team' pendingInvitations={[]}
      />,
    );
    await user.click(screen.getByTestId(`member-row-menu-${MAINTAINER.id}`));
    await user.click(await screen.findByTestId(`member-toggle-role-${MAINTAINER.id}`));

    await waitFor(() => {
      expect(studiosApi.updateMemberRole).toHaveBeenCalledWith('acme', MAINTAINER.id, {
        role: 'guest',
      });
    });
  });
});

describe('MembersTab — remove member (confirm gate)', () => {
  it('requires confirmation before calling removeMember', async () => {
    const user = userEvent.setup();
    vi.mocked(studiosApi.removeMember).mockResolvedValueOnce({ ok: true });
    renderTab(
      <MembersTab
        slug='acme'
        members={[ADMIN, GUEST]}
        studioRole='admin'
        studioType='team' pendingInvitations={[]}
      />,
    );
    await user.click(screen.getByTestId(`member-row-menu-${GUEST.id}`));
    await user.click(await screen.findByTestId(`member-remove-${GUEST.id}`));

    // Opening the menu item does not call the API — a confirm dialog gates it.
    expect(studiosApi.removeMember).not.toHaveBeenCalled();
    const dialog = await screen.findByTestId('member-confirm-dialog');
    await user.click(within(dialog).getByTestId('member-confirm-action'));

    await waitFor(() => {
      expect(studiosApi.removeMember).toHaveBeenCalledWith('acme', GUEST.id);
    });
  });
});

describe('MembersTab — transfer admin (confirm gate)', () => {
  it('requires confirmation before calling requestTransfer', async () => {
    const user = userEvent.setup();
    vi.mocked(studiosApi.requestTransfer).mockResolvedValueOnce({ ok: true });
    renderTab(
      <MembersTab
        slug='acme'
        members={[ADMIN, GUEST]}
        studioRole='admin'
        studioType='team' pendingInvitations={[]}
      />,
    );
    await user.click(screen.getByTestId(`member-row-menu-${GUEST.id}`));
    await user.click(
      await screen.findByTestId(`member-transfer-admin-${GUEST.id}`),
    );

    expect(studiosApi.requestTransfer).not.toHaveBeenCalled();
    const dialog = await screen.findByTestId('member-confirm-dialog');
    await user.click(within(dialog).getByTestId('member-confirm-action'));

    await waitFor(() => {
      expect(studiosApi.requestTransfer).toHaveBeenCalledWith('acme', {
        toUserId: GUEST.id,
      });
    });
    expect(toast.success).toHaveBeenCalled();
  });
});

describe('MembersTab — pending invitations', () => {
  it('shows the pending section with the invitee + role badge to an admin', () => {
    renderTab(
      <MembersTab
        slug='acme'
        members={[ADMIN]}
        studioRole='admin'
        studioType='team'
        pendingInvitations={[PENDING]}
      />,
    );
    expect(screen.getByText('Invited')).toBeInTheDocument();
    expect(screen.getByText(PENDING.name)).toBeInTheDocument();
    expect(screen.getByText(PENDING.email)).toBeInTheDocument();
    // pendingBadge = "{role} · pending" with the localized role label.
    expect(screen.getByText(/Guest · pending/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Revoke' })).toBeInTheDocument();
  });

  it('hides the pending section from a non-admin viewer', () => {
    renderTab(
      <MembersTab
        slug='acme'
        members={[ADMIN, GUEST]}
        studioRole='guest'
        studioType='team'
        pendingInvitations={[PENDING]}
      />,
    );
    expect(screen.queryByText('Invited')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Revoke' })).toBeNull();
  });

  it('clicking revoke calls revokeInvitation(slug, invitationId) + success toast', async () => {
    const user = userEvent.setup();
    vi.mocked(studiosApi.revokeInvitation).mockResolvedValueOnce({ ok: true });
    renderTab(
      <MembersTab
        slug='acme'
        members={[ADMIN]}
        studioRole='admin'
        studioType='team'
        pendingInvitations={[PENDING]}
      />,
    );
    await user.click(screen.getByRole('button', { name: 'Revoke' }));

    await waitFor(() => {
      expect(studiosApi.revokeInvitation).toHaveBeenCalledWith(
        'acme',
        PENDING.invitationId,
      );
    });
    expect(toast.success).toHaveBeenCalled();
  });
});

describe('MembersTab — a11y', () => {
  it('has no axe violations for an admin-managed team roster', async () => {
    const { container } = renderTab(
      <MembersTab
        slug='acme'
        members={[ADMIN, GUEST, MAINTAINER]}
        studioRole='admin'
        studioType='team' pendingInvitations={[]}
      />,
    );
    await expectNoA11yViolations(container);
  });
});
