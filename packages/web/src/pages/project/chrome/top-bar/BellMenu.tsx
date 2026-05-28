import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Bell } from 'lucide-react';
import * as React from 'react';
import { toast } from 'sonner';

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
import {
  accessRequestsApi,
  type AccessRequestWithRequester,
} from '@/data/api/access-requests';
import { ApiException } from '@/data/api/types';
import { useTranslation } from '@/i18n/use-translation';

interface BellMenuProps {
  projectId: string;
}

function initialsFromName(name: string): string {
  // Take the first 2 characters of the display name (or email
  // local-part if no username). Uppercased for the avatar fallback.
  return name.slice(0, 2).toUpperCase();
}

function displayName(requester: {
  username: string | null;
  email: string;
}): string {
  // Prefer username; fall back to the local-part of the email if
  // the user never set a username (registration allows it null).
  if (requester.username) return requester.username;
  return requester.email.split('@')[0] ?? requester.email;
}

function timeAgoLabel(createdAt: string): string {
  const diffMs = Date.now() - new Date(createdAt).getTime();
  const minutes = Math.max(1, Math.round(diffMs / 60_000));
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  return `${days}d ago`;
}

/**
 * Notifications bell — popover lists pending access requests for the
 * current project. Owner-only data on the backend (403 for non-owners),
 * so the list will be empty for view/edit members; the bell still
 * renders but with no badge + "no notifications" copy.
 *
 * Requester user info is shown as the first 8 chars of their UUID
 * pending a backend `list-pending-by-project` JOIN with users
 * (follow-up — see #604/#605 plan). The role chip and message field
 * are full-data today.
 *
 * Approve / reject mutates via `accessRequestsApi.decide`; React
 * Query invalidates the pending list on success so the row drops out
 * + the badge count decrements.
 */
export function BellMenu({ projectId }: BellMenuProps) {
  const t = useTranslation();
  const queryClient = useQueryClient();

  const pendingQuery = useQuery({
    queryKey: ['access-requests', 'pending', projectId],
    queryFn: () => accessRequestsApi.listPendingByProject(projectId),
    // Non-owners get 403 from the backend — treat as empty list and
    // don't retry. Owners get the real list.
    retry: false,
    refetchOnWindowFocus: false,
  });

  const requests = pendingQuery.data?.data ?? [];
  const count = requests.length;

  const decideMutation = useMutation({
    mutationFn: (input: {
      requestId: string;
      decision: 'approved' | 'rejected';
    }) =>
      accessRequestsApi.decide(projectId, input.requestId, {
        decision: input.decision,
      }),
    onSuccess: async (_data, vars) => {
      await queryClient.invalidateQueries({
        queryKey: ['access-requests', 'pending', projectId],
      });
      toast.success(
        vars.decision === 'approved'
          ? t('notifications.approvedToast')
          : t('notifications.rejectedToast'),
      );
    },
    onError: (err) => {
      const msg =
        err instanceof ApiException ? err.message : t('notifications.decideFailed');
      toast.error(msg);
    },
  });

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
        {pendingQuery.isLoading ? (
          <div className='px-3 py-2 text-[13px] text-muted-foreground'>
            {t('notifications.loading')}
          </div>
        ) : count === 0 ? (
          <div className='px-3 py-2 text-[13px] text-muted-foreground'>
            {t('notifications.empty')}
          </div>
        ) : (
          <ul className='flex flex-col gap-1'>
            {requests.map((req) => (
              <li key={req.id} data-testid={`bell-request-${req.id}`}>
                <RequestItem
                  request={req}
                  pending={
                    decideMutation.isPending &&
                    decideMutation.variables?.requestId === req.id
                  }
                  onDecide={(decision) =>
                    decideMutation.mutate({ requestId: req.id, decision })
                  }
                />
              </li>
            ))}
          </ul>
        )}
      </PopoverContent>
    </Popover>
  );
}

interface RequestItemProps {
  request: AccessRequestWithRequester;
  pending: boolean;
  onDecide: (decision: 'approved' | 'rejected') => void;
}

function RequestItem({ request, pending, onDecide }: RequestItemProps) {
  const t = useTranslation();
  const name = displayName(request.requester);
  return (
    <div className='flex flex-col gap-2 rounded-chrome px-2 py-2 hover:bg-accent'>
      <div className='flex items-start gap-2'>
        <Avatar className='h-9 w-9 shrink-0'>
          <AvatarFallback className='text-[12px] font-semibold'>
            {initialsFromName(name)}
          </AvatarFallback>
        </Avatar>
        <div className='flex min-w-0 flex-1 flex-col gap-0.5'>
          <span className='truncate text-[13px] font-medium text-foreground'>
            {name}
          </span>
          <span className='truncate text-[12px] text-muted-foreground'>
            {request.message ?? request.requester.email}
          </span>
        </div>
        <span className='shrink-0 self-start rounded-[4px] bg-muted px-1 py-0.5 text-[11px] font-medium text-muted-foreground'>
          {request.requestedRole === 'edit'
            ? t('notifications.roleHint.editor')
            : t('notifications.roleHint.viewer')}
        </span>
      </div>
      <div className='flex items-center justify-between gap-2 pl-11'>
        <span className='text-[11px] text-muted-foreground'>
          {timeAgoLabel(request.createdAt)}
        </span>
        <div className='flex items-center gap-2'>
          <Button
            variant='outline'
            size='sm'
            className='h-7 px-3 text-[12px]'
            disabled={pending}
            onClick={() => onDecide('rejected')}
            data-testid={`bell-reject-${request.id}`}
          >
            {t('notifications.reject')}
          </Button>
          <Button
            size='sm'
            className='h-7 px-3 text-[12px]'
            disabled={pending}
            onClick={() => onDecide('approved')}
            data-testid={`bell-approve-${request.id}`}
          >
            {t('notifications.approve')}
          </Button>
        </div>
      </div>
    </div>
  );
}
