// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import { Bot, Eye, LogOut, Users, X } from 'lucide-react';
import * as React from 'react';

import { Avatar, AvatarFallback } from '@web/components/ui/avatar';
import { Button } from '@web/components/ui/button';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@web/components/ui/popover';
import { Separator } from '@web/components/ui/separator';
import { toast } from '@web/lib/toast';
import { cn } from '@web/lib/utils';
import { useUIStore } from '@web/stores';
import { stopFollowing, useFollowStore, type FollowOther } from '@web/stores/follow';
import { useTranslation } from '@web/i18n/use-translation';
import type { Member, MemberRole } from '@web/data/api/members';
import type { AgentRow, AgentStatus } from '@web/features/agent-presence/agent-status';
import { StudioAvatar } from '@web/ui/StudioAvatar';

export type { Member, MemberRole };

interface MembersStackProps {
  /**
   * The project's roster. Required, and deliberately so: this used to default
   * to five invented people, which put them one forgotten prop away from the
   * screen. A component with no data should render none, not make some up.
   */
  members: ReadonlyArray<Member>;
  currentUserId?: string;
  /**
   * Current user's role on the project. Drives the owner-only "Manage
   * collaborators" footer button (B model — hidden, not disabled, for
   * editor / viewer). Backend `requireRole` is the real enforcement.
   */
  currentUserRole?: MemberRole;
  /**
   * Leave the project. Given only when the user may leave (a live
   * project's editor or viewer); the list then ends with "Leave project"
   * where the owner's ends with "Manage collaborators".
   */
  onLeave?: () => void;
  /**
   * User ids the server holds a connection for in this project (the meta
   * `users` records with `online`). Rows of other members in it offer View,
   * which follows them (#920).
   */
  onlineUserIds?: ReadonlySet<string>;
  /**
   * Whom each member is following here, by user id; members following nobody
   * here are absent (#920). Following is one level deep: View on a member in
   * it is dimmed and pressing it says whom they follow.
   */
  followTargets?: ReadonlyMap<string, FollowOther>;
  /**
   * External agents that have worked in this project, each with its
   * "connection · owner" name and how it stands (#1488 design 19.2).
   */
  agents?: ReadonlyArray<AgentRow>;
}

const NO_AGENTS: ReadonlyArray<AgentRow> = [];

const AGENT_STATUS_KEY: Record<AgentStatus, 'members.popover.working' | 'members.popover.online' | 'members.popover.idle' | 'members.popover.offline'> = {
  working: 'members.popover.working',
  online: 'members.popover.online',
  idle: 'members.popover.idle',
  offline: 'members.popover.offline',
};

const AGENT_DOT: Record<AgentStatus, string> = {
  working: 'bg-status-success',
  online: 'bg-status-success',
  idle: 'bg-status-warning',
  offline: 'bg-muted-foreground/40',
};

const NOBODY_ONLINE: ReadonlySet<string> = new Set();
const NOBODY_FOLLOWING: ReadonlyMap<string, FollowOther> = new Map();

const ROLE_KEY: Record<MemberRole, 'role.owner' | 'role.editor' | 'role.viewer'> = {
  owner: 'role.owner',
  editor: 'role.editor',
  viewer: 'role.viewer',
};

/**
 * Members trigger + popover · TopBar group A.
 *
 * Stack uses the backend `Member` shape ({id, userId, name, email, role})
 * per 2026-05-28 spec § 5; the subtitle below each member name shows the
 * email. Every row shows whether the member is online and their role badge,
 * and another member's row, while they are online, offers View to follow
 * them (#920); the footer holds at most one action — "Manage collaborators" for the owner,
 * "Leave project" for a member who may leave. Removing / changing a member lives solely in the "Manage
 * collaborators" modal (owner-only); the popover never offers a remove
 * control (2026-06-18 — the per-row hover-remove was dropped so remove
 * has a single home).
 *
 * Every caller passes the roster; there is no fallback to omit it in favour
 * of. `useProjectMembers` supplies it, and it is an empty array until both
 * of that hook's queries resolve.
 *
 * Spec: access-permission design (2026-05-28) § 5.
 */
export const MembersStack = React.forwardRef<
  HTMLButtonElement,
  MembersStackProps
>(({ members, currentUserId, currentUserRole, onLeave, onlineUserIds = NOBODY_ONLINE, followTargets = NOBODY_FOLLOWING, agents = NO_AGENTS }, ref) => {
  const t = useTranslation();
  // Owner-only affordance (B model — hidden, not disabled): the manage
  // button only renders when the current user is owner.
  const isOwner = currentUserRole === 'owner';
  const visible = members.slice(0, 2);
  const overflow = members.length - visible.length;
  const [open, setOpen] = React.useState(false);
  const close = React.useCallback((): void => setOpen(false), []);
  const setActiveOverlayId = useUIStore((s) => s.setActiveOverlayId);
  const followedUserId = useFollowStore((s) => s.targetUserId);
  const titleId = React.useId();

  /**
   * What pressing View on a member says when they are following someone here.
   * @param member - The row's member.
   * @returns The notice, or null when the member follows nobody here.
   */
  const busyNotice = (member: Member): string | null => {
    const other = followTargets.get(member.userId);
    if (other === undefined) return null;
    return other === 'you'
      ? t('members.follow.busyYou', { name: member.name })
      : t('members.follow.busy', { name: member.name, other: other.name });
  };

  const openManage = React.useCallback((): void => {
    setOpen(false);
    setActiveOverlayId('members-modal');
  }, [setActiveOverlayId]);

  const startLeave = React.useCallback((): void => {
    setOpen(false);
    onLeave?.();
  }, [onLeave]);

  // The footer holds one action: "Manage collaborators" for the owner,
  // "Leave project" for a user the page lets leave, nothing for anyone else.
  const footer = isOwner
    ? {
      onClick: openManage,
      icon: Users,
      label: t('members.popover.manage'),
      testId: 'members-manage-trigger',
      variant: 'outline' as const,
    }
    : onLeave
      ? {
        onClick: startLeave,
        icon: LogOut,
        label: t('project.leave.action'),
        testId: 'members-leave-trigger',
        variant: 'destructive' as const,
      }
      : null;

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant={null}
          size={null}
          ref={ref}
          type='button'
          aria-label={t('members.stack.triggerAria', { count: members.length })}
          aria-haspopup='dialog'
          data-testid='members-trigger'
          // `w-auto` releases the square width the chrome size sets: this
          // trigger is a 32px-tall chrome control, but as wide as the avatar
          // stack plus the chevron.
          className='inline-flex shrink-0 items-center text-muted-foreground transition-colors hover:bg-accent hover:text-foreground'
          style={{
            height: 'var(--btn-chrome)',
            padding: '0 var(--space-2) 0 var(--space-2)',
            gap: 'var(--space-2)',
            borderRadius: 'var(--radius-chrome)',
          }}
        >
          <span
            className='inline-flex items-center'
            style={{ marginRight: '-4px' }}
          >
            {visible.map((m, i) => (
              // The stacking offset lives on a wrapper so the avatar itself
              // stays a plain avatar with no positioning of its own.
              <span
                key={m.id}
                className='inline-flex'
                style={{ marginLeft: i === 0 ? 0 : '-4px', zIndex: 10 - i }}
              >
                <StudioAvatar
                  name={m.name}
                  type='personal'
                  avatarUrl={m.avatarUrl ?? null}
                  size='sm'
                  className='border border-background'
                />
              </span>
            ))}
            {overflow > 0 ? (
              <OverflowChip
                count={overflow}
                style={{ marginLeft: '-4px', zIndex: 1 }}
              />
            ) : null}
          </span>
          <Chevron />
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align='end'
        className='w-72 p-1'
        data-testid='members-popover'
        aria-labelledby={titleId}
      >
        <div className='flex items-center justify-between px-2 pb-1 pt-2'>
          <span
            id={titleId}
            className='text-2xs font-medium tracking-wide text-muted-foreground'
            data-testid='members-popover-title'
          >
            {t('members.popover.title')}
          </span>
          <span className='text-2xs tabular-nums text-muted-foreground'>
            {members.length}
          </span>
        </div>
        <ul className='flex flex-col gap-0.5'>
          {members.map((m) => (
            <li key={m.id} data-testid={`members-row-${m.id}`}>
              <MemberRow
                member={m}
                isMe={currentUserId !== undefined && m.userId === currentUserId}
                online={onlineUserIds.has(m.userId)}
                followed={followedUserId === m.userId}
                busyNotice={busyNotice(m)}
                onFollowChanged={close}
              />
            </li>
          ))}
        </ul>
        <Separator className='my-1' />
        <div className='px-2 pb-1 pt-1'>
          <span className='text-2xs font-medium tracking-wide text-muted-foreground'>
            {t('members.popover.agents')}
          </span>
        </div>
        {agents.length === 0 ? (
          <p className='px-2 pb-1.5 text-xs text-muted-foreground'>{t('members.popover.noAgents')}</p>
        ) : (
          <ul className='flex flex-col gap-0.5'>
            {agents.map((a) => (
              <li key={a.connectionId} data-testid={`members-agent-${a.connectionId}`}>
                <AgentRowView row={a} />
              </li>
            ))}
          </ul>
        )}
        {/* No footer at all for a user without an action: no separator,
            no padded gap. Removing / role-changing members happens inside
            the manage modal — never inline in the popover. */}
        {footer ? (
          <>
            <Separator className='my-1' />
            <div className='flex flex-col gap-2 p-2'>
              <Button
                variant={footer.variant}
                size='form'
                className='w-full justify-center gap-2 text-sm'
                onClick={footer.onClick}
                data-testid={footer.testId}
              >
                <footer.icon className='h-4 w-4' />
                {footer.label}
              </Button>
            </div>
          </>
        ) : null}
      </PopoverContent>
    </Popover>
  );
});
MembersStack.displayName = 'MembersStack';

interface MemberRowProps {
  member: Member;
  isMe: boolean;
  online: boolean;
  followed: boolean;
  busyNotice: string | null;
  onFollowChanged: () => void;
}

/**
 * One member row inside the stack popover — avatar, name/email, online or
 * offline, role badge, and for another member who is online View (follow
 * them) or, while following them, Stop (#920); View on a member who is
 * following someone is dimmed and says whom instead. Remove / role changes
 * live in the manage modal.
 * @param root0 - Member row props.
 * @param root0.member - Member rendered by this row.
 * @param root0.isMe - Whether this row is the current user (annotates the name, no View).
 * @param root0.online - Whether the member is connected to this project.
 * @param root0.followed - Whether this user is following the member.
 * @param root0.busyNotice - Whom the member is following, said instead of following them; null when they follow nobody.
 * @param root0.onFollowChanged - Called once View started following the member or Stop ended it.
 * @returns the popover member row.
 */
function MemberRow({ member, isMe, online, followed, busyNotice, onFollowChanged }: MemberRowProps): React.JSX.Element {
  const t = useTranslation();
  const { userId, name } = member;
  // Following is one level deep: a member who is following someone is not followed.
  const follow = React.useCallback((): void => {
    if (busyNotice !== null) {
      toast.warning(busyNotice);
      return;
    }
    useFollowStore.getState().start(userId, name);
    onFollowChanged();
  }, [userId, name, busyNotice, onFollowChanged]);
  const unfollow = React.useCallback((): void => {
    stopFollowing('button');
    onFollowChanged();
  }, [onFollowChanged]);
  return (
    <div className='group flex items-center gap-2 rounded-chrome px-2 py-1.5 hover:bg-accent'>
      <StudioAvatar
        name={member.name}
        type='personal'
        avatarUrl={member.avatarUrl ?? null}
        size='md'
      />
      <div className='flex min-w-0 flex-1 flex-col gap-0.5'>
        <span className='flex items-center gap-1.5 text-sm text-foreground'>
          <span className='min-w-0 truncate'>{member.name}</span>
          {isMe ? (
            <span className='text-xs text-muted-foreground'>
              {t('members.popover.isMe')}
            </span>
          ) : null}
        </span>
        <span
          className={cn(
            'truncate text-xs',
            member.role === 'owner'
              ? 'font-medium text-foreground'
              : 'text-muted-foreground',
          )}
        >
          {member.email}
        </span>
        <span
          className='flex items-center gap-1 text-xs text-muted-foreground'
          data-testid={`members-status-${member.id}`}
          data-online={online ? 'true' : 'false'}
        >
          <span
            aria-hidden='true'
            className={cn('inline-block size-2 shrink-0 rounded-full', online ? 'bg-status-success' : 'bg-muted-foreground/40')}
          />
          {online ? t('members.popover.online') : t('members.popover.offline')}
        </span>
      </div>
      <span
        className={cn(
          'shrink-0 text-2xs tracking-wide',
          member.role === 'owner' ? 'text-foreground font-medium' : 'text-muted-foreground',
        )}
      >
        {t(ROLE_KEY[member.role])}
      </span>
      {isMe || !online ? null : followed ? (
        <Button
          variant='outline'
          size='compact'
          className='shrink-0 gap-1 text-xs'
          icon={<X className='size-3.5' />}
          onClick={unfollow}
          data-testid={`members-unfollow-${member.id}`}
        >
          {t('members.popover.unfollow')}
        </Button>
      ) : (
        <Button
          variant='outline'
          size='compact'
          className={cn('shrink-0 gap-1 text-xs', busyNotice !== null && 'opacity-50')}
          icon={<Eye className='size-3.5' />}
          aria-disabled={busyNotice !== null || undefined}
          onClick={follow}
          data-testid={`members-follow-${member.id}`}
        >
          {t('members.popover.follow')}
        </Button>
      )}
    </div>
  );
}

/**
 * One external agent in the member list: a robot mark, "connection · owner"
 * and how it stands (#1488 design 19.2).
 * @param root0 - Props.
 * @param root0.row - The agent.
 * @returns The row.
 */
function AgentRowView({ row }: { row: AgentRow }): React.JSX.Element {
  const t = useTranslation();
  return (
    <div className='flex items-center gap-2 rounded-chrome px-2 py-1.5 hover:bg-accent'>
      <span
        aria-hidden='true'
        className='inline-flex shrink-0 items-center justify-center rounded-full bg-muted text-muted-foreground'
        style={{ width: 'var(--avatar-md)', height: 'var(--avatar-md)' }}
      >
        <Bot className='size-4' />
      </span>
      <div className='flex min-w-0 flex-1 flex-col gap-0.5'>
        <span className='truncate text-sm text-foreground'>{row.label}</span>
        <span className='flex items-center gap-1 text-xs text-muted-foreground'>
          <span aria-hidden='true' className={cn('inline-block size-2 shrink-0 rounded-full', AGENT_DOT[row.status])} />
          <span data-testid={`members-agent-status-${row.connectionId}`}>{t(AGENT_STATUS_KEY[row.status])}</span>
        </span>
      </div>
    </div>
  );
}

/**
 * The `+N` bubble closing the stacked member preview when there are more
 * members than fit.
 *
 * It is deliberately NOT a `StudioAvatar`: it stands for a count, not for
 * anyone, so it never shows an image and never takes a name.
 * @param root0 - Overflow chip props.
 * @param root0.count - How many members are hidden behind the chip.
 * @param root0.style - Inline style for stacking offset and z-index.
 * @returns the `+N` bubble.
 */
function OverflowChip({
  count,
  style,
}: {
  count: number;
  style?: React.CSSProperties;
}): React.JSX.Element {
  return (
    <Avatar
      style={{
        width: 'var(--avatar-sm)',
        height: 'var(--avatar-sm)',
        ...style,
      }}
      className='border border-background bg-muted text-muted-foreground'
    >
      <AvatarFallback className='text-2xs font-semibold'>
        {`+${count}`}
      </AvatarFallback>
    </Avatar>
  );
}

/**
 * Small chevron-down glyph shown after the avatar stack on the trigger.
 * @returns the inline chevron-down SVG icon.
 */
function Chevron(): React.JSX.Element {
  return (
    <svg
      width='14'
      height='14'
      viewBox='0 0 24 24'
      fill='none'
      stroke='currentColor'
      strokeWidth='1.75'
      strokeLinecap='round'
      strokeLinejoin='round'
      aria-hidden='true'
      style={{ opacity: 0.5 }}
    >
      <path d='m6 9 6 6 6-6' />
    </svg>
  );
}
