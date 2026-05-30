import { Plus, Users } from 'lucide-react';
import * as React from 'react';
import { toast } from 'sonner';

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
import { membersApi } from '@web/data/api/members';
import type { Member, MemberRole } from '@web/data/api/members';

export type { Member, MemberRole };

interface MembersStackProps {
  projectId: string;
  members?: ReadonlyArray<Member>;
  currentUserId?: string;
}

const STUB_MEMBERS: ReadonlyArray<Member> = [
  { id: 'me', userId: 'u-me', name: 'Songxiu Lei', email: 'sx@example.com', role: 'owner' },
  { id: 'yj', userId: 'u-yj', name: 'Yuki Jia', email: 'yj@example.com', role: 'edit' },
  { id: 'dm', userId: 'u-dm', name: 'Diana Marquez', email: 'dm@example.com', role: 'edit' },
  { id: 'rt', userId: 'u-rt', name: 'Ryo Tanaka', email: 'rt@example.com', role: 'view' },
  { id: 'pl', userId: 'u-pl', name: 'Priya Lokesh', email: 'pl@example.com', role: 'view' },
];

const ROLE_KEY: Record<MemberRole, 'role.owner' | 'role.editor' | 'role.viewer'> = {
  owner: 'role.owner',
  edit: 'role.editor',
  view: 'role.viewer',
};

function initialsOf(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '?';
  if (parts.length === 1) return parts[0]!.slice(0, 2).toUpperCase();
  return (parts[0]![0]! + parts[parts.length - 1]![0]!).toUpperCase();
}

/**
 * Members trigger + popover · TopBar group A.
 *
 * Stack now uses backend `Member` shape ({id, userId, name, email, role})
 * per 2026-05-28 spec § 5; subtitle below each member name shows email
 * instead of the previous lowercased-initials placeholder. Remove
 * button on hover calls `membersApi.remove` directly; cache invalidation
 * happens in the parent (this component stays stateless on member
 * data — caller passes `members` + `currentUserId`).
 *
 * Tests use the STUB_MEMBERS fallback by omitting the `members` prop;
 * production callers should pass real data fetched via React Query.
 *
 * Spec: access-permission design (2026-05-28) § 5.
 */
export const MembersStack = React.forwardRef<
  HTMLButtonElement,
  MembersStackProps
>(({ projectId, members = STUB_MEMBERS, currentUserId }, ref) => {
  const t = useTranslation();
  const visible = members.slice(0, 2);
  const overflow = members.length - visible.length;
  const [open, setOpen] = React.useState(false);
  const setShareOpen = useUIStore((s) => s.setShareOpen);
  const setActiveOverlayId = useUIStore((s) => s.setActiveOverlayId);
  const [pendingRemoveId, setPendingRemoveId] = React.useState<string | null>(
    null,
  );

  const openInvite = () => {
    setOpen(false);
    setShareOpen(true);
  };
  const openManage = () => {
    setOpen(false);
    setActiveOverlayId('members-modal');
  };

  async function handleRemove(member: Member) {
    if (pendingRemoveId) return;
    setPendingRemoveId(member.id);
    try {
      await membersApi.remove(projectId, member.id);
      toast.success(t('members.popover.removeSuccess'));
    } catch {
      toast.error(t('members.popover.removeFailed'));
    } finally {
      setPendingRemoveId(null);
    }
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          ref={ref}
          type='button'
          aria-label={`Project members (${members.length})`}
          aria-haspopup='dialog'
          data-testid='members-trigger'
          className='inline-flex shrink-0 items-center text-muted-foreground transition-colors hover:bg-muted hover:text-foreground'
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
              <AvatarChip
                key={m.id}
                initials={initialsOf(m.name)}
                style={{ marginLeft: i === 0 ? 0 : '-4px', zIndex: 10 - i }}
              />
            ))}
            {overflow > 0 ? (
              <AvatarChip
                key='overflow'
                initials={`+${overflow}`}
                muted
                style={{ marginLeft: '-4px', zIndex: 1 }}
              />
            ) : null}
          </span>
          <Chevron />
        </button>
      </PopoverTrigger>
      <PopoverContent
        align='end'
        className='w-72 p-1'
        data-testid='members-popover'
      >
        <div className='flex items-center justify-between px-2 pb-1 pt-2'>
          <span className='text-[11px] font-medium uppercase tracking-wide text-muted-foreground'>
            {t('members.popover.title')}
          </span>
          <span className='text-[11px] tabular-nums text-muted-foreground'>
            {members.length}
          </span>
        </div>
        <ul className='flex flex-col gap-0.5'>
          {members.map((m) => (
            <li key={m.id} data-testid={`members-row-${m.id}`}>
              <MemberRow
                member={m}
                isMe={currentUserId !== undefined && m.userId === currentUserId}
                onRemove={() => handleRemove(m)}
                removePending={pendingRemoveId === m.id}
              />
            </li>
          ))}
        </ul>
        <Separator className='my-1' />
        <div className='flex flex-col gap-2 p-2'>
          <Button
            variant='outline'
            size='sm'
            className='w-full justify-center gap-2 text-[13px]'
            onClick={openInvite}
            data-testid='members-invite-trigger'
          >
            <Plus className='h-4 w-4' />
            {t('members.popover.invite')}
          </Button>
          <Button
            variant='outline'
            size='sm'
            className='w-full justify-center gap-2 text-[13px]'
            onClick={openManage}
            data-testid='members-manage-trigger'
          >
            <Users className='h-4 w-4' />
            {t('members.popover.manage')}
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  );
});
MembersStack.displayName = 'MembersStack';

interface MemberRowProps {
  member: Member;
  isMe: boolean;
  onRemove: () => void;
  removePending: boolean;
}

function MemberRow({ member, isMe, onRemove, removePending }: MemberRowProps) {
  const t = useTranslation();
  return (
    <div className='group flex items-center gap-2 rounded-chrome px-2 py-1.5 hover:bg-accent'>
      <Avatar className='h-8 w-8 shrink-0'>
        <AvatarFallback className='text-[12px] font-semibold'>
          {initialsOf(member.name)}
        </AvatarFallback>
      </Avatar>
      <div className='flex min-w-0 flex-1 flex-col gap-0.5'>
        <span className='flex items-center gap-1.5 truncate text-[13px] text-foreground'>
          {member.name}
          {isMe ? (
            <span className='text-[12px] text-muted-foreground'>
              {t('members.popover.isMe')}
            </span>
          ) : null}
        </span>
        <span
          className={cn(
            'truncate text-[12px]',
            member.role === 'owner'
              ? 'font-medium text-foreground'
              : 'text-muted-foreground',
          )}
        >
          {member.email}
        </span>
      </div>
      {member.role !== 'owner' && !isMe ? (
        <Button
          variant='outline'
          size='sm'
          aria-label={`Remove ${member.name}`}
          className='h-7 shrink-0 px-3 text-[12px] opacity-0 transition-opacity group-hover:opacity-100'
          disabled={removePending}
          onClick={onRemove}
          data-testid={`members-remove-${member.id}`}
        >
          {t('members.popover.remove')}
        </Button>
      ) : (
        <span
          className={cn(
            'shrink-0 text-[11px] uppercase tracking-wide',
            member.role === 'owner' ? 'text-foreground font-medium' : 'text-muted-foreground',
          )}
        >
          {t(ROLE_KEY[member.role])}
        </span>
      )}
    </div>
  );
}

function AvatarChip({
  initials,
  muted,
  style,
}: {
  initials: string;
  muted?: boolean;
  style?: React.CSSProperties;
}) {
  return (
    <Avatar
      style={{
        width: 'var(--avatar-sm)',
        height: 'var(--avatar-sm)',
        ...style,
      }}
      className={cn(
        'border-2 border-background',
        muted && 'bg-muted text-muted-foreground',
      )}
    >
      <AvatarFallback className='text-[10px] font-semibold'>
        {initials.slice(0, 2).toUpperCase()}
      </AvatarFallback>
    </Avatar>
  );
}

function Chevron() {
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
