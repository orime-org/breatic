// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';

import { BellMenu } from '@web/features/notifications/BellMenu';
import { TooltipProvider } from '@web/components/ui/tooltip';
import { useCurrentUserStore } from '@web/stores';

// Every waiting row navigates to the shared landing page instead of deciding
// in place; spy on react-router's navigate to assert where it sends you.
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

vi.mock('@web/data/api/notifications', () => ({
  notificationsApi: {
    list: vi.fn(),
    count: vi.fn(),
    markRead: vi.fn(),
    markAllRead: vi.fn(),
  },
  EMPTY_RESOLVED: { users: {}, studios: {}, projects: {} },
}));

// Assert on the app's toast wrapper (the public API), not sonner directly:
// the wrapper adds the de-dup id INSIDE, so its public methods still take just
// the message (spying sonner would see the extra id arg).
vi.mock('@web/lib/toast', () => ({
  toast: {
    error: vi.fn(),
    warning: vi.fn(),
    success: vi.fn(),
    info: vi.fn(),
  },
}));

import { notificationsApi , EMPTY_RESOLVED } from '@web/data/api/notifications';
import type { NotificationType } from '@web/data/api/notifications';

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

// The wire's own union, not a copy of it. The copy that used to live here had
// already drifted — it was missing project.transfer_approved — which is the
// same shape of bug these tests are here to catch: a type gets added and the
// places that enumerate types are updated one at a time.
type NotifType = NotificationType;

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
  vi.mocked(notificationsApi.list).mockResolvedValue({ items: [], resolved: EMPTY_RESOLVED });
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

describe('BellMenu — every waiting request is a link, not a decision', () => {
  // The bell used to decide four of the five flows inline and navigate for the
  // fifth. It now does one thing for all five: say a decision is waiting and
  // take you to the page where it is made. These tests pin that uniformity —
  // one row shape, one button, one destination.
  const WAITING: Array<{ type: NotifType; payload: Record<string, unknown> }> = [
    {
      type: 'access.role_upgrade_request',
      payload: { requestId: 'r-1', requesterUserId: 'u-other', shareToken: 'a'.repeat(64) },
    },
    {
      type: 'studio.invite_request',
      payload: { invitationId: 'i-1', studioId: N1, inviterUserId: 'u-other', role: 'guest', shareToken: 'b'.repeat(64) },
    },
    {
      type: 'project.invite_request',
      payload: { invitationId: 'i-2', projectId: PID, inviterUserId: 'u-other', role: 'viewer', shareToken: 'c'.repeat(64) },
    },
    {
      type: 'studio.transfer_request',
      payload: { transferId: 't-1', studioId: N1, fromUserId: 'u-other', shareToken: 'd'.repeat(64) },
    },
    {
      type: 'project.transfer_request',
      payload: { transferId: 't-2', projectId: PID, fromUserId: 'u-other', shareToken: 'e'.repeat(64) },
    },
  ];

  it.each(WAITING)('$type shows one answer button and no inline decision', async ({ type, payload }) => {
    vi.mocked(notificationsApi.list).mockResolvedValue({
      items: [fakeNotification('n-1', type, payload)],
      resolved: EMPTY_RESOLVED,
    });
    const user = userEvent.setup();
    setup();
    await user.click(screen.getByTestId('bell-trigger'));

    expect(await screen.findByTestId('bell-open-decision-n-1')).toBeInTheDocument();
    // The four inline affordances are gone for every flow, not just some.
    expect(screen.queryByTestId('bell-approve-n-1')).toBeNull();
    expect(screen.queryByTestId('bell-reject-n-1')).toBeNull();
    expect(screen.queryByTestId('bell-confirm-n-1')).toBeNull();
    expect(screen.queryByTestId('bell-cancel-n-1')).toBeNull();
  });

  it.each(WAITING)('$type navigates to the shared landing page with its token', async ({ type, payload }) => {
    vi.mocked(notificationsApi.list).mockResolvedValue({
      items: [fakeNotification('n-1', type, payload)],
      resolved: EMPTY_RESOLVED,
    });
    const user = userEvent.setup();
    setup();
    await user.click(screen.getByTestId('bell-trigger'));
    await user.click(await screen.findByTestId('bell-open-decision-n-1'));

    await waitFor(() => {
      expect(navigateMock).toHaveBeenCalledWith(
        `/decision?token=${String(payload['shareToken'])}`,
      );
    });
  });

  it('every waiting row says what accepting makes you', async () => {
    // The second line answers one question: what do you hold if you accept.
    // The invites answer it by naming the role being offered; the transfers
    // answer it by naming the role you take over. The project transfer — the
    // heavier of the two transfers, since it hands over a whole project —
    // shipped with no second line at all, so its recipient was told least.
    const SAYS: Array<{ type: NotifType; payload: Record<string, unknown>; line: RegExp }> = [
      {
        type: 'studio.transfer_request',
        payload: { transferId: 't-1', studioId: N1, fromUserId: 'u-other', shareToken: 'd'.repeat(64) },
        line: /become the Studio Admin/i,
      },
      {
        type: 'project.transfer_request',
        payload: { transferId: 't-2', projectId: PID, fromUserId: 'u-other', shareToken: 'e'.repeat(64) },
        line: /become the Project Owner/i,
      },
    ];
    vi.mocked(notificationsApi.list).mockResolvedValue({
      items: SAYS.map((s, i) => fakeNotification(`n-s${i}`, s.type, s.payload)),
      resolved: EMPTY_RESOLVED,
    });
    const user = userEvent.setup();
    setup();
    await user.click(screen.getByTestId('bell-trigger'));
    await screen.findByTestId('bell-open-decision-n-s0');

    for (const s of SAYS) {
      expect(screen.getByText(s.line)).toBeInTheDocument();
    }
  });

  it('every type this inbox can hold has a glyph of its own', async () => {
    // The avatar falls back to `?` for a type the switch does not name. That
    // fallback is for a type we do not know about; reaching it for one of our
    // own means the row shipped half-wired, and the recipient reads a question
    // mark next to a decision they are being asked to make. Measured: the
    // project transfer did exactly that while the studio transfer showed TR.
    const EVERY_TYPE = [
      'access.role_upgrade_request',
      'access.role_upgrade_approved',
      'access.role_upgrade_rejected',
      'studio.transfer_request',
      'studio.transfer_approved',
      'studio.invite_request',
      'studio.invite_accepted',
      'project.invite_request',
      'project.invite_accepted',
      'project.transfer_request',
      'project.transfer_approved',
    ] as const satisfies readonly NotifType[];
    // A list written by hand can fall behind the union it claims to cover, so
    // the gap is a type error rather than a quieter run of this test: leaving a
    // type out makes `Missing` something other than never, and nothing can be
    // assigned to it.
    type Missing = Exclude<NotifType, (typeof EVERY_TYPE)[number]>;
    const noneMissing: Missing extends never ? true : Missing = true;
    expect(noneMissing).toBe(true);

    vi.mocked(notificationsApi.list).mockResolvedValue({
      items: EVERY_TYPE.map((type, i) => fakeNotification(`n-g${i}`, type)),
      resolved: EMPTY_RESOLVED,
    });
    const user = userEvent.setup();
    setup();
    await user.click(screen.getByTestId('bell-trigger'));
    await screen.findByTestId('bell-notification-headline-n-g0');

    expect(screen.queryByText('?')).toBeNull();
  });

  it('informational rows still mark read rather than offering an answer', async () => {
    vi.mocked(notificationsApi.list).mockResolvedValue({
      items: [fakeNotification('n-9', 'studio.transfer_approved', { studioId: N1 })],
      resolved: EMPTY_RESOLVED,
    });
    const user = userEvent.setup();
    setup();
    await user.click(screen.getByTestId('bell-trigger'));

    expect(await screen.findByTestId('bell-mark-read-n-9')).toBeInTheDocument();
    expect(screen.queryByTestId('bell-open-decision-n-9')).toBeNull();
  });

  it('a waiting row with no token to point at offers no answer button', async () => {
    // Rows filed before the token existed are of a waiting KIND but carry no
    // pointer. Keying the button on the type alone draws one that goes
    // nowhere — no navigation, no message, nothing.
    vi.mocked(notificationsApi.list).mockResolvedValue({
      items: [
        fakeNotification('n-10', 'studio.invite_request', {
          invitationId: 'i-3',
          studioId: N1,
          inviterUserId: 'u-other',
          role: 'guest',
        }),
      ],
      resolved: EMPTY_RESOLVED,
    });
    const user = userEvent.setup();
    setup();
    await user.click(screen.getByTestId('bell-trigger'));

    expect(await screen.findByTestId('bell-mark-read-n-10')).toBeInTheDocument();
    expect(screen.queryByTestId('bell-open-decision-n-10')).toBeNull();
  });
});
