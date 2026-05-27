import { Bell } from 'lucide-react';
import * as React from 'react';

import { Avatar, AvatarFallback } from '@/components/ui/avatar';
import { Button } from '@/components/ui/button';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover';
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import { useTranslation } from '@/i18n/use-translation';

interface BellMenuProps {
  unreadCount?: number;
}

type RequestMessageKey =
  | 'notifications.request.audio'
  | 'notifications.request.project';

interface AccessRequest {
  id: string;
  initials: string;
  name: string;
  messageKey: RequestMessageKey;
  roleHint: 'edit' | 'view';
  timeLabel: string;
}

const STUB_REQUESTS: ReadonlyArray<AccessRequest> = [
  {
    id: 'req-lh',
    initials: 'LH',
    name: 'Linh Huang',
    messageKey: 'notifications.request.audio',
    roleHint: 'edit',
    timeLabel: '2m ago',
  },
  {
    id: 'req-mk',
    initials: 'MK',
    name: 'Mika Kobayashi',
    messageKey: 'notifications.request.project',
    roleHint: 'view',
    timeLabel: '15m ago',
  },
];

/**
 * Notifications bell — popover lists pending access requests (and later
 * tasks / mentions / system events). PR 4 ships the chrome + a stub list
 * with two access requests so the visual flow is verifiable. The real
 * feed lands when the notifications endpoint + Yjs awareness stream
 * arrive.
 */
export function BellMenu({ unreadCount }: BellMenuProps) {
  const t = useTranslation();
  const requests = STUB_REQUESTS;
  const count = unreadCount ?? requests.length;
  return (
    <Popover>
      <Tooltip>
        <TooltipTrigger asChild>
          <PopoverTrigger asChild>
            <Button
              variant='chrome-ghost'
              size='chrome'
              aria-label='Notifications'
              className='relative'
              data-testid='bell-trigger'
            >
              <Bell className='h-[18px] w-[18px]' />
              {count > 0 ? (
                <span className='absolute right-1 top-1 h-2 w-2 rounded-full bg-destructive' />
              ) : null}
            </Button>
          </PopoverTrigger>
        </TooltipTrigger>
        <TooltipContent side='bottom'>
          {t('chrome.tooltip.notifications')}
        </TooltipContent>
      </Tooltip>
      <PopoverContent
        align='end'
        className='w-80 p-1'
        data-testid='bell-popover'
      >
        <div className='flex items-center justify-between px-2 pb-1 pt-2'>
          <span className='text-[11px] font-medium uppercase tracking-wide text-muted-foreground'>
            {t('notifications.title')}
          </span>
          <span className='text-[11px] tabular-nums text-muted-foreground'>
            {count}
          </span>
        </div>
        {requests.length === 0 ? (
          <div className='px-3 py-2 text-[13px] text-muted-foreground'>
            {t('notifications.empty')}
          </div>
        ) : (
          <ul className='flex flex-col gap-1'>
            {requests.map((req) => (
              <li key={req.id} data-testid={`bell-request-${req.id}`}>
                <RequestItem request={req} />
              </li>
            ))}
          </ul>
        )}
      </PopoverContent>
    </Popover>
  );
}

function RequestItem({ request }: { request: AccessRequest }) {
  const t = useTranslation();
  return (
    <div className='flex flex-col gap-2 rounded-chrome px-2 py-2 hover:bg-accent'>
      <div className='flex items-start gap-2'>
        <Avatar className='h-9 w-9 shrink-0'>
          <AvatarFallback className='text-[12px] font-semibold'>
            {request.initials}
          </AvatarFallback>
        </Avatar>
        <div className='flex min-w-0 flex-1 flex-col gap-0.5'>
          <span className='truncate text-[13px] font-medium text-foreground'>
            {request.name}
          </span>
          <span className='truncate text-[12px] text-muted-foreground'>
            {t(request.messageKey)}
          </span>
        </div>
        <span className='shrink-0 self-start rounded-[4px] bg-muted px-1 py-0.5 text-[11px] font-medium text-muted-foreground'>
          {request.roleHint === 'edit'
            ? t('notifications.roleHint.editor')
            : t('notifications.roleHint.viewer')}
        </span>
      </div>
      <div className='flex items-center justify-between gap-2 pl-11'>
        <span className='text-[11px] text-muted-foreground'>
          {request.timeLabel}
        </span>
        <div className='flex items-center gap-2'>
          <Button variant='outline' size='sm' className='h-7 px-3 text-[12px]'>
            {t('notifications.reject')}
          </Button>
          <Button size='sm' className='h-7 px-3 text-[12px]'>
            {t('notifications.approve')}
          </Button>
        </div>
      </div>
    </div>
  );
}
