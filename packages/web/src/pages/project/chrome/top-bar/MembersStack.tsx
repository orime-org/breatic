import * as React from 'react';

import { Avatar, AvatarFallback } from '@/components/ui/avatar';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover';
import { cn } from '@/lib/utils';

interface Member {
  id: string;
  name: string;
}

interface MembersStackProps {
  projectId: string;
  members?: ReadonlyArray<Member>;
}

const DEFAULT_MEMBERS: ReadonlyArray<Member> = [{ id: 'me', name: 'You' }];

/**
 * Stacked members avatars · TopBar group A (mock § TopBar v4.0).
 *
 * Layout:
 *   - 2-3 visible avatars at `--avatar-xs` (20px) overlapping by 4px
 *   - 4th+ collapsed into a `+N` chip (same size as an avatar)
 *   - inline chevron-down indicates popover trigger
 *
 * Clicking opens the members popover (full list + invite — wired in a
 * later PR; PR shows a placeholder body).
 */
export const MembersStack = React.forwardRef<
  HTMLButtonElement,
  MembersStackProps
>(({ projectId, members = DEFAULT_MEMBERS }, ref) => {
  const visible = members.slice(0, 2);
  const overflow = members.length - visible.length;
  return (
    <Popover>
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
                name={m.name}
                style={{ marginLeft: i === 0 ? 0 : '-4px', zIndex: 10 - i }}
              />
            ))}
            {overflow > 0 ? (
              <AvatarChip
                key='overflow'
                name={`+${overflow}`}
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
        className='w-64'
        data-testid='members-popover'
      >
        <div className='text-sm text-muted-foreground'>
          Members of project {projectId} (popover body wired in a later PR)
        </div>
      </PopoverContent>
    </Popover>
  );
});
MembersStack.displayName = 'MembersStack';

function AvatarChip({
  name,
  muted,
  style,
}: {
  name: string;
  muted?: boolean;
  style?: React.CSSProperties;
}) {
  return (
    <Avatar
      style={{
        width: 'var(--avatar-xs)',
        height: 'var(--avatar-xs)',
        ...style,
      }}
      className={cn(
        'border-2 border-background',
        muted && 'bg-muted text-muted-foreground',
      )}
    >
      <AvatarFallback className='text-[10px] font-semibold'>
        {name.slice(0, 2).toUpperCase()}
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
