// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import type * as MockModule0 from '@web/data/api/project-invitations';
import type * as MockModule1 from '@web/lib/toast';

import type { ReactElement } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { t } from '@breatic/shared';

import { ShareDialog } from '@web/pages/project/chrome/top-bar/ShareDialog';
import { TooltipProvider } from '@web/components/ui/tooltip';
import { useCurrentUserStore, useUIStore } from '@web/stores';
import { projectInvitationsApi } from '@web/data/api/project-invitations';
import { toast } from '@web/lib/toast';
import { ApiException } from '@web/data/api/types';

const { listPending, revoke } = vi.hoisted(() => ({ listPending: vi.fn(), revoke: vi.fn() }));
vi.mock('@web/data/api/project-invitations', async (importOriginal) => {
  const actual = await importOriginal<typeof MockModule0>();
  return { ...actual, projectInvitationsApi: { ...actual.projectInvitationsApi, inviteMember: vi.fn(), listPending, revoke } };
});
vi.mock('@web/lib/toast', async (importOriginal) => {
  const actual = await importOriginal<typeof MockModule1>();
  return { ...actual, toast: { ...actual.toast, success: vi.fn(), error: vi.fn() } };
});

const PROJECT_ID = '11111111-1111-4111-8111-111111111111';
const REGISTERED = {
  invitationId: 'registered-invitation', invitedUserId: 'registered-user', name: 'Recipient',
  email: 'registered@example.test', avatarUrl: null, role: 'viewer', invitedByName: 'Owner',
  expiresAt: '2099-01-01T00:00:00.000Z', awaitingSignup: false,
} as const;
const EMAIL = {
  ...REGISTERED, invitationId: 'email-invitation', invitedUserId: null, name: '',
  email: 'unregistered@example.test', role: 'editor', awaitingSignup: true,
} as const;

/** Renders the real popover with its query and overlay providers. */
function setup(): ReturnType<typeof render> {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false } } });
  const content: ReactElement = (
    <QueryClientProvider client={client}>
      <TooltipProvider><ShareDialog projectId={PROJECT_ID} /></TooltipProvider>
    </QueryClientProvider>
  );
  useUIStore.setState({ shareOpen: true });
  return render(content);
}

beforeEach(() => {
  vi.clearAllMocks();
  listPending.mockReset().mockResolvedValue([]);
  revoke.mockReset().mockResolvedValue({ ok: true });
  useCurrentUserStore.setState({ role: 'owner' });
});

describe('ShareDialog pending invitations', () => {
  it('shows ordinary and email invitations with their corresponding pending labels', async () => {
    listPending.mockResolvedValueOnce([REGISTERED, EMAIL]);
    setup();
    expect(await screen.findByText(REGISTERED.email)).toBeInTheDocument();
    expect(screen.getByText(REGISTERED.name)).toBeInTheDocument();
    expect(screen.getByText(EMAIL.email)).toBeInTheDocument();
    expect(screen.getByText(t('share.pendingTitle'))).toBeInTheDocument();
    expect(screen.getByText(t('share.pendingBadge', { role: t('share.role.view') }))).toBeInTheDocument();
    expect(screen.getByText(t('share.awaitingSignup'), { exact: false })).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: t('share.revoke') })).toHaveLength(2);
  });

  it('omits the pending section when the server returns an empty list', async () => {
    setup();
    await waitFor(() => expect(listPending).toHaveBeenCalledWith(PROJECT_ID));
    expect(screen.queryByText(t('share.pendingTitle'))).toBeNull();
    expect(screen.queryByRole('button', { name: t('share.revoke') })).toBeNull();
  });

  it('keeps the pending list Owner-only', () => {
    useCurrentUserStore.setState({ role: 'editor' });
    listPending.mockResolvedValueOnce([EMAIL]);
    setup();
    expect(listPending).not.toHaveBeenCalled();
    expect(screen.queryByText(t('share.pendingTitle'))).toBeNull();
    expect(screen.queryByText(EMAIL.email)).toBeNull();
  });

  it('revokes the selected email invitation and refreshes its pending list', async () => {
    listPending.mockResolvedValueOnce([EMAIL]).mockResolvedValue([]);
    const user = userEvent.setup();
    setup();
    await screen.findByText(EMAIL.email);
    await user.click(screen.getByRole('button', { name: t('share.revoke') }));
    await waitFor(() => expect(revoke).toHaveBeenCalledWith(PROJECT_ID, EMAIL.invitationId));
    await waitFor(() => expect(screen.queryByText(EMAIL.email)).toBeNull());
    expect(toast.success).toHaveBeenCalledWith(t('share.revokeSuccess'));
  });

  it('keeps a refused revoke visible and reports the server message', async () => {
    listPending.mockResolvedValue([EMAIL]);
    revoke.mockRejectedValueOnce(new ApiException({ status: 409, message: 'The invitation has already changed.' }));
    const user = userEvent.setup();
    setup();
    await screen.findByText(EMAIL.email);
    await user.click(screen.getByRole('button', { name: t('share.revoke') }));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('The invitation has already changed.'));
    expect(screen.getByText(EMAIL.email)).toBeInTheDocument();
  });

  it('tracks the revoke wait on its own row while another invitation is revoked', async () => {
    let answerFirst: (value: { ok: true }) => void = () => {};
    listPending.mockResolvedValue([REGISTERED, EMAIL]);
    revoke.mockImplementation((_project: string, id: string) => id === REGISTERED.invitationId
      ? new Promise<{ ok: true }>((resolve) => { answerFirst = resolve; })
      : Promise.resolve({ ok: true }));
    const user = userEvent.setup();
    setup();
    await screen.findByText(REGISTERED.email);
    const buttons = screen.getAllByRole('button', { name: t('share.revoke') });
    expect(buttons).toHaveLength(2);
    const [first, second] = buttons;
    await user.click(first);
    await waitFor(() => expect(first).toHaveAttribute('aria-busy', 'true'));
    await user.click(second);
    await waitFor(() => expect(revoke).toHaveBeenCalledTimes(2));
    expect(first).toHaveAttribute('aria-busy', 'true');
    answerFirst({ ok: true });
    await waitFor(() => expect(first).not.toHaveAttribute('aria-busy'));
  });
});

describe('ShareDialog invitation delivery feedback', () => {
  it.each([true, false])('uses the matching success message for pendingSignup=%s', async (pendingSignup) => {
    vi.mocked(projectInvitationsApi.inviteMember).mockResolvedValueOnce({ ok: true, pendingSignup });
    const user = userEvent.setup();
    setup();
    await user.type(screen.getByTestId('share-invite-input'), EMAIL.email);
    await user.click(screen.getByTestId('share-send-invite'));
    const message = pendingSignup ? t('share.inviteSentPendingSignup', { email: EMAIL.email }) : t('share.inviteSent');
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith(message));
    expect(useUIStore.getState().shareOpen).toBe(false);
  });
});
