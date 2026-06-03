// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Bell } from 'lucide-react';
import * as React from 'react';
import { toast } from 'sonner';

import { Avatar, AvatarFallback } from '@web/components/ui/avatar';
import { Button } from '@web/components/ui/button';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@web/components/ui/popover';
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@web/components/ui/tooltip';
import {
  notificationsApi,
  type Notification,
  type NotificationType,
} from '@web/data/api/notifications';
import { roleUpgradeRequestsApi } from '@web/data/api/role-upgrade-requests';
import { ApiException } from '@web/data/api/types';
import { useTranslation } from '@web/i18n/use-translation';

interface BellMenuProps {
  projectId: string;
}

/**
 * Returns the first two characters of a string, uppercased, for an avatar glyph.
 * @param s - Source string to abbreviate.
 * @returns the two-character uppercase abbreviation.
 */
function initialsFromString(s: string): string {
  return s.slice(0, 2).toUpperCase();
}

/**
 * Formats a creation timestamp as a coarse "Xm/Xh/Xd ago" label.
 * @param createdAt - ISO timestamp of when the notification was created.
 * @returns the relative-age label.
 */
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
 * Bell notification menu — per-user inbox surfacing the four
 * notification types defined by spec § 7:
 *   - access.role_upgrade_request   → owner inbox; owner can approve / reject inline
 *   - access.role_upgrade_approved  → viewer (now editor) inbox
 *   - access.role_upgrade_rejected  → viewer inbox
 *   - access.member_joined          → owner inbox
 *
 * The unread count drives the red-dot badge. Clicking a row opens the
 * row-specific affordance: owner upgrade-request rows show inline
 * approve / reject buttons; the rest are read-on-click and mark-read.
 *
 * Per spec § 7.4, the React Query refetch is triggered both on popover
 * open and on a stateless invalidate message from collab (Phase 7
 * backend pub/sub lands later — for now the popover reopens force a
 * refetch + a 30s background refetch interval keeps the badge fresh).
 *
 * Spec: access-permission design (2026-05-28) § 7.
 * @param root0 - Bell menu props.
 * @param root0.projectId - Id of the current project (reserved for the upcoming collab invalidate wiring).
 * @returns the notifications bell trigger with its unread badge and inbox popover.
 */
export function BellMenu({
  projectId: _projectId,
}: BellMenuProps): React.JSX.Element {
  const t = useTranslation();
  const queryClient = useQueryClient();
  const [open, setOpen] = React.useState(false);

  const inboxQuery = useQuery({
    queryKey: ['notifications', 'unread'],
    queryFn: () => notificationsApi.list(true),
    refetchInterval: 30_000,
    refetchOnWindowFocus: false,
    retry: false,
  });
  const notifications = inboxQuery.data?.data ?? [];
  const count = notifications.length;

  const decideMutation = useMutation({
    mutationFn: (input: {
      notificationId: string;
      decision: 'approved' | 'rejected';
    }) =>
      roleUpgradeRequestsApi.decide(input.notificationId, {
        decision: input.decision,
      }),
    onSuccess: async (_data, vars) => {
      await queryClient.invalidateQueries({
        queryKey: ['notifications', 'unread'],
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

  const markReadMutation = useMutation({
    mutationFn: (id: string) => notificationsApi.markRead(id),
    onSuccess: async () => {
      await queryClient.invalidateQueries({
        queryKey: ['notifications', 'unread'],
      });
    },
  });

  return (
    <Popover open={open} onOpenChange={setOpen}>
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
                <span
                  className='absolute right-1 top-1 h-2 w-2 rounded-full bg-destructive'
                  data-testid='bell-unread-dot'
                />
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
        {inboxQuery.isLoading ? (
          <div className='px-3 py-2 text-[13px] text-muted-foreground'>
            {t('notifications.loading')}
          </div>
        ) : count === 0 ? (
          <div className='px-3 py-2 text-[13px] text-muted-foreground'>
            {t('notifications.empty')}
          </div>
        ) : (
          <ul className='flex flex-col gap-1'>
            {notifications.map((n) => (
              <li key={n.id} data-testid={`bell-notification-${n.id}`}>
                <NotificationItem
                  notification={n}
                  decidePending={
                    decideMutation.isPending &&
                    decideMutation.variables?.notificationId === n.id
                  }
                  onApprove={() =>
                    decideMutation.mutate({
                      notificationId: n.id,
                      decision: 'approved',
                    })
                  }
                  onReject={() =>
                    decideMutation.mutate({
                      notificationId: n.id,
                      decision: 'rejected',
                    })
                  }
                  onMarkRead={() => markReadMutation.mutate(n.id)}
                />
              </li>
            ))}
          </ul>
        )}
      </PopoverContent>
    </Popover>
  );
}

interface NotificationItemProps {
  notification: Notification;
  decidePending: boolean;
  onApprove: () => void;
  onReject: () => void;
  onMarkRead: () => void;
}

/**
 * One inbox row — avatar glyph, headline/subtitle, age, and either inline
 * approve/reject (for upgrade requests) or a mark-read action.
 * @param root0 - Notification item props.
 * @param root0.notification - Notification rendered by this row.
 * @param root0.decidePending - Whether an approve/reject decision for this row is in flight (disables buttons).
 * @param root0.onApprove - Called when the owner approves a role-upgrade request.
 * @param root0.onReject - Called when the owner rejects a role-upgrade request.
 * @param root0.onMarkRead - Called when a non-request notification is marked read.
 * @returns the notification row with its type-specific actions.
 */
function NotificationItem({
  notification,
  decidePending,
  onApprove,
  onReject,
  onMarkRead,
}: NotificationItemProps): React.JSX.Element {
  const t = useTranslation();
  const headline = headlineFor(notification, t);
  const subtitle = subtitleFor(notification);

  return (
    <div className='flex flex-col gap-2 rounded-chrome px-2 py-2 hover:bg-accent'>
      <div className='flex items-start gap-2'>
        <Avatar className='h-9 w-9 shrink-0'>
          <AvatarFallback className='text-[12px] font-semibold'>
            {iconForType(notification.type)}
          </AvatarFallback>
        </Avatar>
        <div className='flex min-w-0 flex-1 flex-col gap-0.5'>
          <span
            className='truncate text-[13px] font-medium text-foreground'
            data-testid={`bell-notification-headline-${notification.id}`}
          >
            {headline}
          </span>
          {subtitle ? (
            <span className='truncate text-[12px] text-muted-foreground'>
              {subtitle}
            </span>
          ) : null}
        </div>
      </div>
      <div className='flex items-center justify-between gap-2 pl-11'>
        <span className='text-[11px] text-muted-foreground'>
          {timeAgoLabel(notification.createdAt)}
        </span>
        {notification.type === 'access.role_upgrade_request' ? (
          <div className='flex items-center gap-2'>
            <Button
              variant='outline'
              size='sm'
              className='h-7 px-3 text-[12px]'
              disabled={decidePending}
              onClick={onReject}
              data-testid={`bell-reject-${notification.id}`}
            >
              {t('notifications.reject')}
            </Button>
            <Button
              size='sm'
              className='h-7 px-3 text-[12px]'
              disabled={decidePending}
              onClick={onApprove}
              data-testid={`bell-approve-${notification.id}`}
            >
              {t('notifications.approve')}
            </Button>
          </div>
        ) : (
          <Button
            variant='ghost'
            size='sm'
            className='h-7 px-2 text-[12px]'
            onClick={onMarkRead}
            data-testid={`bell-mark-read-${notification.id}`}
          >
            {t('notifications.markRead')}
          </Button>
        )}
      </div>
    </div>
  );
}

/**
 * Maps a notification type to the short glyph shown in its avatar fallback.
 * @param type - Notification type to represent.
 * @returns the glyph for the type, or `?` for an unknown type.
 */
function iconForType(type: NotificationType): string {
  switch (type) {
    case 'access.role_upgrade_request':
      return initialsFromString('UP');
    case 'access.role_upgrade_approved':
      return '✓';
    case 'access.role_upgrade_rejected':
      return '✕';
    case 'access.member_joined':
      return initialsFromString('NJ');
    default:
      return '?';
  }
}

/**
 * Builds the localized headline for a notification from its type and payload.
 * @param n - Notification to describe.
 * @param t - Translation function used to render the localized headline.
 * @returns the localized headline, or the raw type for an unknown notification.
 */
function headlineFor(
  n: Notification,
  t: ReturnType<typeof useTranslation>,
): string {
  switch (n.type) {
    case 'access.role_upgrade_request':
      return t('notifications.headline.roleUpgradeRequest', {
        project: String((n.payload as Record<string, unknown>).projectName ?? ''),
      });
    case 'access.role_upgrade_approved':
      return t('notifications.headline.roleUpgradeApproved', {
        project: String((n.payload as Record<string, unknown>).projectName ?? ''),
      });
    case 'access.role_upgrade_rejected':
      return t('notifications.headline.roleUpgradeRejected', {
        project: String((n.payload as Record<string, unknown>).projectName ?? ''),
      });
    case 'access.member_joined':
      return t('notifications.headline.memberJoined', {
        project: String((n.payload as Record<string, unknown>).projectName ?? ''),
      });
    default:
      return n.type;
  }
}

/**
 * Extracts the optional subtitle (request message or rejection reason) for a notification.
 * @param n - Notification whose payload is inspected for subtitle text.
 * @returns the subtitle text, or `null` when none applies.
 */
function subtitleFor(n: Notification): string | null {
  const p = n.payload as Record<string, unknown>;
  if (n.type === 'access.role_upgrade_request') {
    const msg = typeof p.message === 'string' ? p.message : null;
    return msg && msg.length > 0 ? msg : null;
  }
  if (n.type === 'access.role_upgrade_rejected') {
    const reason = typeof p.reason === 'string' ? p.reason : null;
    return reason && reason.length > 0 ? reason : null;
  }
  return null;
}
