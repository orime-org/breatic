// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { MembersStack } from '@web/pages/project/chrome/top-bar/MembersStack';
import type { Member } from '@web/data/api/members';
import { useUIStore } from '@web/stores/ui';
import { expectNoA11yViolations } from '@web/test-utils/a11y';

// Real-shape members for the role-gating tests: an owner (me), a non-owner
// editor, and a non-owner viewer. The popover is read-only — removing /
// role-changing members lives solely in the manage modal, so no row ever
// renders an inline remove control (2026-06-18).
const MEMBERS: ReadonlyArray<Member> = [
  { id: 'm-own', userId: 'u-own', name: 'Owner Person', email: 'own@e.com', role: 'owner' },
  { id: 'm-ed', userId: 'u-ed', name: 'Editor Person', email: 'ed@e.com', role: 'editor' },
  { id: 'm-vw', userId: 'u-vw', name: 'Viewer Person', email: 'vw@e.com', role: 'viewer' },
];

describe('MembersStack', () => {
  beforeEach(() => {
    useUIStore.setState({
      shareOpen: false,
      activeOverlayId: null,
    });
  });

  it('has no a11y violations', async () => {
    const { container } = render(<MembersStack />);
    await expectNoA11yViolations(container);
  });

  it('trigger button exposes member count in aria-label', () => {
    render(<MembersStack />);
    expect(
      screen.getByRole('button', { name: /Project members \(5\)/i }),
    ).toBeInTheDocument();
  });

  it('clicking trigger opens popover with 5 stub member rows', async () => {
    const user = userEvent.setup();
    render(<MembersStack />);
    await user.click(screen.getByTestId('members-trigger'));
    expect(screen.getByTestId('members-row-me')).toBeInTheDocument();
    expect(screen.getByTestId('members-row-yj')).toBeInTheDocument();
    expect(screen.getByTestId('members-row-pl')).toBeInTheDocument();
    expect(screen.getByText('Songxiu Lei')).toBeInTheDocument();
    expect(screen.getByText('Owner')).toBeInTheDocument();
  });

  it('has no Invite new member button (invite lives in ShareDialog)', async () => {
    const user = userEvent.setup();
    render(<MembersStack />);
    await user.click(screen.getByTestId('members-trigger'));
    expect(screen.queryByTestId('members-invite-trigger')).toBeNull();
    expect(useUIStore.getState().shareOpen).toBe(false);
  });

  it('clicking Manage collaborators closes popover + opens members-modal overlay', async () => {
    const user = userEvent.setup();
    render(<MembersStack currentUserRole='owner' />);
    await user.click(screen.getByTestId('members-trigger'));
    await user.click(screen.getByTestId('members-manage-trigger'));
    expect(useUIStore.getState().activeOverlayId).toBe('members-modal');
    expect(useUIStore.getState().shareOpen).toBe(false);
  });

  it('keeps the popover title in Title Case (frozen "Project" word, no CSS uppercase)', async () => {
    const user = userEvent.setup();
    render(<MembersStack />);
    await user.click(screen.getByTestId('members-trigger'));
    const title = screen.getByTestId('members-popover-title');
    expect(title).not.toHaveClass('uppercase');
  });

  describe('role-based affordance gating (B model — hide)', () => {
    it('owner sees the Manage collaborators button', async () => {
      const user = userEvent.setup();
      render(
        <MembersStack
          members={MEMBERS}
          currentUserId='u-own'
          currentUserRole='owner'
        />,
      );
      await user.click(screen.getByTestId('members-trigger'));
      expect(screen.getByTestId('members-manage-trigger')).toBeInTheDocument();
    });

    it('editor does NOT see the Manage collaborators button', async () => {
      const user = userEvent.setup();
      render(
        <MembersStack
          members={MEMBERS}
          currentUserId='u-ed'
          currentUserRole='editor'
        />,
      );
      await user.click(screen.getByTestId('members-trigger'));
      expect(screen.queryByTestId('members-manage-trigger')).toBeNull();
    });

    it('viewer does NOT see the Manage collaborators button', async () => {
      const user = userEvent.setup();
      render(
        <MembersStack
          members={MEMBERS}
          currentUserId='u-vw'
          currentUserRole='viewer'
        />,
      );
      await user.click(screen.getByTestId('members-trigger'));
      expect(screen.queryByTestId('members-manage-trigger')).toBeNull();
    });

    it('never renders an inline remove button — even for the owner; rows show role badges (remove lives in the manage modal)', async () => {
      const user = userEvent.setup();
      render(
        <MembersStack
          members={MEMBERS}
          currentUserId='u-own'
          currentUserRole='owner'
        />,
      );
      await user.click(screen.getByTestId('members-trigger'));
      // No row exposes an inline remove control, not even in the owner's view.
      expect(screen.queryByTestId('members-remove-m-ed')).toBeNull();
      expect(screen.queryByTestId('members-remove-m-vw')).toBeNull();
      expect(screen.queryByTestId('members-remove-m-own')).toBeNull();
      // Every row shows the read-only role badge instead.
      expect(screen.getByText('Editor')).toBeInTheDocument();
      expect(screen.getByText('Viewer')).toBeInTheDocument();
    });
  });
});
