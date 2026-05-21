import { Bell } from 'lucide-react';
import * as React from 'react';

import { Avatar, AvatarFallback } from '@/components/ui/avatar';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover';

interface BellMenuProps {
  unreadCount?: number;
}

interface AccessRequest {
  id: string;
  initials: string;
  name: string;
  message: string;
  roleHint: 'edit' | 'view';
  timeLabel: string;
}

const STUB_REQUESTS: ReadonlyArray<AccessRequest> = [
  {
    id: 'req-lh',
    initials: 'LH',
    name: 'Linh Huang',
    message: '想加入做配音和 BGM 部分',
    roleHint: 'edit',
    timeLabel: '2 分钟前',
  },
  {
    id: 'req-mk',
    initials: 'MK',
    name: 'Mika Kobayashi',
    message: '想参考你的 prompt 风格做我自己的项目',
    roleHint: 'view',
    timeLabel: '15 分钟前',
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
  const requests = STUB_REQUESTS;
  const count = unreadCount ?? requests.length;
  return (
    <Popover>
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
      <PopoverContent
        align='end'
        className='w-80 p-1'
        data-testid='bell-popover'
      >
        <div className='flex items-center justify-between px-2 pb-1 pt-2'>
          <span className='text-[11px] font-medium uppercase tracking-wide text-muted-foreground'>
            访问申请
          </span>
          <span className='text-[11px] tabular-nums text-muted-foreground'>
            {count}
          </span>
        </div>
        {requests.length === 0 ? (
          <div className='px-3 py-2 text-[13px] text-muted-foreground'>
            没有待处理通知
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
            {request.message}
          </span>
        </div>
        <Badge variant='outline' className='shrink-0 text-[11px]'>
          {request.roleHint === 'edit' ? '编辑' : '查看'}
        </Badge>
      </div>
      <div className='flex items-center justify-between gap-2 pl-11'>
        <span className='text-[11px] text-muted-foreground'>
          {request.timeLabel}
        </span>
        <div className='flex items-center gap-2'>
          <Button variant='outline' size='sm' className='h-7 px-3 text-[12px]'>
            拒绝
          </Button>
          <Button size='sm' className='h-7 px-3 text-[12px]'>
            批准
          </Button>
        </div>
      </div>
    </div>
  );
}
