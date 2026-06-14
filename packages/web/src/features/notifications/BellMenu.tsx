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
  type NotificationAction,
} from '@web/data/api/notifications';
import { roleUpgradeRequestsApi } from '@web/data/api/role-upgrade-requests';
import { ApiException } from '@web/data/api/types';
import { useTranslation } from '@web/i18n/use-translation';
import { useCurrentUserStore } from '@web/stores';

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
 * Formats the remaining time until an actionable notification's `expiresAt` as
 * a coarse "expires in Nd/Nh/Nm" label (or "expired" once past).
 * @param expiresAt - ISO timestamp of when the notification self-voids.
 * @param t - Translation function for the localized label.
 * @returns the localized countdown label.
 */
function expiresInLabel(
  expiresAt: string,
  t: ReturnType<typeof useTranslation>,
): string {
  const diffMs = new Date(expiresAt).getTime() - Date.now();
  if (diffMs <= 0) return t('notifications.expiresLabel.expired');
  const minutes = Math.round(diffMs / 60_000);
  if (minutes < 60) {
    return t('notifications.expiresLabel.minutes', { count: minutes });
  }
  const hours = Math.round(minutes / 60);
  if (hours < 24) {
    return t('notifications.expiresLabel.hours', { count: hours });
  }
  const days = Math.round(hours / 24);
  return t('notifications.expiresLabel.days', { count: days });
}

/**
 * Bell notification menu — the per-user inbox shared by the project chrome and
 * the studio chrome. Surfaces every notification type:
 *   - access.role_upgrade_request   → owner inbox; inline approve / reject
 *   - access.role_upgrade_approved  → viewer (now editor) inbox; read-on-click
 *   - access.role_upgrade_rejected  → viewer inbox; read-on-click
 *   - access.member_joined          → owner inbox; read-on-click
 *   - studio.member_invited         → invitee inbox; read-on-click (slice 3)
 *   - studio.transfer_request       → proposed admin inbox; inline confirm /
 *                                     cancel + a TTL countdown (slice 3)
 *   - studio.transfer_approved      → old-admin inbox; read-on-click (slice 3)
 *
 * The unread count drives the red-dot badge. Clicking a row opens the
 * row-specific affordance: upgrade-request rows show inline approve / reject,
 * transfer-request rows show inline confirm / cancel, the rest mark-read.
 *
 * The React Query refetch is triggered both on popover open and a 30s
 * background interval (the collab stateless invalidate broadcast lands in a
 * later phase). The inbox query key (`['notifications', 'unread']`) is
 * page-agnostic, so this single component serves every chrome.
 *
 * Spec: access-permission design (2026-05-28) § 7; studio member management
 * (slice 3).
 * @returns the notifications bell trigger with its unread badge and inbox popover.
 */
export function BellMenu(): React.JSX.Element {
  const t = useTranslation();
  const queryClient = useQueryClient();
  const [open, setOpen] = React.useState(false);
  // Gate the inbox query on a known user. BellMenu mounts in the chrome before
  // the `/auth/me` boot ping resolves; firing the query with no session caches
  // an empty list that never refetches (30s interval, no refetch-on-focus), so
  // notifications wouldn't appear until a reload. Keying on `userId` also keeps
  // one user's inbox from leaking into the next after a logout/login.
  const userId = useCurrentUserStore((s) => s.user?.id ?? null);

  const inboxQuery = useQuery({
    queryKey: ['notifications', 'unread', userId],
    queryFn: () => notificationsApi.list(true),
    enabled: userId !== null,
    refetchInterval: 30_000,
    refetchOnWindowFocus: false,
    retry: false,
  });
  const notifications = inboxQuery.data ?? [];
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

  // Confirm / cancel an actionable notification (studio transfer request).
  // The studios list is also invalidated so the rail's "My / Joined studios"
  // split reflects the new admin role immediately after a confirm.
  const actionMutation = useMutation({
    mutationFn: (input: {
      id: string;
      action: NotificationAction;
      isInvite: boolean;
    }) => notificationsApi.respondAction(input.id, input.action),
    onSuccess: async (_data, vars) => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['notifications', 'unread'] }),
        queryClient.invalidateQueries({ queryKey: ['studios', 'user'] }),
      ]);
      // The same respondAction endpoint serves both handshakes; the toast must
      // match the notification kind (an invitee joins as a member, NOT as admin).
      const toastKey = vars.isInvite
        ? vars.action === 'confirm'
          ? 'notifications.inviteConfirmedToast'
          : 'notifications.inviteDeclinedToast'
        : vars.action === 'confirm'
          ? 'notifications.transferConfirmedToast'
          : 'notifications.transferCancelledToast';
      toast.success(t(toastKey));
    },
    onError: (err) => {
      const msg =
        err instanceof ApiException
          ? err.message
          : t('notifications.actionFailed');
      toast.error(msg);
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
                  className='absolute right-1 top-1 h-2 w-2 rounded-full bg-status-error'
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
          <span className='text-2xs font-medium uppercase tracking-wide text-muted-foreground'>
            {t('notifications.title')}
          </span>
          <span className='text-2xs tabular-nums text-muted-foreground'>
            {count}
          </span>
        </div>
        {inboxQuery.isLoading ? (
          <div className='px-3 py-2 text-sm text-muted-foreground'>
            {t('notifications.loading')}
          </div>
        ) : count === 0 ? (
          <div className='px-3 py-2 text-sm text-muted-foreground'>
            {t('notifications.empty')}
          </div>
        ) : (
          <ul className='flex flex-col gap-1'>
            {notifications.map((n) => (
              <li key={n.id} data-testid={`bell-notification-${n.id}`}>
                <NotificationItem
                  notification={n}
                  decidePending={
                    (decideMutation.isPending &&
                      decideMutation.variables?.notificationId === n.id) ||
                    (actionMutation.isPending &&
                      actionMutation.variables?.id === n.id)
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
                  onConfirm={() =>
                    actionMutation.mutate({
                      id: n.id,
                      action: 'confirm',
                      isInvite: n.type === 'studio.invite_request',
                    })
                  }
                  onCancel={() =>
                    actionMutation.mutate({
                      id: n.id,
                      action: 'cancel',
                      isInvite: n.type === 'studio.invite_request',
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
  onConfirm: () => void;
  onCancel: () => void;
  onMarkRead: () => void;
}

/**
 * One inbox row — avatar glyph, headline/subtitle, age, and a type-specific
 * affordance: inline approve/reject for role-upgrade requests, inline
 * confirm/cancel + a TTL countdown for studio transfer requests, or a mark-read
 * action for the informational rows.
 * @param root0 - Notification item props.
 * @param root0.notification - Notification rendered by this row.
 * @param root0.decidePending - Whether a decision/action for this row is in flight (disables buttons).
 * @param root0.onApprove - Called when the owner approves a role-upgrade request.
 * @param root0.onReject - Called when the owner rejects a role-upgrade request.
 * @param root0.onConfirm - Called when the recipient confirms (accepts) a studio transfer request.
 * @param root0.onCancel - Called when the recipient cancels (declines) a studio transfer request.
 * @param root0.onMarkRead - Called when an informational notification is marked read.
 * @returns the notification row with its type-specific actions.
 */
function NotificationItem({
  notification,
  decidePending,
  onApprove,
  onReject,
  onConfirm,
  onCancel,
  onMarkRead,
}: NotificationItemProps): React.JSX.Element {
  const t = useTranslation();
  const headline = headlineFor(notification, t);
  const subtitle = subtitleFor(notification, t);
  const isUpgradeRequest =
    notification.type === 'access.role_upgrade_request';
  const isTransferRequest =
    notification.type === 'studio.transfer_request';
  const isInviteRequest = notification.type === 'studio.invite_request';
  // Both actionable studio handshakes render the same confirm/cancel controls
  // (the backend dispatches on the notification type).
  const isActionableStudio = isTransferRequest || isInviteRequest;

  return (
    <div className='flex flex-col gap-2 rounded-chrome px-2 py-2 hover:bg-accent'>
      <div className='flex items-start gap-2'>
        <Avatar className='h-9 w-9 shrink-0'>
          <AvatarFallback className='text-xs font-semibold'>
            {iconForType(notification.type)}
          </AvatarFallback>
        </Avatar>
        <div className='flex min-w-0 flex-1 flex-col gap-0.5'>
          <span
            className='truncate text-sm font-medium text-foreground'
            data-testid={`bell-notification-headline-${notification.id}`}
          >
            {headline}
          </span>
          {subtitle ? (
            <span className='truncate text-xs text-muted-foreground'>
              {subtitle}
            </span>
          ) : null}
        </div>
      </div>
      <div className='flex items-center justify-between gap-2 pl-11'>
        <span className='text-2xs text-muted-foreground'>
          {isActionableStudio && notification.expiresAt
            ? expiresInLabel(notification.expiresAt, t)
            : timeAgoLabel(notification.createdAt)}
        </span>
        {isUpgradeRequest ? (
          <div className='flex items-center gap-2'>
            <Button
              variant='outline'
              size='sm'
              className='h-7 px-3 text-xs'
              disabled={decidePending}
              onClick={onReject}
              data-testid={`bell-reject-${notification.id}`}
            >
              {t('notifications.reject')}
            </Button>
            <Button
              size='sm'
              className='h-7 px-3 text-xs'
              disabled={decidePending}
              onClick={onApprove}
              data-testid={`bell-approve-${notification.id}`}
            >
              {t('notifications.approve')}
            </Button>
          </div>
        ) : isActionableStudio ? (
          <div className='flex items-center gap-2'>
            <Button
              variant='outline'
              size='sm'
              className='h-7 px-3 text-xs'
              disabled={decidePending}
              onClick={onCancel}
              data-testid={`bell-cancel-${notification.id}`}
            >
              {isInviteRequest
                ? t('notifications.inviteDecline')
                : t('notifications.transferDecline')}
            </Button>
            <Button
              size='sm'
              className='h-7 px-3 text-xs'
              disabled={decidePending}
              onClick={onConfirm}
              data-testid={`bell-confirm-${notification.id}`}
            >
              {isInviteRequest
                ? t('notifications.inviteAccept')
                : t('notifications.transferAccept')}
            </Button>
          </div>
        ) : (
          <Button
            variant='ghost'
            size='sm'
            className='h-7 px-2 text-xs'
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
    case 'studio.member_invited':
      return initialsFromString('ST');
    case 'studio.transfer_request':
      return initialsFromString('TR');
    case 'studio.transfer_approved':
      return '✓';
    case 'studio.invite_request':
      return initialsFromString('IN');
    case 'studio.invite_accepted':
      return '✓';
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
    case 'studio.member_invited':
      return t('notifications.headline.studioMemberInvited', {
        studio: String((n.payload as Record<string, unknown>).studioName ?? ''),
      });
    case 'studio.transfer_request':
      return t('notifications.headline.studioTransferRequest', {
        studio: String((n.payload as Record<string, unknown>).studioName ?? ''),
      });
    case 'studio.transfer_approved':
      return t('notifications.headline.studioTransferApproved', {
        studio: String((n.payload as Record<string, unknown>).studioName ?? ''),
      });
    case 'studio.invite_request':
      return t('notifications.headline.studioInviteRequest', {
        studio: String((n.payload as Record<string, unknown>).studioName ?? ''),
      });
    case 'studio.invite_accepted':
      return t('notifications.headline.studioInviteAccepted', {
        invitee: String((n.payload as Record<string, unknown>).inviteeName ?? ''),
        studio: String((n.payload as Record<string, unknown>).studioName ?? ''),
      });
    default:
      return n.type;
  }
}

/** Maps a studio role payload value to its localized member-role label. */
const STUDIO_ROLE_KEY: Record<string, string> = {
  creator: 'notifications.subtitle.invitedAsCreator',
  member: 'notifications.subtitle.invitedAsMember',
};

/**
 * Extracts the optional subtitle for a notification: the request message
 * (upgrade request), the rejection reason (upgrade rejected), the granted role
 * (studio member invited), or the transfer-handshake hint (transfer request).
 * @param n - Notification whose payload is inspected for subtitle text.
 * @param t - Translation function for the localized subtitle.
 * @returns the subtitle text, or `null` when none applies.
 */
function subtitleFor(
  n: Notification,
  t: ReturnType<typeof useTranslation>,
): string | null {
  const p = n.payload as Record<string, unknown>;
  if (n.type === 'access.role_upgrade_request') {
    const msg = typeof p.message === 'string' ? p.message : null;
    return msg && msg.length > 0 ? msg : null;
  }
  if (n.type === 'access.role_upgrade_rejected') {
    const reason = typeof p.reason === 'string' ? p.reason : null;
    return reason && reason.length > 0 ? reason : null;
  }
  if (n.type === 'studio.member_invited') {
    const roleKey = typeof p.role === 'string' ? STUDIO_ROLE_KEY[p.role] : null;
    return roleKey ? t(roleKey) : null;
  }
  if (n.type === 'studio.invite_request') {
    const roleKey = typeof p.role === 'string' ? STUDIO_ROLE_KEY[p.role] : null;
    return roleKey ? t(roleKey) : null;
  }
  if (n.type === 'studio.transfer_request') {
    return t('notifications.subtitle.transferHint');
  }
  return null;
}
