// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { act } from 'react';
import type { ReactElement } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

import { MembersModal } from '@web/pages/project/chrome/top-bar/MembersModal';
import type { Member } from '@web/data/api/members';
import { useUIStore } from '@web/stores/ui';
import { expectNoA11yViolations } from '@web/test-utils/a11y';

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

  it('is hidden when activeOverlayId is not members-modal', () => {
    renderModal(<MembersModal />);
    expect(screen.queryByTestId('members-modal')).not.toBeInTheDocument();
  });

  it('has no a11y violations when open', async () => {
    act(() => {
      useUIStore.getState().setActiveOverlayId('members-modal');
    });
    renderModal(<MembersModal />);
    await expectNoA11yViolations(document.body);
  });

  it('renders header / 5 stub member rows when open', () => {
    act(() => {
      useUIStore.getState().setActiveOverlayId('members-modal');
    });
    renderModal(<MembersModal />);
    expect(screen.getByTestId('members-modal')).toBeInTheDocument();
    expect(screen.getByText('Collaborators')).toBeInTheDocument();
    expect(
      screen.getByText('Manage project members and their roles'),
    ).toBeInTheDocument();
    expect(
      screen.getByTestId('members-modal-row-me'),
    ).toBeInTheDocument();
    expect(
      screen.getByTestId('members-modal-row-pl'),
    ).toBeInTheDocument();
  });

  it('renders the real members it is given (not the stub fallback)', () => {
    act(() => {
      useUIStore.getState().setActiveOverlayId('members-modal');
    });
    renderModal(
      <MembersModal projectId='p1' members={REAL_MEMBERS} currentUserId='u-a' />,
    );
    expect(screen.getByText('Real Owner')).toBeInTheDocument();
    expect(screen.getByText('Real Editor')).toBeInTheDocument();
    // Once real data is supplied, the stub fallback names must NOT appear
    // (the bug: the modal rendered hardcoded stub members because the
    // caller passed no props).
    expect(screen.queryByText('Songxiu Lei')).toBeNull();
  });

  it('is manage-only — no invite input / send button (invite lives in ShareDialog)', () => {
    act(() => {
      useUIStore.getState().setActiveOverlayId('members-modal');
    });
    renderModal(<MembersModal />);
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
    renderModal(<MembersModal />);
    // owner row: no role select
    expect(
      screen.queryByTestId('members-modal-role-me'),
    ).not.toBeInTheDocument();
    // editor / viewer rows: role select present
    expect(screen.getByTestId('members-modal-role-yj')).toBeInTheDocument();
    expect(screen.getByTestId('members-modal-role-dm')).toBeInTheDocument();
    expect(screen.getByTestId('members-modal-role-rt')).toBeInTheDocument();
    expect(screen.getByTestId('members-modal-role-pl')).toBeInTheDocument();
  });
});
