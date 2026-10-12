// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { act } from 'react';
import type { ReactElement } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

vi.mock('@web/lib/toast', () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));
vi.mock('@web/data/api/members', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@web/data/api/members')>();
  return {
    ...actual,
    membersApi: {
      ...actual.membersApi,
      remove: vi.fn(),
      transferCandidates: vi.fn(),
    },
  };
});
vi.mock('@web/data/api/projects', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@web/data/api/projects')>();
  return {
    ...actual,
    projectsApi: {
      ...actual.projectsApi,
      liveTransfer: vi.fn(),
      transferOwner: vi.fn(),
      withdrawTransfer: vi.fn(),
    },
  };
});

import { MembersModal } from '@web/pages/project/chrome/top-bar/MembersModal';
import { membersApi } from '@web/data/api/members';
import { projectsApi } from '@web/data/api/projects';
import type { Member } from '@web/data/api/members';
import { useUIStore } from '@web/stores/ui';
import { expectNoA11yViolations } from '@web/test-utils/a11y';
import { toast } from '@web/lib/toast';

/**
 * Render the modal inside a fresh QueryClientProvider. The modal invalidates
 * the `project-members` query after a role change / removal, so it needs a
 * client in scope (`useQueryClient`).
 */
function renderModal(ui: ReactElement) {
  return render(
    <QueryClientProvider client={new QueryClient()}>{ui}</QueryClientProvider>,
  );
}

const REAL_MEMBERS: ReadonlyArray<Member> = [
  { id: 'u-a', userId: 'u-a', name: 'Real Owner', email: 'a@e.com', role: 'owner' },
  { id: 'u-b', userId: 'u-b', name: 'Real Editor', email: 'b@e.com', role: 'editor' },
];

describe('MembersModal', () => {
  beforeEach(() => {
    useUIStore.setState({ activeOverlayId: null });
  });

  it('does not compile without members, which is the whole point of the change', () => {
    // Same pin as the stack's: this modal carried its own copy of the same
    // five invented people, and a forgotten prop was all it took to put them
    // on screen. If `members` goes back to optional there is no error for
    // this directive to expect and typecheck fails on it.
    // @ts-expect-error members is required
    const element = <MembersModal projectId='p1' />;
    expect(element).toBeTruthy();
  });

  it('is hidden when activeOverlayId is not members-modal', () => {
    renderModal(<MembersModal members={REAL_MEMBERS} />);
    expect(screen.queryByTestId('members-modal')).not.toBeInTheDocument();
  });

  it('has no a11y violations when open', async () => {
    act(() => {
      useUIStore.getState().setActiveOverlayId('members-modal');
    });
    renderModal(<MembersModal members={REAL_MEMBERS} />);
    await expectNoA11yViolations(document.body);
  });

  it('keeps the header out of the region that scrolls', () => {
    // #166: the roster grows with the project, so this modal settles its own
    // height and scrolls the rows inside. The title and the close button have
    // to stay put — a header that scrolls away takes the way out with it.
    act(() => {
      useUIStore.getState().setActiveOverlayId('members-modal');
    });
    renderModal(<MembersModal members={REAL_MEMBERS} />);

    const modal = screen.getByTestId('members-modal');
    expect(modal.className).toContain('max-h-[calc(100vh-2rem)]');
    const scroller = modal.querySelector('[data-scrollbars]');
    expect(scroller).not.toBeNull();
    expect(scroller!.contains(screen.getByRole('heading'))).toBe(false);
    expect(
      scroller!.contains(screen.getByTestId(`members-modal-row-${REAL_MEMBERS[1].id}`)),
    ).toBe(true);
  });

  it('renders the header and one row per member it was given', () => {
    act(() => {
      useUIStore.getState().setActiveOverlayId('members-modal');
    });
    renderModal(<MembersModal members={REAL_MEMBERS} />);
    expect(screen.getByTestId('members-modal')).toBeInTheDocument();
    expect(screen.getByText('Collaborators')).toBeInTheDocument();
    expect(
      screen.getByText('Manage project members and their roles'),
    ).toBeInTheDocument();
    expect(screen.getByTestId('members-modal-row-u-a')).toBeInTheDocument();
    expect(screen.getByTestId('members-modal-row-u-b')).toBeInTheDocument();
  });

  it('renders exactly the members it is given, and nobody else', () => {
    act(() => {
      useUIStore.getState().setActiveOverlayId('members-modal');
    });
    renderModal(
      <MembersModal projectId='p1' members={REAL_MEMBERS} currentUserId='u-a' />,
    );
    expect(screen.getByText('Real Owner')).toBeInTheDocument();
    expect(screen.getByText('Real Editor')).toBeInTheDocument();
    // Two given, two rendered. This used to guard against a stub roster of
    // five invented people appearing alongside them; the stub is gone and
    // the prop is required, so what is left to hold is the plain rule that
    // the modal invents nobody.
    expect(screen.getAllByTestId(/^members-modal-row-/)).toHaveLength(2);
  });

  it('is manage-only — no invite input / send button (invite lives in ShareDialog)', () => {
    act(() => {
      useUIStore.getState().setActiveOverlayId('members-modal');
    });
    renderModal(<MembersModal members={REAL_MEMBERS} />);
    expect(
      screen.queryByTestId('members-modal-invite-input'),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByTestId('members-modal-invite-send'),
    ).not.toBeInTheDocument();
  });

  it('clicking a row remove opens a confirm dialog first (removal is gated behind a second step)', async () => {
    const user = userEvent.setup();
    act(() => {
      useUIStore.getState().setActiveOverlayId('members-modal');
    });
    renderModal(
      <MembersModal projectId='p1' members={REAL_MEMBERS} currentUserId='u-a' />,
    );
    // No confirm dialog before the remove button is clicked.
    expect(
      screen.queryByTestId('members-modal-remove-confirm'),
    ).not.toBeInTheDocument();
    // The non-owner editor row exposes a remove button.
    await user.click(screen.getByTestId('members-modal-remove-u-b'));
    // Clicking it opens the confirm dialog instead of removing immediately.
    expect(
      screen.getByTestId('members-modal-remove-confirm'),
    ).toBeInTheDocument();
    expect(
      screen.getByTestId('members-modal-remove-confirm-action'),
    ).toBeInTheDocument();
  });

  it('owner row has Owner label, non-owner rows have role select', () => {
    act(() => {
      useUIStore.getState().setActiveOverlayId('members-modal');
    });
    renderModal(<MembersModal members={REAL_MEMBERS} />);
    // owner row: no role select
    expect(
      screen.queryByTestId('members-modal-role-u-a'),
    ).not.toBeInTheDocument();
    // non-owner row: role select present
    expect(screen.getByTestId('members-modal-role-u-b')).toBeInTheDocument();
  });
});

/**
 * A reply held open until the test settles it.
 * @returns The pending promise and the two ways to settle it.
 */
function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void; reject: () => void } {
  let resolve!: (value: T) => void;
  let reject!: () => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = () => rej(new Error('refused'));
  });
  return { promise, resolve, reject };
}

const LIVE_OFFER = {
  id: 't-1',
  fromUserId: 'u-a',
  toUserId: 'u-b',
  expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
};

describe('MembersModal waiting buttons', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useUIStore.setState({ activeOverlayId: null });
    act(() => {
      useUIStore.getState().setActiveOverlayId('members-modal');
    });
  });

  /**
   * Opens the remove confirmation for the editor row.
   * @returns The confirm button.
   */
  async function openRemoveConfirm(): Promise<HTMLElement> {
    const user = userEvent.setup();
    renderModal(
      <MembersModal projectId='p1' members={REAL_MEMBERS} currentUserId='u-a' />,
    );
    await user.click(screen.getByTestId('members-modal-remove-u-b'));
    const action = screen.getByTestId('members-modal-remove-confirm-action');
    await user.click(action);
    return action;
  }

  it('keeps the remove confirmation open and busy while waiting, then closes it on success', async () => {
    const reply = deferred<void>();
    vi.mocked(membersApi.remove).mockReturnValue(reply.promise as never);
    const action = await openRemoveConfirm();

    await waitFor(() => expect(action).toHaveAttribute('aria-busy', 'true'));
    expect(action).toHaveAttribute('aria-disabled', 'true');
    expect(screen.getByTestId('members-modal-remove-confirm')).toBeInTheDocument();
    reply.resolve(undefined);
    await waitFor(() =>
      expect(screen.queryByTestId('members-modal-remove-confirm')).not.toBeInTheDocument(),
    );
  });

  it('keeps the remove confirmation open after a failure, no longer busy', async () => {
    const reply = deferred<void>();
    vi.mocked(membersApi.remove).mockReturnValue(reply.promise as never);
    const action = await openRemoveConfirm();

    await waitFor(() => expect(action).toHaveAttribute('aria-busy', 'true'));
    reply.reject();
    await waitFor(() => expect(action).not.toHaveAttribute('aria-busy'));
    expect(screen.getByTestId('members-modal-remove-confirm')).toBeInTheDocument();
  });

  it('leaves a second member\'s remove confirmation open when the earlier removal answers', async () => {
    const reply = deferred<void>();
    vi.mocked(membersApi.remove).mockReturnValue(reply.promise as never);
    const user = userEvent.setup();
    const members: ReadonlyArray<Member> = [
      ...REAL_MEMBERS,
      { id: 'u-c', userId: 'u-c', name: 'Real Viewer', email: 'c@e.com', role: 'viewer' },
    ];
    renderModal(<MembersModal projectId='p1' members={members} currentUserId='u-a' />);

    await user.click(screen.getByTestId('members-modal-remove-u-b'));
    await user.click(screen.getByTestId('members-modal-remove-confirm-action'));
    await waitFor(() => expect(membersApi.remove).toHaveBeenCalledTimes(1));
    await user.keyboard('{Escape}');
    await waitFor(() =>
      expect(screen.queryByTestId('members-modal-remove-confirm')).not.toBeInTheDocument(),
    );
    await user.click(screen.getByTestId('members-modal-remove-u-c'));
    expect(screen.getByTestId('members-modal-remove-confirm')).toHaveTextContent('Real Viewer');

    reply.resolve(undefined);
    await waitFor(() => expect(toast.success).toHaveBeenCalled());
    expect(screen.queryByTestId('members-modal-remove-confirm')).toHaveTextContent(
      'Real Viewer',
    );
  });

  for (const outcome of ['succeeds', 'fails'] as const) {
    it(`reads the transfer Withdraw button busy while waiting, and not after it ${outcome}`, async () => {
      vi.mocked(projectsApi.liveTransfer).mockResolvedValue(LIVE_OFFER);
      const reply = deferred<{ ok: true }>();
      vi.mocked(projectsApi.withdrawTransfer).mockReturnValue(reply.promise);
      const user = userEvent.setup();
      renderModal(
        <MembersModal
          projectId='p1'
          members={REAL_MEMBERS}
          currentUserId='u-a'
          currentUserRole='owner'
        />,
      );
      const withdraw = await screen.findByTestId('members-modal-transfer-withdraw');
      await user.click(withdraw);

      await waitFor(() => expect(withdraw).toHaveAttribute('aria-busy', 'true'));
      expect(withdraw).toHaveAttribute('aria-disabled', 'true');
      if (outcome === 'succeeds') reply.resolve({ ok: true });
      else reply.reject();
      await waitFor(() => expect(withdraw).not.toHaveAttribute('aria-busy'));
    });

    it(`reads the transfer Send button busy while waiting, and settles after it ${outcome}`, async () => {
      vi.mocked(projectsApi.liveTransfer).mockResolvedValue(null);
      vi.mocked(membersApi.transferCandidates).mockResolvedValue([
        { userId: 'u-b', role: 'editor' },
      ]);
      const reply = deferred<{ ok: boolean }>();
      vi.mocked(projectsApi.transferOwner).mockReturnValue(reply.promise);
      const user = userEvent.setup();
      renderModal(
        <MembersModal
          projectId='p1'
          members={REAL_MEMBERS}
          currentUserId='u-a'
          currentUserRole='owner'
        />,
      );
      await user.click(await screen.findByTestId('members-modal-transfer-open'));
      await user.click(await screen.findByTestId('members-modal-transfer-select'));
      await user.click(await screen.findByRole('option', { name: /Real Editor/ }));
      const send = screen.getByTestId('members-modal-transfer-send');
      await user.click(send);

      await waitFor(() => expect(send).toHaveAttribute('aria-busy', 'true'));
      expect(send).toHaveAttribute('aria-disabled', 'true');
      if (outcome === 'succeeds') {
        // A sent offer collapses the picker, taking the button with it.
        reply.resolve({ ok: true });
        await waitFor(() => expect(send).not.toBeInTheDocument());
      } else {
        reply.reject();
        await waitFor(() => expect(send).not.toHaveAttribute('aria-busy'));
      }
    });
  }
});
