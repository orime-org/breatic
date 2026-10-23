// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import type * as MockModule0 from '@web/data/api/project-invitations';
import type * as MockModule1 from '@web/lib/toast';

import type { ReactElement } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { t, type ProjectRole } from '@breatic/shared';
import { MemoryRouter } from 'react-router-dom';

import { ShareDialog } from '@web/pages/project/chrome/top-bar/ShareDialog';
import { TopBar } from '@web/pages/project/chrome/top-bar/TopBar';
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
const LONG_REGISTERED = {
  ...REGISTERED,
  email: 'registered-creative-production-team@example-production.test',
} as const;
const LONG_EMAIL = {
  ...EMAIL,
  email: 'unregistered-creative-production-team@example-production.test',
} as const;

/** Renders the real popover with its query and overlay providers. */
function setup(currentUserRole: ProjectRole = 'owner'): ReturnType<typeof render> {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false } } });
  const content: ReactElement = (
    <QueryClientProvider client={client}>
      <TooltipProvider><ShareDialog projectId={PROJECT_ID} currentUserRole={currentUserRole} /></TooltipProvider>
    </QueryClientProvider>
  );
  useUIStore.setState({ shareOpen: true });
  return render(content);
}

beforeEach(() => {
  vi.clearAllMocks();
  listPending.mockReset().mockResolvedValue([]);
  revoke.mockReset().mockResolvedValue({ ok: true });
  useCurrentUserStore.setState({ role: null });
});

describe('ShareDialog pending invitations', () => {
  it('loads pending invitations for a project Owner when the global role is null', async () => {
    listPending.mockResolvedValueOnce([EMAIL]);
    setup('owner');
    expect(useCurrentUserStore.getState().role).toBeNull();
    await waitFor(() => expect(listPending).toHaveBeenCalledWith(PROJECT_ID));
    expect(await screen.findByText(EMAIL.email)).toBeInTheDocument();
    expect(screen.getByText(t('share.pendingTitle'))).toBeInTheDocument();
  });

  it('receives the project Owner role through the real TopBar with a null global role', async () => {
    listPending.mockResolvedValueOnce([EMAIL]);
    useUIStore.setState({ shareOpen: true });
    const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false } } });
    render(
      <QueryClientProvider client={client}>
        <TooltipProvider>
          <MemoryRouter>
            <TopBar
              projectId={PROJECT_ID}
              projectName='Film'
              // eslint-disable-next-line jsx-a11y/aria-role -- component prop, not a DOM ARIA role
              role='owner'
              actualRole='owner'
              archived={false}
              canRename
              canLeave={false}
              credits={{ status: 'ready', value: 0 }}
              onRename={vi.fn()}
              members={[]}
            />
          </MemoryRouter>
        </TooltipProvider>
      </QueryClientProvider>,
    );
    expect(useCurrentUserStore.getState().role).toBeNull();
    await waitFor(() => expect(listPending).toHaveBeenCalledWith(PROJECT_ID));
    expect(await screen.findByText(EMAIL.email)).toBeInTheDocument();
  });

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

  it.each([
    ['ordinary', LONG_REGISTERED],
    ['mailbox', LONG_EMAIL],
  ] as const)('shows the complete %s invitation email on hover and closes it on pointer leave', async (_kind, invitation) => {
    listPending.mockResolvedValueOnce([invitation]);
    const user = userEvent.setup();
    setup();
    const email = await screen.findByText(invitation.email);

    await user.hover(email);

    expect((await screen.findByRole('tooltip')).textContent).toBe(invitation.email);
    await user.unhover(email);
    // Radix tracks a subsequent pointer move beyond its hoverable-content grace area.
    await user.pointer({ target: document.body, coords: { clientX: 100, clientY: 100 } });
    await waitFor(() => expect(screen.queryByRole('tooltip')).toBeNull());
    expect(revoke).not.toHaveBeenCalled();
  });

  it('shows both complete emails through Tab navigation and revokes the invitation selected by keyboard', async () => {
    listPending.mockResolvedValueOnce([LONG_REGISTERED, LONG_EMAIL]).mockResolvedValue([LONG_REGISTERED]);
    const user = userEvent.setup();
    setup();
    const registeredEmail = await screen.findByText(LONG_REGISTERED.email);
    const mailboxEmail = screen.getByText(LONG_EMAIL.email);
    const revokeButtons = screen.getAllByRole('button', { name: t('share.revoke') });
    expect(revokeButtons).toHaveLength(2);
    const [registeredRevoke, mailboxRevoke] = revokeButtons;

    await user.click(screen.getByTestId('share-invite-input'));
    await user.tab();
    await user.tab();

    expect(document.activeElement).toContainElement(registeredEmail);
    expect((await screen.findByRole('tooltip')).textContent).toBe(LONG_REGISTERED.email);

    await user.tab();
    expect(registeredRevoke).toHaveFocus();
    await waitFor(() => expect(screen.queryByRole('tooltip')).toBeNull());
    await user.tab();

    expect(document.activeElement).toContainElement(mailboxEmail);
    expect((await screen.findByRole('tooltip')).textContent).toBe(LONG_EMAIL.email);

    await user.tab();
    expect(mailboxRevoke).toHaveFocus();
    await user.keyboard('{Enter}');

    await waitFor(() => expect(revoke).toHaveBeenCalledWith(PROJECT_ID, LONG_EMAIL.invitationId));
    await waitFor(() => expect(screen.queryByText(LONG_EMAIL.email)).toBeNull());
    expect(screen.getByText(LONG_REGISTERED.email)).toBeInTheDocument();
  });

  it('omits the pending section when the server returns an empty list', async () => {
    setup();
    await waitFor(() => expect(listPending).toHaveBeenCalledWith(PROJECT_ID));
    expect(screen.queryByText(t('share.pendingTitle'))).toBeNull();
    expect(screen.queryByRole('button', { name: t('share.revoke') })).toBeNull();
  });

  it.each(['editor', 'viewer'] as const)('keeps the pending list unavailable to a project %s with a stale global Owner role', (role) => {
    useCurrentUserStore.setState({ role: 'owner' });
    listPending.mockResolvedValueOnce([EMAIL]);
    setup(role);
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
