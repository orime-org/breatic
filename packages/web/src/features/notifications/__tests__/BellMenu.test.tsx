// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

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
  membershipTier: 'base' as const,
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
    {
      type: 'project.join_request',
      payload: { requestId: 'j-1', projectId: PID, requesterUserId: 'u-other', shareToken: 'f'.repeat(64) },
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

  it('both transfers say which role you take over', async () => {
    // Scoped to the transfers on purpose. The invites answer the same question
    // by naming the role offered, and a role upgrade answers a different one
    // (it shows the requester's message, and has no second line when they
    // typed none) — so "every waiting row" would be a wider claim than this
    // asserts, and than the code keeps.
    //
    // The project transfer — the heavier of the two, since it hands over a
    // whole project — shipped with no second line at all, so its recipient was
    // told least.
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
      'project.join_request',
      'project.join_approved',
      'project.join_rejected',
      'membership.ended',
      'membership.upgrade_incomplete',
      'storage.quota_exceeded',
      'credit.refund_completed',
      'credit.refund_rejected',
      'credit.refund_restored',
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

  it('says how long ago a row arrived in the reader\'s language', async () => {
    vi.mocked(notificationsApi.list).mockResolvedValue({
      items: [fakeNotification('n-8', 'studio.transfer_approved', { studioId: N1 })],
      resolved: EMPTY_RESOLVED,
    });
    const user = userEvent.setup();
    setup();
    await user.click(screen.getByTestId('bell-trigger'));

    expect(await screen.findByText('5 minutes ago')).toBeInTheDocument();
    expect(screen.queryByText('5m ago')).toBeNull();
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

describe('BellMenu — a credit refund outcome is one sentence and mark-read (inner#1410 §8)', () => {
  // Like membership.ended: nobody to name, nothing to open. The buyer is told
  // how their refund request ended, and the row only offers mark-read.
  const OUTCOMES: Array<{ id: string; type: NotifType; payload: Record<string, unknown> }> = [
    {
      id: 'n-rc',
      type: 'credit.refund_completed',
      payload: { lotId: 'lot-1', credits: '880.000000', amountCents: 1080, currency: 'usd' },
    },
    {
      id: 'n-rr',
      type: 'credit.refund_rejected',
      payload: { lotId: 'lot-2', credits: '880.000000' },
    },
    {
      id: 'n-rs',
      type: 'credit.refund_restored' as NotifType,
      payload: { lotId: 'lot-3', credits: '880.000000' },
    },
  ];

  it.each(OUTCOMES)('$type reads as a sentence with no link and offers mark-read only', async ({ id, type, payload }) => {
    vi.mocked(notificationsApi.list).mockResolvedValue({
      items: [fakeNotification(id, type, payload)],
      resolved: EMPTY_RESOLVED,
    });
    const user = userEvent.setup();
    setup();
    await user.click(screen.getByTestId('bell-trigger'));

    const headline = await screen.findByTestId(`bell-notification-headline-${id}`);
    const text = headline.textContent ?? '';
    expect(text.trim()).not.toBe('');
    expect(text).not.toContain(type);
    expect(text).not.toContain('notifications.');
    expect(headline.querySelectorAll('a')).toHaveLength(0);
    expect(screen.getByTestId(`bell-mark-read-${id}`)).toBeInTheDocument();
    expect(screen.queryByTestId(`bell-open-decision-${id}`)).toBeNull();
  });

  // A refund outcome is a settled answer, so it takes the mark the rest of the
  // inbox uses for one (the rule above `iconForType`): a tick when the refund
  // went through, a cross when it was turned down. Not initials (RF/RX).
  it.each([
    { ...OUTCOMES[0], glyph: '✓', initials: 'RF' },
    { ...OUTCOMES[1], glyph: '✕', initials: 'RX' },
    // inner#1410 v9 §8: credits back in the account, an arrow coming round.
    { ...OUTCOMES[2], glyph: '↺', initials: 'RS' },
  ])('$type shows $glyph as its glyph', async ({ id, type, payload, glyph, initials }) => {
    vi.mocked(notificationsApi.list).mockResolvedValue({
      items: [fakeNotification(id, type, payload)],
      resolved: EMPTY_RESOLVED,
    });
    const user = userEvent.setup();
    setup();
    await user.click(screen.getByTestId('bell-trigger'));
    await screen.findByTestId(`bell-notification-headline-${id}`);

    expect(screen.getByText(glyph)).toBeInTheDocument();
    expect(screen.queryByText(initials)).toBeNull();
    // inner#1410 v9: a lone symbol at 12px reads as a speck, so it sits at
    // 15px (text-base); two-letter initials stay at text-xs (12px).
    const fallback = screen.getByText(glyph);
    expect(fallback).toHaveClass('text-base');
    expect(fallback).not.toHaveClass('text-xs');
  });

  it('a row with initials keeps them at text-xs', async () => {
    vi.mocked(notificationsApi.list).mockResolvedValue({
      items: [fakeNotification('n-me', 'membership.ended')],
      resolved: EMPTY_RESOLVED,
    });
    const user = userEvent.setup();
    setup();
    await user.click(screen.getByTestId('bell-trigger'));
    await screen.findByTestId('bell-notification-headline-n-me');

    const fallback = screen.getByText('ME');
    expect(fallback).toHaveClass('text-xs');
    expect(fallback).not.toHaveClass('text-base');
  });

  it('the three outcomes say different things', async () => {
    vi.mocked(notificationsApi.list).mockResolvedValue({
      items: OUTCOMES.map((o) => fakeNotification(o.id, o.type, o.payload)),
      resolved: EMPTY_RESOLVED,
    });
    const user = userEvent.setup();
    setup();
    await user.click(screen.getByTestId('bell-trigger'));

    const completed = await screen.findByTestId('bell-notification-headline-n-rc');
    const rejected = screen.getByTestId('bell-notification-headline-n-rr');
    const restored = screen.getByTestId('bell-notification-headline-n-rs');
    // Different sentences, not raw type names that happen to differ.
    for (const row of [completed, rejected, restored]) expect(row.textContent).not.toMatch(/credit\.refund_/);
    expect(new Set([completed, rejected, restored].map((r) => r.textContent)).size).toBe(3);
  });
});

describe('BellMenu — mark all read', () => {
  const NEWS = '33333333-3333-4333-8333-333333333333';
  const WAITING = '44444444-4444-4444-8444-444444444444';

  it('offers mark-all-read left of the count while a news row is unread', async () => {
    vi.mocked(notificationsApi.list).mockResolvedValue({
      items: [
        fakeNotification(NEWS, 'studio.invite_accepted'),
        fakeNotification(WAITING, 'project.join_request', { shareToken: 'tok' }),
      ],
      resolved: EMPTY_RESOLVED,
    });
    const user = userEvent.setup();
    setup();
    await user.click(screen.getByTestId('bell-trigger'));
    const button = await screen.findByTestId('bell-mark-all-read');
    expect(button).toHaveTextContent('Mark all read');
    const count = screen.getByTestId('bell-count');
    expect(button.compareDocumentPosition(count) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('hides mark-all-read when only waiting requests are unread', async () => {
    vi.mocked(notificationsApi.list).mockResolvedValue({
      items: [fakeNotification(WAITING, 'project.join_request', { shareToken: 'tok' })],
      resolved: EMPTY_RESOLVED,
    });
    const user = userEvent.setup();
    setup();
    await user.click(screen.getByTestId('bell-trigger'));
    await screen.findByTestId(`bell-notification-${WAITING}`);
    expect(screen.queryByTestId('bell-mark-all-read')).toBeNull();
  });

  it('hides mark-all-read when nothing is unread', async () => {
    const user = userEvent.setup();
    setup();
    await user.click(screen.getByTestId('bell-trigger'));
    await screen.findByText(/No pending notifications/i);
    expect(screen.queryByTestId('bell-mark-all-read')).toBeNull();
  });

  it('marks all read and refetches the inbox', async () => {
    vi.mocked(notificationsApi.list).mockResolvedValue({
      items: [fakeNotification(NEWS, 'studio.invite_accepted')],
      resolved: EMPTY_RESOLVED,
    });
    vi.mocked(notificationsApi.markAllRead).mockResolvedValue({ count: 1 });
    const user = userEvent.setup();
    setup();
    await user.click(screen.getByTestId('bell-trigger'));
    await user.click(await screen.findByTestId('bell-mark-all-read'));
    await waitFor(() => expect(notificationsApi.markAllRead).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(notificationsApi.list).toHaveBeenCalledTimes(2));
  });
});

/** A promise and the handles that settle it. */
interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason: Error) => void;
}

/**
 * A promise the test settles by hand.
 * @returns The promise and its settlers.
 */
function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe('BellMenu — the mark-read buttons spin while the server answers', () => {
  const NEWS_A = '55555555-5555-4555-8555-555555555555';
  const NEWS_B = '66666666-6666-4666-8666-666666666666';

  beforeEach(() => {
    vi.mocked(notificationsApi.list).mockResolvedValue({
      items: [
        fakeNotification(NEWS_A, 'studio.invite_accepted'),
        fakeNotification(NEWS_B, 'studio.invite_accepted'),
      ],
      resolved: EMPTY_RESOLVED,
    });
  });

  it.each(['answers', 'fails'] as const)(
    'spins mark-all-read until the server %s',
    async (outcome) => {
      const reply = deferred<{ count: number }>();
      vi.mocked(notificationsApi.markAllRead).mockReturnValue(reply.promise);
      const user = userEvent.setup();
      setup();
      await user.click(screen.getByTestId('bell-trigger'));
      const button = await screen.findByTestId('bell-mark-all-read');
      await user.click(button);

      await waitFor(() => expect(button).toHaveAttribute('aria-busy', 'true'));
      expect(button).toHaveAttribute('aria-disabled', 'true');

      if (outcome === 'answers') reply.resolve({ count: 2 });
      else reply.reject(new Error('offline'));
      await waitFor(() => expect(button).not.toHaveAttribute('aria-busy'));
      expect(button).not.toHaveAttribute('aria-disabled');
    },
  );

  it.each(['answers', 'fails'] as const)(
    'spins only the row being marked read until the server %s',
    async (outcome) => {
      const reply = deferred<{ ok: true }>();
      vi.mocked(notificationsApi.markRead).mockReturnValue(reply.promise);
      const user = userEvent.setup();
      setup();
      await user.click(screen.getByTestId('bell-trigger'));
      const marked = await screen.findByTestId(`bell-mark-read-${NEWS_A}`);
      const other = screen.getByTestId(`bell-mark-read-${NEWS_B}`);
      await user.click(marked);

      await waitFor(() => expect(marked).toHaveAttribute('aria-busy', 'true'));
      expect(marked).toHaveAttribute('aria-disabled', 'true');
      expect(other).not.toHaveAttribute('aria-busy');

      if (outcome === 'answers') reply.resolve({ ok: true });
      else reply.reject(new Error('offline'));
      await waitFor(() => expect(marked).not.toHaveAttribute('aria-busy'));
      expect(marked).not.toHaveAttribute('aria-disabled');
    },
  );

  it('keeps the first row spinning when a second row is marked read before it answers', async () => {
    const replyA = deferred<{ ok: true }>();
    const replyB = deferred<{ ok: true }>();
    vi.mocked(notificationsApi.markRead).mockImplementation((id) =>
      id === NEWS_A ? replyA.promise : replyB.promise,
    );
    const user = userEvent.setup();
    setup();
    await user.click(screen.getByTestId('bell-trigger'));
    const rowA = await screen.findByTestId(`bell-mark-read-${NEWS_A}`);
    const rowB = screen.getByTestId(`bell-mark-read-${NEWS_B}`);
    await user.click(rowA);
    await waitFor(() => expect(rowA).toHaveAttribute('aria-busy', 'true'));
    await user.click(rowB);

    await waitFor(() => expect(rowB).toHaveAttribute('aria-busy', 'true'));
    expect(rowA).toHaveAttribute('aria-busy', 'true');

    replyA.resolve({ ok: true });
    await waitFor(() => expect(rowA).not.toHaveAttribute('aria-busy'));
    expect(rowB).toHaveAttribute('aria-busy', 'true');

    replyB.resolve({ ok: true });
    await waitFor(() => expect(rowB).not.toHaveAttribute('aria-busy'));
  });
});
