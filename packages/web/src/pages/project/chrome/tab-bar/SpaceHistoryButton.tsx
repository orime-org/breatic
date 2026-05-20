import { History } from 'lucide-react';

import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover';
import { Button } from '@/components/ui/button';

interface SpaceHistoryButtonProps {
  /** True if there's unseen activity (creates / deletes / locks). */
  hasUnread?: boolean;
}

/**
 * Space activity history — chrome-baseline `.bell-dot` button on the
 * right side of the space header. Shows recent create / delete /
 * lock events for the current project's spaces.
 *
 * PR 4 renders a stub popover; the real event feed lands when the
 * backend space-events stream is wired.
 */
export function SpaceHistoryButton({ hasUnread }: SpaceHistoryButtonProps) {
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          variant='chrome-ghost'
          size='chrome'
          aria-label='Space activity history'
          data-testid='space-history-trigger'
          className='relative'
          style={{ height: 'var(--btn-chrome)', width: 'var(--btn-chrome)' }}
        >
          <History className='h-[18px] w-[18px]' />
          {hasUnread ? (
            <span
              className='absolute rounded-full bg-status-error-border'
              style={{ top: 5, right: 5, width: 6, height: 6 }}
            />
          ) : null}
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align='end'
        className='w-72'
        data-testid='space-history-popover'
      >
        <div className='text-sm text-muted-foreground'>
          No recent space activity. Create / delete / lock events appear here.
        </div>
      </PopoverContent>
    </Popover>
  );
}
