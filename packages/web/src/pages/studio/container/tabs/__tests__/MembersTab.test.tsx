// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
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
  awaitingSignup: false,
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
    vi.mocked(studiosApi.inviteMember).mockResolvedValueOnce({ ok: true, pendingSignup: false });
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

  it('drops the server error once the email it was about is edited (inner#1652)', async () => {
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
    const email = within(dialog).getByLabelText('Email');
    await user.type(email, 'ghost@x.example');
    await user.click(within(dialog).getByRole('button', { name: 'Send invite' }));
    await within(dialog).findByTestId('invite-member-error');

    await user.clear(email);
    await user.type(email, 'bob');
    expect(within(dialog).queryByTestId('invite-member-error')).not.toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: 'Send invite' }));
    expect(within(dialog).getByText('Please enter a valid email address.')).toBeInTheDocument();
    expect(within(dialog).queryByTestId('invite-member-error')).not.toBeInTheDocument();
    expect(studiosApi.inviteMember).toHaveBeenCalledTimes(1);
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

  /**
   * Open the remove confirmation for the guest and press its confirm button.
   * @param user - The user-event session.
   * @returns The confirm button.
   */
  async function confirmRemove(
    user: ReturnType<typeof userEvent.setup>,
  ): Promise<HTMLElement> {
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
    const dialog = await screen.findByTestId('member-confirm-dialog');
    const confirm = within(dialog).getByTestId('member-confirm-action');
    await user.click(confirm);
    return confirm;
  }

  it('keeps the dialog open with a busy confirm while the removal is out, and closes it on success', async () => {
    const user = userEvent.setup();
    let answer: (value: { ok: true }) => void = () => {};
    vi.mocked(studiosApi.removeMember).mockReturnValueOnce(
      new Promise((resolve) => {
        answer = resolve;
      }),
    );
    const confirm = await confirmRemove(user);

    await waitFor(() => expect(confirm).toHaveAttribute('aria-busy', 'true'));
    expect(confirm).toHaveAttribute('aria-disabled', 'true');
    expect(screen.getByTestId('member-confirm-dialog')).toBeInTheDocument();

    answer({ ok: true });
    await waitFor(() =>
      expect(screen.queryByTestId('member-confirm-dialog')).toBeNull(),
    );
  });

  it('keeps the dialog open with confirm pressable again when the removal fails', async () => {
    const user = userEvent.setup();
    let refuse: (reason: Error) => void = () => {};
    vi.mocked(studiosApi.removeMember).mockReturnValueOnce(
      new Promise((_resolve, reject) => {
        refuse = reject;
      }),
    );
    const confirm = await confirmRemove(user);
    await waitFor(() => expect(confirm).toHaveAttribute('aria-busy', 'true'));

    refuse(new Error('nope'));
    await waitFor(() => expect(confirm).not.toHaveAttribute('aria-busy'));
    expect(screen.getByTestId('member-confirm-dialog')).toBeInTheDocument();
  });

  /**
   * Confirm removing the guest, dismiss that dialog with Esc while the
   * removal is still out, then open the remove confirmation for the
   * maintainer.
   * @param user - The user-event session.
   * @returns The resolver for the guest's removal and the maintainer's confirm button.
   */
  async function removeGuestThenOpenMaintainer(
    user: ReturnType<typeof userEvent.setup>,
  ): Promise<{ answer: (value: { ok: true }) => void; confirm: HTMLElement }> {
    let answer: (value: { ok: true }) => void = () => {};
    vi.mocked(studiosApi.removeMember).mockReturnValueOnce(
      new Promise((resolve) => {
        answer = resolve;
      }),
    );
    renderTab(
      <MembersTab
        slug='acme'
        members={[ADMIN, GUEST, MAINTAINER]}
        studioRole='admin'
        studioType='team' pendingInvitations={[]}
      />,
    );
    await user.click(screen.getByTestId(`member-row-menu-${GUEST.id}`));
    await user.click(await screen.findByTestId(`member-remove-${GUEST.id}`));
    const first = await screen.findByTestId('member-confirm-dialog');
    await user.click(within(first).getByTestId('member-confirm-action'));
    await waitFor(() => expect(studiosApi.removeMember).toHaveBeenCalledTimes(1));
    await user.keyboard('{Escape}');
    await waitFor(() =>
      expect(screen.queryByTestId('member-confirm-dialog')).toBeNull(),
    );

    await user.click(screen.getByTestId(`member-row-menu-${MAINTAINER.id}`));
    await user.click(await screen.findByTestId(`member-remove-${MAINTAINER.id}`));
    const second = await screen.findByTestId('member-confirm-dialog');
    expect(second).toHaveTextContent(MAINTAINER.name);
    return { answer, confirm: within(second).getByTestId('member-confirm-action') };
  }

  it('shows no wait on a second member\'s confirm while an earlier removal is out, and keeps it unpressable', async () => {
    const user = userEvent.setup();
    const { confirm } = await removeGuestThenOpenMaintainer(user);

    expect(confirm).not.toHaveAttribute('aria-busy');
    expect(confirm).toBeDisabled();
  });

  it('leaves a second member\'s confirm open when the earlier removal answers', async () => {
    const user = userEvent.setup();
    const { answer } = await removeGuestThenOpenMaintainer(user);

    answer({ ok: true });
    await waitFor(() =>
      expect(toast.success).toHaveBeenCalledWith(
        'Member removed.',
        expect.anything(),
      ),
    );
    expect(screen.queryByTestId('member-confirm-dialog')).toHaveTextContent(
      MAINTAINER.name,
    );
  });
});

// Transferring studio admin moved to the Settings tab (2026-07-08 decision A);
// its flow is covered by SettingsTab.test.tsx, not the per-member-row menu.

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

  it.each([
    ['succeeds', true],
    ['fails', false],
  ])('marks that row’s Revoke busy while the revoke is out, and clears it once it %s', async (_label, succeeds) => {
    const user = userEvent.setup();
    let settle: () => void = () => {};
    vi.mocked(studiosApi.revokeInvitation).mockReturnValueOnce(
      new Promise((resolve, reject) => {
        settle = succeeds ? () => resolve({ ok: true }) : () => reject(new Error('nope'));
      }),
    );
    renderTab(
      <MembersTab
        slug='acme'
        members={[ADMIN]}
        studioRole='admin'
        studioType='team'
        pendingInvitations={[PENDING]}
      />,
    );
    const revoke = screen.getByRole('button', { name: 'Revoke' });
    await user.click(revoke);

    await waitFor(() => expect(revoke).toHaveAttribute('aria-busy', 'true'));
    expect(revoke).toHaveAttribute('aria-disabled', 'true');

    settle();
    await waitFor(() => expect(revoke).not.toHaveAttribute('aria-busy'));
  });

  it('keeps the first Revoke busy when a second invitation is revoked before it answers', async () => {
    const user = userEvent.setup();
    const second: PendingInvitationSummary = {
      ...PENDING,
      invitationId: 'inv-2',
      invitedUserId: 'u-eve',
      name: 'Eve',
      email: 'eve@x.example',
    };
    const settlers: Map<string, () => void> = new Map();
    vi.mocked(studiosApi.revokeInvitation).mockImplementation(
      (_slug, invitationId) =>
        new Promise((resolve) => {
          settlers.set(invitationId, () => resolve({ ok: true }));
        }),
    );
    renderTab(
      <MembersTab
        slug='acme'
        members={[ADMIN]}
        studioRole='admin'
        studioType='team'
        pendingInvitations={[PENDING, second]}
      />,
    );
    const [revokeA, revokeB] = screen.getAllByRole('button', { name: 'Revoke' });
    await user.click(revokeA);
    await waitFor(() => expect(revokeA).toHaveAttribute('aria-busy', 'true'));
    await user.click(revokeB);

    await waitFor(() => expect(revokeB).toHaveAttribute('aria-busy', 'true'));
    expect(revokeA).toHaveAttribute('aria-busy', 'true');
    expect(revokeA).toHaveAttribute('aria-disabled', 'true');

    settlers.get(PENDING.invitationId)?.();
    await waitFor(() => expect(revokeA).not.toHaveAttribute('aria-busy'));
    expect(revokeA).not.toHaveAttribute('aria-disabled');
    expect(revokeB).toHaveAttribute('aria-busy', 'true');

    settlers.get(second.invitationId)?.();
    await waitFor(() => expect(revokeB).not.toHaveAttribute('aria-busy'));
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

describe('MembersTab — joined date', () => {
  const REAL_TZ = process.env['TZ'];
  afterEach(() => {
    if (REAL_TZ === undefined) delete process.env['TZ'];
    else process.env['TZ'] = REAL_TZ;
  });

  it('shows the day the member joined in the timezone of the reader', () => {
    // 23:00 UTC on 2 April is already 3 April in Shanghai.
    process.env['TZ'] = 'Asia/Shanghai';
    renderTab(
      <MembersTab
        slug='acme'
        members={[ADMIN, { ...GUEST, joinedAt: '2026-04-02T23:00:00.000Z' }]}
        studioRole='admin'
        studioType='team'
        pendingInvitations={[]}
      />,
    );
    expect(screen.getByText('2026-04-03')).toBeInTheDocument();
    expect(screen.queryByText('2026-04-02')).toBeNull();
  });
});
