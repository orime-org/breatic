// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';

import { BellMenu } from '@web/features/notifications/BellMenu';
import { TooltipProvider } from '@web/components/ui/tooltip';
import { ApiException } from '@web/data/api/types';
import { useCurrentUserStore } from '@web/stores';

// The project invite bell row navigates to the `/project-invite` landing page
// instead of confirming inline; spy on react-router's navigate to assert it.
const navigateMock = vi.fn();
vi.mock('react-router-dom', async () => {
  const actual =
    await vi.importActual<typeof import('react-router-dom')>('react-router-dom');
  return { ...actual, useNavigate: () => navigateMock };
});

const SELF = {
  id: 'u-self',
  name: 'Self',
  email: 'self@x.example',
  personalStudio: null,
};

const PID = '11111111-1111-4111-8111-111111111111';
const N1 = '22222222-2222-4222-8222-222222222222';
const N2 = '33333333-3333-4333-8333-333333333333';

vi.mock('@web/data/api/notifications', () => ({
  notificationsApi: {
    list: vi.fn(),
    count: vi.fn(),
    markRead: vi.fn(),
    markAllRead: vi.fn(),
    respondAction: vi.fn(),
  },
}));

vi.mock('@web/data/api/role-upgrade-requests', () => ({
  roleUpgradeRequestsApi: {
    submit: vi.fn(),
    decide: vi.fn(),
  },
}));

vi.mock('sonner', () => ({
  toast: Object.assign(vi.fn(), {
    success: vi.fn(),
    error: vi.fn(),
  }),
}));

import { notificationsApi } from '@web/data/api/notifications';
import { roleUpgradeRequestsApi } from '@web/data/api/role-upgrade-requests';
import { toast } from 'sonner';

function setup() {
  const qc = new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: 0 },
      mutations: { retry: false },
    },
  });
  return render(
    <MemoryRouter>
      <QueryClientProvider client={qc}>
        <TooltipProvider>
          <BellMenu />
        </TooltipProvider>
      </QueryClientProvider>
    </MemoryRouter>,
  );
}

type NotifType =
  | 'access.role_upgrade_request'
  | 'access.role_upgrade_approved'
  | 'access.role_upgrade_rejected'
  | 'studio.member_invited'
  | 'studio.transfer_request'
  | 'studio.transfer_approved'
  | 'studio.invite_request'
  | 'studio.invite_accepted'
  | 'project.invite_request'
  | 'project.invite_accepted';

function fakeNotification(
  id: string,
  type: NotifType,
  payload: Record<string, unknown> = {},
  overrides: { expiresAt?: string | null } = {},
) {
  return {
    id,
    userId: 'u-self',
    type,
    payload,
    projectId: PID,
    readAt: null,
    expiresAt: overrides.expiresAt ?? null,
    createdAt: new Date(Date.now() - 5 * 60_000).toISOString(),
    updatedAt: new Date(Date.now() - 5 * 60_000).toISOString(),
    deletedAt: null,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  // A known user — the inbox query is gated on `userId`, so without this the
  // query stays disabled and nothing renders.
  useCurrentUserStore.setState({ user: SELF });
  vi.mocked(notificationsApi.list).mockResolvedValue([]);
});

describe('BellMenu — empty list', () => {
  it('shows empty-state copy when there are no notifications', async () => {
    const user = userEvent.setup();
    setup();
    await user.click(screen.getByTestId('bell-trigger'));
    expect(await screen.findByTestId('bell-popover')).toBeInTheDocument();
    expect(screen.getByText(/No pending notifications/i)).toBeInTheDocument();
  });
});

describe('BellMenu — auth gate (boot-race, #1261)', () => {
  it('does not fetch notifications until a user is known', async () => {
    const user = userEvent.setup();
    useCurrentUserStore.setState({ user: null });
    setup();
    await user.click(screen.getByTestId('bell-trigger'));
    expect(await screen.findByTestId('bell-popover')).toBeInTheDocument();
    // The query is gated on userId — it must NOT fire (and cache an empty list)
    // before the /auth/me boot ping resolves.
    expect(notificationsApi.list).not.toHaveBeenCalled();
    expect(screen.getByText(/No pending notifications/i)).toBeInTheDocument();
  });

  it('fetches once a user becomes known', async () => {
    useCurrentUserStore.setState({ user: SELF });
    setup();
    await waitFor(() => {
      expect(notificationsApi.list).toHaveBeenCalled();
    });
  });
});

describe('BellMenu — 4 notification types render', () => {
  it('renders one row per notification with the right headline + action affordance', async () => {
    const user = userEvent.setup();
    vi.mocked(notificationsApi.list).mockResolvedValueOnce([
      fakeNotification(N1, 'access.role_upgrade_request', {
        projectName: 'Q1 Sprint',
        message: 'Need editor for review',
      }),
      fakeNotification(N2, 'studio.member_invited', {
        studioName: 'Acme',
        inviterName: 'Alex',
        role: 'member',
      }),
    ]);
    setup();
    await user.click(screen.getByTestId('bell-trigger'));

    expect(
      await screen.findByTestId(`bell-notification-${N1}`),
    ).toBeInTheDocument();
    // Upgrade-request rows expose approve / reject buttons.
    expect(screen.getByTestId(`bell-approve-${N1}`)).toBeInTheDocument();
    expect(screen.getByTestId(`bell-reject-${N1}`)).toBeInTheDocument();
    // Non-decision rows expose a mark-read affordance.
    expect(screen.getByTestId(`bell-mark-read-${N2}`)).toBeInTheDocument();
  });

  it('badge dot appears when unread count > 0', async () => {
    vi.mocked(notificationsApi.list).mockResolvedValueOnce([
      fakeNotification(N1, 'access.role_upgrade_approved', {
        projectName: 'Demo',
      }),
    ]);
    setup();
    await waitFor(() => {
      expect(screen.getByTestId('bell-unread-dot')).toBeInTheDocument();
    });
  });
});

describe('BellMenu — approve / reject mutations on upgrade-request rows', () => {
  it('clicking approve calls roleUpgradeRequestsApi.decide(approved)', async () => {
    const user = userEvent.setup();
    vi.mocked(notificationsApi.list).mockResolvedValueOnce([
      fakeNotification(N1, 'access.role_upgrade_request', {
        projectName: 'Demo',
      }),
    ]);
    vi.mocked(roleUpgradeRequestsApi.decide).mockResolvedValueOnce({ ok: true });
    setup();
    await user.click(screen.getByTestId('bell-trigger'));
    await user.click(await screen.findByTestId(`bell-approve-${N1}`));

    await waitFor(() => {
      expect(roleUpgradeRequestsApi.decide).toHaveBeenCalledWith(N1, {
        decision: 'approved',
      });
    });
    expect(toast.success).toHaveBeenCalled();
  });

  it('clicking reject calls decide(rejected) + success toast', async () => {
    const user = userEvent.setup();
    vi.mocked(notificationsApi.list).mockResolvedValueOnce([
      fakeNotification(N1, 'access.role_upgrade_request', {
        projectName: 'Demo',
      }),
    ]);
    vi.mocked(roleUpgradeRequestsApi.decide).mockResolvedValueOnce({ ok: true });
    setup();
    await user.click(screen.getByTestId('bell-trigger'));
    await user.click(await screen.findByTestId(`bell-reject-${N1}`));

    await waitFor(() => {
      expect(roleUpgradeRequestsApi.decide).toHaveBeenCalledWith(N1, {
        decision: 'rejected',
      });
    });
    expect(toast.success).toHaveBeenCalled();
  });

  it('toasts error when decide rejects', async () => {
    const user = userEvent.setup();
    vi.mocked(notificationsApi.list).mockResolvedValueOnce([
      fakeNotification(N1, 'access.role_upgrade_request', {
        projectName: 'Demo',
      }),
    ]);
    vi.mocked(roleUpgradeRequestsApi.decide).mockRejectedValueOnce(
      new ApiException({
        status: 409,
        code: 'CONFLICT',
        message: 'Already reviewed',
      }),
    );
    setup();
    await user.click(screen.getByTestId('bell-trigger'));
    await user.click(await screen.findByTestId(`bell-approve-${N1}`));

    await waitFor(() => {
      expect(toast.error).toHaveBeenCalledWith('Already reviewed');
    });
  });
});

describe('BellMenu — mark-read affordance on non-decision rows', () => {
  it('clicking mark-read calls notificationsApi.markRead(id)', async () => {
    const user = userEvent.setup();
    vi.mocked(notificationsApi.list).mockResolvedValueOnce([
      fakeNotification(N2, 'studio.member_invited', {
        studioName: 'Demo',
        inviterName: 'Alex',
        role: 'member',
      }),
    ]);
    vi.mocked(notificationsApi.markRead).mockResolvedValueOnce({ ok: true });
    setup();
    await user.click(screen.getByTestId('bell-trigger'));
    await user.click(await screen.findByTestId(`bell-mark-read-${N2}`));

    await waitFor(() => {
      expect(notificationsApi.markRead).toHaveBeenCalledWith(N2);
    });
  });
});

describe('BellMenu — studio notification types (slice 3)', () => {
  it('renders member_invited as a read-on-click row (no confirm/cancel)', async () => {
    const user = userEvent.setup();
    vi.mocked(notificationsApi.list).mockResolvedValueOnce([
      fakeNotification(N1, 'studio.member_invited', {
        studioName: 'Acme',
        inviterName: 'Alex',
        role: 'creator',
      }),
    ]);
    setup();
    await user.click(screen.getByTestId('bell-trigger'));

    expect(
      await screen.findByTestId(`bell-notification-${N1}`),
    ).toBeInTheDocument();
    expect(screen.getByText(/You were added to Acme/i)).toBeInTheDocument();
    expect(screen.getByText(/Joined as a creator/i)).toBeInTheDocument();
    // Informational — mark-read affordance, not confirm/cancel.
    expect(screen.getByTestId(`bell-mark-read-${N1}`)).toBeInTheDocument();
    expect(screen.queryByTestId(`bell-confirm-${N1}`)).toBeNull();
  });

  it('renders transfer_request with confirm/cancel + a TTL countdown', async () => {
    const user = userEvent.setup();
    const expiresAt = new Date(Date.now() + 3 * 24 * 60 * 60 * 1000).toISOString();
    vi.mocked(notificationsApi.list).mockResolvedValueOnce([
      fakeNotification(
        N1,
        'studio.transfer_request',
        { studioName: 'Acme', fromUserId: 'u-admin', studioId: 's1' },
        { expiresAt },
      ),
    ]);
    setup();
    await user.click(screen.getByTestId('bell-trigger'));

    expect(
      await screen.findByText(/You were asked to take over Acme/i),
    ).toBeInTheDocument();
    expect(screen.getByTestId(`bell-confirm-${N1}`)).toBeInTheDocument();
    expect(screen.getByTestId(`bell-cancel-${N1}`)).toBeInTheDocument();
    // The TTL countdown replaces the "x ago" label for actionable transfers.
    expect(screen.getByText(/expires in 3d/i)).toBeInTheDocument();
  });

  it('confirm calls respondAction(id, confirm) + success toast', async () => {
    const user = userEvent.setup();
    vi.mocked(notificationsApi.list).mockResolvedValueOnce([
      fakeNotification(
        N1,
        'studio.transfer_request',
        { studioName: 'Acme', fromUserId: 'u-admin', studioId: 's1' },
        { expiresAt: new Date(Date.now() + 86_400_000).toISOString() },
      ),
    ]);
    vi.mocked(notificationsApi.respondAction).mockResolvedValueOnce({ ok: true });
    setup();
    await user.click(screen.getByTestId('bell-trigger'));
    await user.click(await screen.findByTestId(`bell-confirm-${N1}`));

    await waitFor(() => {
      expect(notificationsApi.respondAction).toHaveBeenCalledWith(N1, 'confirm');
    });
    // A transfer confirm makes the recipient the admin — the admin toast.
    expect(toast.success).toHaveBeenCalledWith('You are now the studio admin.');
  });

  it('cancel calls respondAction(id, cancel)', async () => {
    const user = userEvent.setup();
    vi.mocked(notificationsApi.list).mockResolvedValueOnce([
      fakeNotification(
        N1,
        'studio.transfer_request',
        { studioName: 'Acme', fromUserId: 'u-admin', studioId: 's1' },
        { expiresAt: new Date(Date.now() + 86_400_000).toISOString() },
      ),
    ]);
    vi.mocked(notificationsApi.respondAction).mockResolvedValueOnce({ ok: true });
    setup();
    await user.click(screen.getByTestId('bell-trigger'));
    await user.click(await screen.findByTestId(`bell-cancel-${N1}`));

    await waitFor(() => {
      expect(notificationsApi.respondAction).toHaveBeenCalledWith(N1, 'cancel');
    });
  });

  it('toasts the server error when respondAction rejects', async () => {
    const user = userEvent.setup();
    vi.mocked(notificationsApi.list).mockResolvedValueOnce([
      fakeNotification(
        N1,
        'studio.transfer_request',
        { studioName: 'Acme', fromUserId: 'u-admin', studioId: 's1' },
        { expiresAt: new Date(Date.now() + 86_400_000).toISOString() },
      ),
    ]);
    vi.mocked(notificationsApi.respondAction).mockRejectedValueOnce(
      new ApiException({ status: 409, code: 'CONFLICT', message: 'Request expired' }),
    );
    setup();
    await user.click(screen.getByTestId('bell-trigger'));
    await user.click(await screen.findByTestId(`bell-confirm-${N1}`));

    await waitFor(() => {
      expect(toast.error).toHaveBeenCalledWith('Request expired');
    });
  });

  it('renders transfer_approved as a read-on-click row', async () => {
    const user = userEvent.setup();
    vi.mocked(notificationsApi.list).mockResolvedValueOnce([
      fakeNotification(N2, 'studio.transfer_approved', { studioName: 'Acme' }),
    ]);
    setup();
    await user.click(screen.getByTestId('bell-trigger'));

    expect(
      await screen.findByText(/Your admin transfer for Acme was accepted/i),
    ).toBeInTheDocument();
    expect(screen.getByTestId(`bell-mark-read-${N2}`)).toBeInTheDocument();
  });
});

describe('BellMenu — studio invite-confirm handshake', () => {
  it('renders invite_request with confirm/cancel + role subtitle + TTL countdown', async () => {
    const user = userEvent.setup();
    const expiresAt = new Date(
      Date.now() + 3 * 24 * 60 * 60 * 1000,
    ).toISOString();
    vi.mocked(notificationsApi.list).mockResolvedValueOnce([
      fakeNotification(
        N1,
        'studio.invite_request',
        {
          invitationId: 'inv-1',
          studioId: 's1',
          studioName: 'Acme',
          inviterName: 'Alex',
          role: 'creator',
        },
        { expiresAt },
      ),
    ]);
    setup();
    await user.click(screen.getByTestId('bell-trigger'));

    expect(
      await screen.findByText(/You were invited to join Acme/i),
    ).toBeInTheDocument();
    // Subtitle reuses the granted-role label (invitedAsCreator).
    expect(screen.getByText(/Joined as a creator/i)).toBeInTheDocument();
    // Actionable like the transfer handshake: confirm / cancel + a countdown.
    expect(screen.getByTestId(`bell-confirm-${N1}`)).toBeInTheDocument();
    expect(screen.getByTestId(`bell-cancel-${N1}`)).toBeInTheDocument();
    expect(screen.getByText(/expires in 3d/i)).toBeInTheDocument();
  });

  it('confirm calls respondAction(id, confirm) + success toast', async () => {
    const user = userEvent.setup();
    vi.mocked(notificationsApi.list).mockResolvedValueOnce([
      fakeNotification(
        N1,
        'studio.invite_request',
        { invitationId: 'inv-1', studioName: 'Acme', role: 'member' },
        { expiresAt: new Date(Date.now() + 86_400_000).toISOString() },
      ),
    ]);
    vi.mocked(notificationsApi.respondAction).mockResolvedValueOnce({ ok: true });
    setup();
    await user.click(screen.getByTestId('bell-trigger'));
    await user.click(await screen.findByTestId(`bell-confirm-${N1}`));

    await waitFor(() => {
      expect(notificationsApi.respondAction).toHaveBeenCalledWith(N1, 'confirm');
    });
    // An invite confirm joins as a member — the join toast, NOT the admin one.
    expect(toast.success).toHaveBeenCalledWith('You\'ve joined the studio.');
  });

  it('cancel calls respondAction(id, cancel)', async () => {
    const user = userEvent.setup();
    vi.mocked(notificationsApi.list).mockResolvedValueOnce([
      fakeNotification(
        N1,
        'studio.invite_request',
        { invitationId: 'inv-1', studioName: 'Acme', role: 'member' },
        { expiresAt: new Date(Date.now() + 86_400_000).toISOString() },
      ),
    ]);
    vi.mocked(notificationsApi.respondAction).mockResolvedValueOnce({ ok: true });
    setup();
    await user.click(screen.getByTestId('bell-trigger'));
    await user.click(await screen.findByTestId(`bell-cancel-${N1}`));

    await waitFor(() => {
      expect(notificationsApi.respondAction).toHaveBeenCalledWith(N1, 'cancel');
    });
  });

  it('renders invite_accepted as a read-on-click row', async () => {
    const user = userEvent.setup();
    vi.mocked(notificationsApi.list).mockResolvedValueOnce([
      fakeNotification(N2, 'studio.invite_accepted', {
        studioName: 'Acme',
        inviteeName: 'Dee',
      }),
    ]);
    setup();
    await user.click(screen.getByTestId('bell-trigger'));

    expect(
      await screen.findByText(/Dee accepted your invite to Acme/i),
    ).toBeInTheDocument();
    expect(screen.getByTestId(`bell-mark-read-${N2}`)).toBeInTheDocument();
  });
});

describe('BellMenu — project invite navigates to the landing page (#1337)', () => {
  it('renders project.invite_request as a clickable row (no inline confirm/cancel) + role subtitle + TTL countdown', async () => {
    const user = userEvent.setup();
    const expiresAt = new Date(
      Date.now() + 3 * 24 * 60 * 60 * 1000,
    ).toISOString();
    vi.mocked(notificationsApi.list).mockResolvedValueOnce([
      fakeNotification(
        N1,
        'project.invite_request',
        {
          invitationId: 'inv-1',
          projectId: 'p1',
          projectName: 'Q1 Sprint',
          inviterName: 'Alex',
          role: 'editor',
          token: 'tok-abc',
        },
        { expiresAt },
      ),
    ]);
    setup();
    await user.click(screen.getByTestId('bell-trigger'));

    expect(
      await screen.findByText(/You were invited to join Q1 Sprint/i),
    ).toBeInTheDocument();
    // Subtitle reuses the granted-role label (invitedAsEditor).
    expect(screen.getByText(/Joined as an editor/i)).toBeInTheDocument();
    // The TTL countdown still shows for the live invite.
    expect(screen.getByText(/expires in 3d/i)).toBeInTheDocument();
    // Diverges from studio: the row links OUT to the landing page, so there is
    // NO inline confirm/cancel (confirm/decline happen on `/project-invite`).
    expect(screen.queryByTestId(`bell-confirm-${N1}`)).toBeNull();
    expect(screen.queryByTestId(`bell-cancel-${N1}`)).toBeNull();
    // It exposes a single open-invite affordance instead.
    expect(screen.getByTestId(`bell-open-invite-${N1}`)).toBeInTheDocument();
  });

  it('clicking the row navigates to /project-invite?token=… and closes the popover', async () => {
    const user = userEvent.setup();
    vi.mocked(notificationsApi.list).mockResolvedValueOnce([
      fakeNotification(
        N1,
        'project.invite_request',
        {
          invitationId: 'inv-1',
          projectName: 'Q1 Sprint',
          role: 'viewer',
          token: 'tok-xyz',
        },
        { expiresAt: new Date(Date.now() + 86_400_000).toISOString() },
      ),
    ]);
    setup();
    await user.click(screen.getByTestId('bell-trigger'));
    await user.click(await screen.findByTestId(`bell-open-invite-${N1}`));

    await waitFor(() => {
      expect(navigateMock).toHaveBeenCalledWith(
        '/project-invite?token=tok-xyz',
      );
    });
    // It must NOT route through the inline confirm/cancel endpoint.
    expect(notificationsApi.respondAction).not.toHaveBeenCalled();
  });

  it('renders project.invite_accepted as a read-on-click row', async () => {
    const user = userEvent.setup();
    vi.mocked(notificationsApi.list).mockResolvedValueOnce([
      fakeNotification(N2, 'project.invite_accepted', {
        projectName: 'Q1 Sprint',
        inviteeName: 'Dee',
      }),
    ]);
    setup();
    await user.click(screen.getByTestId('bell-trigger'));

    expect(
      await screen.findByText(/Dee accepted your invite to Q1 Sprint/i),
    ).toBeInTheDocument();
    expect(screen.getByTestId(`bell-mark-read-${N2}`)).toBeInTheDocument();
  });
});
