// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

import { Eye, LogOut, Users, X } from 'lucide-react';
import * as React from 'react';

import { Avatar, AvatarFallback } from '@web/components/ui/avatar';
import { Button } from '@web/components/ui/button';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@web/components/ui/popover';
import { Separator } from '@web/components/ui/separator';
import { cn } from '@web/lib/utils';
import { useUIStore } from '@web/stores';
import { stopFollowing, useFollowStore } from '@web/stores/follow';
import { useTranslation } from '@web/i18n/use-translation';
import type { Member, MemberRole } from '@web/data/api/members';
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
}

const NOBODY_ONLINE: ReadonlySet<string> = new Set();

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
>(({ members, currentUserId, currentUserRole, onLeave, onlineUserIds = NOBODY_ONLINE }, ref) => {
  const t = useTranslation();
  // Owner-only affordance (B model — hidden, not disabled): the manage
  // button only renders when the current user is owner.
  const isOwner = currentUserRole === 'owner';
  const visible = members.slice(0, 2);
  const overflow = members.length - visible.length;
  const [open, setOpen] = React.useState(false);
  const setActiveOverlayId = useUIStore((s) => s.setActiveOverlayId);
  const followedUserId = useFollowStore((s) => s.targetUserId);
  const titleId = React.useId();

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
              />
            </li>
          ))}
        </ul>
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
}

/**
 * One member row inside the stack popover — avatar, name/email, online or
 * offline, role badge, and for another member who is online View (follow
 * them) or, while following them, Stop (#920). Remove / role changes live in
 * the manage modal.
 * @param root0 - Member row props.
 * @param root0.member - Member rendered by this row.
 * @param root0.isMe - Whether this row is the current user (annotates the name, no View).
 * @param root0.online - Whether the member is connected to this project.
 * @param root0.followed - Whether this user is following the member.
 * @returns the popover member row.
 */
function MemberRow({ member, isMe, online, followed }: MemberRowProps): React.JSX.Element {
  const t = useTranslation();
  const { userId, name } = member;
  const follow = React.useCallback((): void => useFollowStore.getState().start(userId, name), [userId, name]);
  const unfollow = React.useCallback((): void => stopFollowing('button'), []);
  return (
    <div className='group flex items-center gap-2 rounded-chrome px-2 py-1.5 hover:bg-accent'>
      <StudioAvatar
        name={member.name}
        type='personal'
        avatarUrl={member.avatarUrl ?? null}
        size='md'
      />
      <div className='flex min-w-0 flex-1 flex-col gap-0.5'>
        <span className='flex items-center gap-1.5 truncate text-sm text-foreground'>
          {member.name}
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
          className='shrink-0 gap-1 text-xs'
          icon={<Eye className='size-3.5' />}
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
