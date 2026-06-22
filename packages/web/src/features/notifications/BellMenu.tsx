// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Bell } from 'lucide-react';
import * as React from 'react';
import { useNavigate } from 'react-router-dom';
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
import { notificationHeadline } from '@web/features/notifications/notification-headline';
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
 * The inline confirm/cancel handshake an actionable notification type drives.
 * Studio transfer + studio invite confirm INLINE in the bell; the project invite
 * does NOT (it links out to the `/project-invite` landing page), so it is not a
 * kind here.
 */
type ActionKind = 'transfer' | 'studioInvite';

/**
 * Maps an inline-actionable notification type to its handshake kind, so the
 * confirm/cancel mutation can pick the matching success toast (the single
 * respondAction endpoint serves both inline kinds).
 * @param type - The inline-actionable notification type.
 * @returns the handshake kind for that type (`transfer` as the safe default).
 */
function actionKindFor(type: NotificationType): ActionKind {
  if (type === 'studio.invite_request') return 'studioInvite';
  return 'transfer';
}

/**
 * Picks the success-toast i18n key for a confirmed/cancelled inline handshake. A
 * studio invitee joins a studio and a transfer recipient becomes the studio
 * admin — each gets its own copy. (The project invite confirms on the landing
 * page, not here, so it has no toast in this menu.)
 * @param kind - The inline handshake kind being acted on.
 * @param action - `confirm` to accept, `cancel` to decline.
 * @returns the i18n key for the matching success toast.
 */
function toastKeyFor(kind: ActionKind, action: NotificationAction): string {
  if (kind === 'studioInvite') {
    return action === 'confirm'
      ? 'notifications.inviteConfirmedToast'
      : 'notifications.inviteDeclinedToast';
  }
  return action === 'confirm'
    ? 'notifications.transferConfirmedToast'
    : 'notifications.transferCancelledToast';
}

/**
 * Reads the one-time landing-page token from a `project.invite_request` payload.
 * The project bell row links out to `/project-invite?token=` rather than
 * confirming inline; the token rides in the notification payload.
 * @param payload - The notification's opaque payload.
 * @returns the token string, or null if absent / malformed.
 */
function projectInviteTokenOf(payload: Record<string, unknown>): string | null {
  return typeof payload.token === 'string' ? payload.token : null;
}

/**
 * Bell notification menu — the per-user inbox shared by the project chrome and
 * the studio chrome. Surfaces every notification type:
 *   - access.role_upgrade_request   → owner inbox; inline approve / reject
 *   - access.role_upgrade_approved  → viewer (now editor) inbox; read-on-click
 *   - access.role_upgrade_rejected  → viewer inbox; read-on-click
 *   - studio.transfer_request       → proposed admin inbox; inline confirm /
 *                                     cancel + a TTL countdown (slice 3)
 *   - studio.transfer_approved      → old-admin inbox; read-on-click (slice 3)
 *   - studio.invite_request         → invitee inbox; inline confirm / cancel +
 *                                     a TTL countdown (slice 3)
 *   - studio.invite_accepted        → inviting-admin inbox; read-on-click
 *   - project.invite_request        → invitee inbox; links OUT to the
 *                                     `/project-invite?token=` landing page +
 *                                     a TTL countdown (#1337)
 *   - project.invite_accepted       → inviting-owner inbox; read-on-click
 *
 * The unread count drives the red-dot badge. Clicking a row opens the
 * row-specific affordance: upgrade-request rows show inline approve / reject,
 * studio transfer / studio invite rows show inline confirm / cancel, the
 * project invite row navigates to the landing page (the divergence from studio:
 * project confirm/decline happen there, not inline), the rest mark-read.
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
  const navigate = useNavigate();
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

  // Confirm / cancel an INLINE-actionable notification (studio transfer request
  // or studio invite request). The studios list is also invalidated so the
  // rail's "My / Joined studios" split reflects the new admin role immediately
  // after a transfer confirm. (Project invites confirm on the landing page, not
  // here, so they don't go through this mutation.)
  const actionMutation = useMutation({
    mutationFn: (input: {
      id: string;
      action: NotificationAction;
      kind: ActionKind;
    }) => notificationsApi.respondAction(input.id, input.action),
    onSuccess: async (_data, vars) => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['notifications', 'unread'] }),
        queryClient.invalidateQueries({ queryKey: ['studios', 'user'] }),
      ]);
      // The same respondAction endpoint serves both inline handshakes; the toast
      // must match the notification kind (a studio invitee joins a studio, a
      // transfer recipient becomes admin).
      const toastKey = toastKeyFor(vars.kind, vars.action);
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
              aria-label={t('chrome.tooltip.notifications')}
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
                      kind: actionKindFor(n.type),
                    })
                  }
                  onCancel={() =>
                    actionMutation.mutate({
                      id: n.id,
                      action: 'cancel',
                      kind: actionKindFor(n.type),
                    })
                  }
                  onOpenInvite={() => {
                    // Project invites confirm on the landing page, not inline:
                    // navigate to `/project-invite?token=` (the same link the
                    // copy URL + email use) and close the popover.
                    const token = projectInviteTokenOf(n.payload);
                    if (token === null) return;
                    setOpen(false);
                    navigate(`/project-invite?token=${token}`);
                  }}
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
  onOpenInvite: () => void;
  onMarkRead: () => void;
}

/**
 * One inbox row — avatar glyph, headline/subtitle, age, and a type-specific
 * affordance: inline approve/reject for role-upgrade requests, inline
 * confirm/cancel + a TTL countdown for studio transfer / studio invite requests,
 * an open-invite link (to the `/project-invite` landing page) for project
 * invites, or a mark-read action for the informational rows.
 * @param root0 - Notification item props.
 * @param root0.notification - Notification rendered by this row.
 * @param root0.decidePending - Whether a decision/action for this row is in flight (disables buttons).
 * @param root0.onApprove - Called when the owner approves a role-upgrade request.
 * @param root0.onReject - Called when the owner rejects a role-upgrade request.
 * @param root0.onConfirm - Called when the recipient confirms (accepts) a studio transfer / invite request.
 * @param root0.onCancel - Called when the recipient cancels (declines) a studio transfer / invite request.
 * @param root0.onOpenInvite - Called when the invitee opens a project invite (navigates to the landing page).
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
  onOpenInvite,
  onMarkRead,
}: NotificationItemProps): React.JSX.Element {
  const t = useTranslation();
  const headline = notificationHeadline(notification, t);
  const subtitle = subtitleFor(notification, t);
  const isUpgradeRequest =
    notification.type === 'access.role_upgrade_request';
  const isTransferRequest =
    notification.type === 'studio.transfer_request';
  // Studio invites confirm INLINE here; the project invite does NOT — it links
  // out to the `/project-invite` landing page (the divergence from studio).
  const isStudioInviteRequest =
    notification.type === 'studio.invite_request';
  const isProjectInviteRequest =
    notification.type === 'project.invite_request';
  // The two inline handshakes (studio transfer + studio invite) render the same
  // confirm/cancel controls; the backend dispatches on the notification type.
  // The TTL countdown also shows for the project invite (still time-boxed).
  const isInviteRequest = isStudioInviteRequest || isProjectInviteRequest;
  const isActionable = isTransferRequest || isStudioInviteRequest;

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
            className='text-sm font-medium text-foreground'
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
          {(isActionable || isProjectInviteRequest) && notification.expiresAt
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
        ) : isActionable ? (
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
        ) : isProjectInviteRequest ? (
          <Button
            size='sm'
            className='h-7 px-3 text-xs'
            onClick={onOpenInvite}
            data-testid={`bell-open-invite-${notification.id}`}
          >
            {t('notifications.viewProjectInvite')}
          </Button>
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
    case 'studio.transfer_request':
      return initialsFromString('TR');
    case 'studio.transfer_approved':
      return '✓';
    case 'studio.invite_request':
      return initialsFromString('IN');
    case 'studio.invite_accepted':
      return '✓';
    case 'project.invite_request':
      return initialsFromString('PI');
    case 'project.invite_accepted':
      return '✓';
    default:
      return '?';
  }
}

/** Maps a studio role payload value to its localized member-role label. */
const STUDIO_ROLE_KEY: Record<string, string> = {
  maintainer: 'notifications.subtitle.invitedAsMaintainer',
  guest: 'notifications.subtitle.invitedAsGuest',
};

/** Maps a project role payload value to its localized member-role label. */
const PROJECT_ROLE_KEY: Record<string, string> = {
  editor: 'notifications.subtitle.invitedAsEditor',
  viewer: 'notifications.subtitle.invitedAsViewer',
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
  if (n.type === 'studio.invite_request') {
    const roleKey = typeof p.role === 'string' ? STUDIO_ROLE_KEY[p.role] : null;
    return roleKey ? t(roleKey) : null;
  }
  if (n.type === 'project.invite_request') {
    const roleKey = typeof p.role === 'string' ? PROJECT_ROLE_KEY[p.role] : null;
    return roleKey ? t(roleKey) : null;
  }
  if (n.type === 'studio.transfer_request') {
    return t('notifications.subtitle.transferHint');
  }
  return null;
}
