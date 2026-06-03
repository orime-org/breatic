// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

import { BellMenu } from '@web/pages/project/chrome/top-bar/BellMenu';
import { TooltipProvider } from '@web/components/ui/tooltip';
import { ApiException } from '@web/data/api/types';

const PID = '11111111-1111-4111-8111-111111111111';
const N1 = '22222222-2222-4222-8222-222222222222';
const N2 = '33333333-3333-4333-8333-333333333333';

vi.mock('@web/data/api/notifications', () => ({
  notificationsApi: {
    list: vi.fn(),
    count: vi.fn(),
    markRead: vi.fn(),
    markAllRead: vi.fn(),
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
    <QueryClientProvider client={qc}>
      <TooltipProvider>
        <BellMenu projectId={PID} />
      </TooltipProvider>
    </QueryClientProvider>,
  );
}

type NotifType =
  | 'access.role_upgrade_request'
  | 'access.role_upgrade_approved'
  | 'access.role_upgrade_rejected'
  | 'access.member_joined';

function fakeNotification(
  id: string,
  type: NotifType,
  payload: Record<string, unknown> = {},
) {
  return {
    id,
    userId: 'u-self',
    type,
    payload,
    projectId: PID,
    readAt: null,
    createdAt: new Date(Date.now() - 5 * 60_000).toISOString(),
    updatedAt: new Date(Date.now() - 5 * 60_000).toISOString(),
    deletedAt: null,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(notificationsApi.list).mockResolvedValue({ data: [] });
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

describe('BellMenu — 4 notification types render', () => {
  it('renders one row per notification with the right headline + action affordance', async () => {
    const user = userEvent.setup();
    vi.mocked(notificationsApi.list).mockResolvedValueOnce({
      data: [
        fakeNotification(N1, 'access.role_upgrade_request', {
          projectName: 'Q1 Sprint',
          message: 'Need editor for review',
        }),
        fakeNotification(N2, 'access.member_joined', {
          projectName: 'Q1 Sprint',
          newMemberUserId: 'u-newcomer',
          role: 'edit',
        }),
      ],
    });
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
    vi.mocked(notificationsApi.list).mockResolvedValueOnce({
      data: [
        fakeNotification(N1, 'access.role_upgrade_approved', {
          projectName: 'Demo',
        }),
      ],
    });
    setup();
    await waitFor(() => {
      expect(screen.getByTestId('bell-unread-dot')).toBeInTheDocument();
    });
  });
});

describe('BellMenu — approve / reject mutations on upgrade-request rows', () => {
  it('clicking approve calls roleUpgradeRequestsApi.decide(approved)', async () => {
    const user = userEvent.setup();
    vi.mocked(notificationsApi.list).mockResolvedValueOnce({
      data: [
        fakeNotification(N1, 'access.role_upgrade_request', {
          projectName: 'Demo',
        }),
      ],
    });
    vi.mocked(roleUpgradeRequestsApi.decide).mockResolvedValueOnce({
      data: { ok: true },
    });
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
    vi.mocked(notificationsApi.list).mockResolvedValueOnce({
      data: [
        fakeNotification(N1, 'access.role_upgrade_request', {
          projectName: 'Demo',
        }),
      ],
    });
    vi.mocked(roleUpgradeRequestsApi.decide).mockResolvedValueOnce({
      data: { ok: true },
    });
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
    vi.mocked(notificationsApi.list).mockResolvedValueOnce({
      data: [
        fakeNotification(N1, 'access.role_upgrade_request', {
          projectName: 'Demo',
        }),
      ],
    });
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
    vi.mocked(notificationsApi.list).mockResolvedValueOnce({
      data: [
        fakeNotification(N2, 'access.member_joined', {
          projectName: 'Demo',
          newMemberUserId: 'u-x',
          role: 'view',
        }),
      ],
    });
    vi.mocked(notificationsApi.markRead).mockResolvedValueOnce({
      data: { ok: true },
    });
    setup();
    await user.click(screen.getByTestId('bell-trigger'));
    await user.click(await screen.findByTestId(`bell-mark-read-${N2}`));

    await waitFor(() => {
      expect(notificationsApi.markRead).toHaveBeenCalledWith(N2);
    });
  });
});
