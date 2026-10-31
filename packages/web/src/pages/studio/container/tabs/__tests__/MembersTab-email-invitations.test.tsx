// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import type * as MockModule0 from '@web/data/api/studios';
import type * as MockModule1 from '@web/lib/toast';

import type { ComponentProps, ReactElement } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { t } from '@breatic/shared';

import { MembersTab } from '@web/pages/studio/container/tabs/MembersTab';
import type { StudioMember } from '@web/pages/studio/container/container-types';
import { studiosApi } from '@web/data/api/studios';
import { toast } from '@web/lib/toast';

vi.mock('@web/data/api/studios', async (importOriginal) => {
  const actual = await importOriginal<typeof MockModule0>();
  return { ...actual, studiosApi: { ...actual.studiosApi, inviteMember: vi.fn(), revokeInvitation: vi.fn() } };
});
vi.mock('@web/lib/toast', async (importOriginal) => {
  const actual = await importOriginal<typeof MockModule1>();
  return { ...actual, toast: { ...actual.toast, success: vi.fn(), error: vi.fn() } };
});

const ADMIN: StudioMember = {
  id: 'admin', name: 'Administrator', email: 'admin@example.test', avatarUrl: null,
  studioRole: 'admin', joinedAt: '2026-01-01T00:00:00.000Z',
};
const EMAIL = {
  invitationId: 'email-invitation', invitedUserId: null, name: '', email: 'unregistered@example.test',
  avatarUrl: null, role: 'guest', invitedByName: 'Administrator', expiresAt: '2099-01-01T00:00:00.000Z', awaitingSignup: true,
} as const;
const REGISTERED = {
  ...EMAIL, invitationId: 'registered-invitation', invitedUserId: 'registered', name: 'Recipient',
  email: 'registered@example.test', awaitingSignup: false,
} as const;

/** Renders the real Studio member-management surface. */
function setup(pendingInvitations: ComponentProps<typeof MembersTab>['pendingInvitations'] = [EMAIL, REGISTERED]): ReturnType<typeof render> {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false } } });
  const content: ReactElement = <MembersTab slug='team-studio' members={[ADMIN]} studioRole='admin' studioType='team' pendingInvitations={pendingInvitations} />;
  return render(<QueryClientProvider client={client}>{content}</QueryClientProvider>);
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(studiosApi.revokeInvitation).mockResolvedValue({ ok: true });
});

describe('Studio email invitation display', () => {
  it('labels an email invitation as awaiting registration and uses the email initial', () => {
    setup([EMAIL]);
    expect(screen.getByText(EMAIL.email)).toBeInTheDocument();
    expect(screen.getByText('U', { exact: true })).toBeInTheDocument();
    expect(screen.getByText(t('studio.container.members.awaitingSignup'), { exact: false })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Revoke' })).toBeEnabled();
  });

  it('keeps ordinary invitations on their pending-confirmation label', () => {
    setup([REGISTERED]);
    expect(screen.getByText(REGISTERED.name)).toBeInTheDocument();
    expect(screen.getByText(REGISTERED.email)).toBeInTheDocument();
    expect(screen.getByText(t('studio.container.members.pendingBadge', { role: 'Guest' }))).toBeInTheDocument();
    expect(screen.queryByText(t('studio.container.members.awaitingSignup'), { exact: false })).toBeNull();
  });

  it('revokes an email invitation by its invitation id', async () => {
    const user = userEvent.setup();
    setup([EMAIL]);
    await user.click(screen.getByRole('button', { name: 'Revoke' }));
    await waitFor(() => expect(studiosApi.revokeInvitation).toHaveBeenCalledWith('team-studio', EMAIL.invitationId));
    expect(toast.success).toHaveBeenCalledWith(t('studio.container.members.revokeSuccess'));
  });
});

describe('Studio invitation delivery feedback', () => {
  it.each([true, false])('shows the matching result for pendingSignup=%s and closes the invite dialog', async (pendingSignup) => {
    vi.mocked(studiosApi.inviteMember).mockResolvedValueOnce({ ok: true, pendingSignup });
    const user = userEvent.setup();
    setup([]);
    await user.click(screen.getByRole('button', { name: 'Invite member' }));
    const dialog = await screen.findByTestId('invite-member-dialog');
    await user.type(within(dialog).getByLabelText('Email'), EMAIL.email);
    await user.click(within(dialog).getByRole('button', { name: 'Send invite' }));
    const message = pendingSignup
      ? t('studio.container.members.inviteSentPendingSignup', { email: EMAIL.email })
      : t('studio.container.members.inviteSent');
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith(message));
    await waitFor(() => expect(screen.queryByTestId('invite-member-dialog')).toBeNull());
  });
});
