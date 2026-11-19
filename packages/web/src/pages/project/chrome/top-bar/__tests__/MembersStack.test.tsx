// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { MembersStack } from '@web/pages/project/chrome/top-bar/MembersStack';
import type { Member } from '@web/data/api/members';
import { useFollowStore, type FollowOther } from '@web/stores/follow';
import { useUIStore } from '@web/stores/ui';
import { expectNoA11yViolations } from '@web/test-utils/a11y';
import { t } from '@breatic/shared';

const toastMock = vi.hoisted(() => ({ info: vi.fn(), warning: vi.fn(), error: vi.fn(), success: vi.fn() }));
vi.mock('@web/lib/toast', () => ({ toast: toastMock }));

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

  it('does not compile without members, which is the whole point of the change', () => {
    // The stub roster this component used to fall back on put five people who
    // do not exist one forgotten prop away from the screen. Deleting it is
    // only half the fix — the other half is that forgetting the prop has to
    // stop compiling, and nothing at runtime can assert that.
    //
    // This directive is the assertion: if `members` ever goes back to being
    // optional, there is no error here for it to expect and `pnpm typecheck`
    // fails on the unused directive.
    // @ts-expect-error members is required
    const element = <MembersStack />;
    expect(element).toBeTruthy();
  });

  it('has no a11y violations', async () => {
    const { container } = render(<MembersStack members={MEMBERS} />);
    await expectNoA11yViolations(container);
  });

  it('trigger button exposes member count in aria-label', () => {
    render(<MembersStack members={MEMBERS} />);
    expect(
      screen.getByRole('button', { name: /Project members \(3\)/i }),
    ).toBeInTheDocument();
  });

  it('opens a popover with one row per member it was given', async () => {
    const user = userEvent.setup();
    render(<MembersStack members={MEMBERS} />);
    await user.click(screen.getByTestId('members-trigger'));
    expect(screen.getByTestId('members-row-m-own')).toBeInTheDocument();
    expect(screen.getByTestId('members-row-m-ed')).toBeInTheDocument();
    expect(screen.getByTestId('members-row-m-vw')).toBeInTheDocument();
    expect(screen.getByText('Owner Person')).toBeInTheDocument();
    expect(screen.getByText('Owner')).toBeInTheDocument();
  });

  it('has no Invite new member button (invite lives in ShareDialog)', async () => {
    const user = userEvent.setup();
    render(<MembersStack members={MEMBERS} />);
    await user.click(screen.getByTestId('members-trigger'));
    expect(screen.queryByTestId('members-invite-trigger')).toBeNull();
    expect(useUIStore.getState().shareOpen).toBe(false);
  });

  it('clicking Manage collaborators closes popover + opens members-modal overlay', async () => {
    const user = userEvent.setup();
    render(<MembersStack members={MEMBERS} currentUserRole='owner' />);
    await user.click(screen.getByTestId('members-trigger'));
    await user.click(screen.getByTestId('members-manage-trigger'));
    expect(useUIStore.getState().activeOverlayId).toBe('members-modal');
    expect(useUIStore.getState().shareOpen).toBe(false);
  });

  it('keeps the popover title in Title Case (frozen "Project" word, no CSS uppercase)', async () => {
    const user = userEvent.setup();
    render(<MembersStack members={MEMBERS} />);
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

  it('ends the list with Leave project for a member who may leave, and hands the click over', async () => {
    const user = userEvent.setup();
    const onLeave = vi.fn();
    render(<MembersStack members={MEMBERS} currentUserRole='editor' onLeave={onLeave} />);
    await user.click(screen.getByTestId('members-trigger'));
    expect(screen.queryByTestId('members-manage-trigger')).toBeNull();
    expect(screen.getByRole('button', { name: 'Leave project' })).toHaveClass('text-status-error-foreground');
    await user.click(screen.getByRole('button', { name: 'Leave project' }));
    expect(onLeave).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId('members-popover')).toBeNull();
  });

  it('offers no leave when the page does not hand one over', async () => {
    const user = userEvent.setup();
    render(<MembersStack members={MEMBERS} currentUserRole='viewer' />);
    await user.click(screen.getByTestId('members-trigger'));
    expect(screen.queryByRole('button', { name: 'Leave project' })).toBeNull();
  });
});

describe('MembersStack, following', () => {
  beforeEach(() => {
    useFollowStore.getState().reset();
    toastMock.warning.mockClear();
  });

  it('dims View on a member who is following someone, and pressing it only says whom they follow', async () => {
    const user = userEvent.setup();
    render(
      <MembersStack
        members={MEMBERS}
        currentUserId='u-vw'
        onlineUserIds={new Set(['u-own', 'u-ed', 'u-vw'])}
        followTargets={new Map<string, FollowOther>([['u-ed', { name: 'Owner Person' }]])}
      />,
    );
    await user.click(screen.getByTestId('members-trigger'));
    const view = screen.getByTestId('members-follow-m-ed');
    expect(view).toHaveAttribute('aria-disabled', 'true');
    expect(screen.getByTestId('members-follow-m-own')).not.toHaveAttribute('aria-disabled');
    await user.click(view);
    expect(useFollowStore.getState().targetUserId).toBeNull();
    expect(toastMock.warning).toHaveBeenCalledWith(t('members.follow.busy', { name: 'Editor Person', other: 'Owner Person' }));
    // Nothing happened, so the list stays open for the user to pick someone else.
    expect(screen.getByTestId('members-popover')).toBeInTheDocument();
  });

  it('ellipsizes a long member name beside the View button', async () => {
    // Text directly inside a flex container takes no ellipsis; the name has
    // its own truncating box so a cut name shows that it is cut.
    const user = userEvent.setup();
    render(
      <MembersStack
        members={MEMBERS}
        currentUserId='u-vw'
        onlineUserIds={new Set(['u-ed', 'u-vw'])}
        followTargets={new Map<string, FollowOther>()}
      />,
    );
    await user.click(screen.getByTestId('members-trigger'));
    const name = screen.getByText('Editor Person');
    expect(name).toHaveClass('min-w-0', 'truncate');
    expect(name).not.toHaveClass('flex');
  });

  it('says a member is following this user when View is pressed on them', async () => {
    const user = userEvent.setup();
    render(
      <MembersStack
        members={MEMBERS}
        currentUserId='u-vw'
        onlineUserIds={new Set(['u-ed', 'u-vw'])}
        followTargets={new Map<string, FollowOther>([['u-ed', 'you']])}
      />,
    );
    await user.click(screen.getByTestId('members-trigger'));
    await user.click(screen.getByTestId('members-follow-m-ed'));
    expect(useFollowStore.getState().targetUserId).toBeNull();
    expect(toastMock.warning).toHaveBeenCalledWith(t('members.follow.busyYou', { name: 'Editor Person' }));
    // Nothing happened, so the list stays open for the user to pick someone else.
    expect(screen.getByTestId('members-popover')).toBeInTheDocument();
  });

  it('shows each row online or offline', async () => {
    const user = userEvent.setup();
    render(<MembersStack members={MEMBERS} currentUserId='u-own' onlineUserIds={new Set(['u-own', 'u-ed'])} />);
    await user.click(screen.getByTestId('members-trigger'));
    expect(screen.getByTestId('members-status-m-ed')).toHaveAttribute('data-online', 'true');
    expect(screen.getByTestId('members-status-m-vw')).toHaveAttribute('data-online', 'false');
  });

  it('offers View only on other members who are online', async () => {
    const user = userEvent.setup();
    render(<MembersStack members={MEMBERS} currentUserId='u-own' onlineUserIds={new Set(['u-own', 'u-ed'])} />);
    await user.click(screen.getByTestId('members-trigger'));
    expect(screen.getByTestId('members-follow-m-ed')).toBeInTheDocument();
    expect(screen.queryByTestId('members-follow-m-own')).toBeNull();
    expect(screen.queryByTestId('members-follow-m-vw')).toBeNull();
  });

  it('starts following on View and closes the list; the row then offers Stop, which closes it too', async () => {
    const user = userEvent.setup();
    render(<MembersStack members={MEMBERS} currentUserId='u-vw' currentUserRole='viewer' onlineUserIds={new Set(['u-vw', 'u-ed'])} />);
    await user.click(screen.getByTestId('members-trigger'));
    await user.click(screen.getByTestId('members-follow-m-ed'));
    expect(useFollowStore.getState().targetUserId).toBe('u-ed');
    expect(useFollowStore.getState().targetName).toBe('Editor Person');
    expect(screen.queryByTestId('members-popover')).toBeNull();
    await user.click(screen.getByTestId('members-trigger'));
    expect(screen.queryByTestId('members-follow-m-ed')).toBeNull();
    await user.click(screen.getByTestId('members-unfollow-m-ed'));
    expect(useFollowStore.getState().targetUserId).toBeNull();
    expect(useFollowStore.getState().stopped?.reason).toBe('button');
    expect(screen.queryByTestId('members-popover')).toBeNull();
  });

  it('switches straight to another member when View is pressed on them', async () => {
    const user = userEvent.setup();
    render(<MembersStack members={MEMBERS} currentUserId='u-vw' onlineUserIds={new Set(['u-own', 'u-ed', 'u-vw'])} />);
    useFollowStore.getState().start('u-ed', 'Editor Person');
    await user.click(screen.getByTestId('members-trigger'));
    await user.click(screen.getByTestId('members-follow-m-own'));
    expect(useFollowStore.getState().targetUserId).toBe('u-own');
    expect(useFollowStore.getState().stopped).toBeNull();
  });

  it('shows nobody online when it is given no presence', async () => {
    const user = userEvent.setup();
    render(<MembersStack members={MEMBERS} currentUserId='u-own' />);
    await user.click(screen.getByTestId('members-trigger'));
    expect(screen.queryByTestId('members-follow-m-ed')).toBeNull();
  });

  it('has no a11y violations with the follow controls open', async () => {
    const user = userEvent.setup();
    const { baseElement } = render(<MembersStack members={MEMBERS} currentUserId='u-own' onlineUserIds={new Set(['u-own', 'u-ed'])} />);
    await user.click(screen.getByTestId('members-trigger'));
    await expectNoA11yViolations(baseElement);
  });

  it('lists external agents under their own heading, each with its name and how it stands (#1488 design 19.2)', async () => {
    const user = userEvent.setup();
    render(
      <MembersStack
        members={MEMBERS}
        currentUserId='u-own'
        agents={[
          { connectionId: 'c-work', label: 'Claude Code · Owner Person', status: 'working' },
          { connectionId: 'c-on', label: 'Cursor · Editor Person', status: 'online' },
          { connectionId: 'c-idle', label: 'Codex · Owner Person', status: 'idle' },
          { connectionId: 'c-off', label: 'Zed · Viewer Person', status: 'offline' },
        ]}
      />,
    );
    await user.click(screen.getByTestId('members-trigger'));
    expect(screen.getByText(t('members.popover.agents'))).toBeInTheDocument();
    const status = (id: string): string | null => screen.getByTestId(`members-agent-status-${id}`).textContent;
    expect(screen.getByTestId('members-agent-c-work')).toHaveTextContent('Claude Code · Owner Person');
    expect(status('c-work')).toBe(t('members.popover.working'));
    expect(status('c-on')).toBe(t('members.popover.online'));
    expect(status('c-idle')).toBe(t('members.popover.idle'));
    expect(status('c-off')).toBe(t('members.popover.offline'));
  });

  it('keeps the agent heading with an empty line when no agent has been here', async () => {
    const user = userEvent.setup();
    render(<MembersStack members={MEMBERS} currentUserId='u-own' />);
    await user.click(screen.getByTestId('members-trigger'));
    expect(screen.getByText(t('members.popover.agents'))).toBeInTheDocument();
    expect(screen.getByText(t('members.popover.noAgents'))).toBeInTheDocument();
  });
});
