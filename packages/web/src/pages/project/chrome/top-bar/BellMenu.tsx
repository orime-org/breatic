import { Bell } from 'lucide-react';

import { Button } from '@/components/ui/button';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover';

interface BellMenuProps {
  unreadCount?: number;
}

/**
 * Notifications bell — popover lists task / mention / system events. PR 4
 * renders the trigger + popover container; the real feed lands when the
 * notifications endpoint + Yjs awareness stream are wired up later.
 */
export function BellMenu({ unreadCount = 0 }: BellMenuProps) {
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          variant='ghost'
          size='icon'
          aria-label='Notifications'
          className='relative'
          data-testid='bell-trigger'
        >
          <Bell className='h-4 w-4' />
          {unreadCount > 0 ? (
            <span className='absolute right-1 top-1 h-2 w-2 rounded-full bg-destructive' />
          ) : null}
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align='end'
        className='w-72'
        data-testid='bell-popover'
      >
        <div className='text-sm text-muted-foreground'>
          {unreadCount > 0
            ? `${unreadCount} new notification${unreadCount === 1 ? '' : 's'}`
            : 'No new notifications'}
        </div>
      </PopoverContent>
    </Popover>
  );
}
