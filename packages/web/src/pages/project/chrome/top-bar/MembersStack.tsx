// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import { Users } from 'lucide-react';
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
}

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
 * email. The popover is read-only — every row shows the member's role
 * badge. Removing / changing a member lives solely in the "Manage
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
>(({ members, currentUserId, currentUserRole }, ref) => {
  const t = useTranslation();
  // Owner-only affordance (B model — hidden, not disabled): the manage
  // button only renders when the current user is owner.
  const isOwner = currentUserRole === 'owner';
  const visible = members.slice(0, 2);
  const overflow = members.length - visible.length;
  const [open, setOpen] = React.useState(false);
  const setActiveOverlayId = useUIStore((s) => s.setActiveOverlayId);

  /**
   * Closes the popover and opens the members-management modal.
   */
  const openManage = (): void => {
    setOpen(false);
    setActiveOverlayId('members-modal');
  };

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
      >
        <div className='flex items-center justify-between px-2 pb-1 pt-2'>
          <span
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
              />
            </li>
          ))}
        </ul>
        {/* Manage collaborators is an owner-only affordance (B model —
            hidden, not disabled, for editor / viewer). The whole footer
            (separator + button) collapses when the user isn't owner so
            there's no empty padded gap. Removing / role-changing members
            happens inside this modal — never inline in the popover. */}
        {isOwner ? (
          <>
            <Separator className='my-1' />
            <div className='flex flex-col gap-2 p-2'>
              <Button
                variant='outline'
                size='form'
                className='w-full justify-center gap-2 text-sm'
                onClick={openManage}
                data-testid='members-manage-trigger'
              >
                <Users className='h-4 w-4' />
                {t('members.popover.manage')}
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
}

/**
 * One member row inside the stack popover — avatar, name/email, role badge.
 * The popover is read-only; remove / role changes live in the manage modal.
 * @param root0 - Member row props.
 * @param root0.member - Member rendered by this row.
 * @param root0.isMe - Whether this row is the current viewer (annotates the name).
 * @returns the popover member row with its role badge.
 */
function MemberRow({ member, isMe }: MemberRowProps): React.JSX.Element {
  const t = useTranslation();
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
      </div>
      <span
        className={cn(
          'shrink-0 text-2xs tracking-wide',
          member.role === 'owner' ? 'text-foreground font-medium' : 'text-muted-foreground',
        )}
      >
        {t(ROLE_KEY[member.role])}
      </span>
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
