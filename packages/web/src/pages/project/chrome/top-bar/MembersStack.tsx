import { Plus, Users } from 'lucide-react';
import * as React from 'react';

import { Avatar, AvatarFallback } from '@/components/ui/avatar';
import { Button } from '@/components/ui/button';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover';
import { Separator } from '@/components/ui/separator';
import { cn } from '@/lib/utils';
import { useUIStore } from '@/stores';
import { useTranslation } from '@/i18n/use-translation';

export type MemberRole = 'owner' | 'editor' | 'viewer';

export interface Member {
  id: string;
  name: string;
  initials: string;
  role: MemberRole;
  isMe?: boolean;
}

interface MembersStackProps {
  projectId: string;
  members?: ReadonlyArray<Member>;
}

const STUB_MEMBERS: ReadonlyArray<Member> = [
  { id: 'me', name: 'Songxiu Lei', initials: 'SX', role: 'owner', isMe: true },
  { id: 'yj', name: 'Yuki Jia', initials: 'YJ', role: 'editor' },
  { id: 'dm', name: 'Diana Marquez', initials: 'DM', role: 'editor' },
  { id: 'rt', name: 'Ryo Tanaka', initials: 'RT', role: 'viewer' },
  { id: 'pl', name: 'Priya Lokesh', initials: 'PL', role: 'viewer' },
];

const ROLE_KEY: Record<MemberRole, 'role.owner' | 'role.editor' | 'role.viewer'> = {
  owner: 'role.owner',
  editor: 'role.editor',
  viewer: 'role.viewer',
};

/**
 * Members trigger + popover · TopBar group A (mock § TopBar v4.0).
 *
 * Layout:
 *   - trigger: 2 visible avatars at `--avatar-xs` overlapping by 4 px;
 *     a `+N` chip collapses the rest, inline chevron-down
 *   - popover content (chrome-baseline `.menu-popover.anchor-members.large`):
 *       Project members [count]
 *       member rows (avatar + name + role tag + remove on hover)
 *       --------
 *       [+ Invite new member]  → close popover + open Share popover
 *       [Manage collaborators] → close popover + open Members Modal
 *
 * Member data is currently a 5-row stub; real backend wiring lands
 * with the project-members API in a later PR.
 */
export const MembersStack = React.forwardRef<
  HTMLButtonElement,
  MembersStackProps
>(({ members = STUB_MEMBERS }, ref) => {
  const t = useTranslation();
  const visible = members.slice(0, 2);
  const overflow = members.length - visible.length;
  const [open, setOpen] = React.useState(false);
  const setShareOpen = useUIStore((s) => s.setShareOpen);
  const setMembersModalOpen = useUIStore((s) => s.setMembersModalOpen);

  const openInvite = () => {
    setOpen(false);
    setShareOpen(true);
  };
  const openManage = () => {
    setOpen(false);
    setMembersModalOpen(true);
  };

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
                initials={m.initials}
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
              <MemberRow member={m} />
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

function MemberRow({ member }: { member: Member }) {
  const t = useTranslation();
  return (
    <div className='group flex items-center gap-2 rounded-chrome px-2 py-1.5 hover:bg-accent'>
      <Avatar className='h-8 w-8 shrink-0'>
        <AvatarFallback className='text-[12px] font-semibold'>
          {member.initials}
        </AvatarFallback>
      </Avatar>
      <div className='flex min-w-0 flex-1 flex-col gap-0.5'>
        <span className='flex items-center gap-1.5 truncate text-[13px] text-foreground'>
          {member.name}
          {member.isMe ? (
            <span className='text-[12px] text-muted-foreground'>
              {t('members.popover.isMe')}
            </span>
          ) : null}
        </span>
        <span
          className={cn(
            'text-[12px]',
            member.role === 'owner'
              ? 'font-medium text-foreground'
              : 'text-muted-foreground',
          )}
        >
          {t(ROLE_KEY[member.role])}
        </span>
      </div>
      {member.role !== 'owner' ? (
        <Button
          variant='outline'
          size='sm'
          aria-label={`Remove ${member.name}`}
          className='h-7 shrink-0 px-3 text-[12px] opacity-0 transition-opacity group-hover:opacity-100'
          data-testid={`members-remove-${member.id}`}
        >
          {t('members.popover.remove')}
        </Button>
      ) : null}
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
