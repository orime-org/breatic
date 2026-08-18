// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Bell } from 'lucide-react';
import * as React from 'react';
import { useNavigate } from 'react-router-dom';
import { expiresInLabel } from '@web/lib/expires-in';

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
import { suppressTooltipFocusOpen } from '@web/lib/overlay-focus';
import {
  notificationsApi,
  type Notification,
  type NotificationType,
} from '@web/data/api/notifications';
import { notificationHeadline } from '@web/features/notifications/notification-headline';
import { EMPTY_RESOLVED } from '@web/data/api/notifications';
import type { NotificationResolved } from '@web/data/api/notifications';
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
 * Reads the token naming the request a bell row stands for.
 *
 * A row never holds the request — it points at one, and this is the pointer.
 * Absent means there is nothing to point at, which is why the row without one
 * is drawn without an answer affordance rather than with a dead button.
 * @param payload - The notification's opaque payload.
 * @returns the token string, or null if absent / malformed.
 */
function shareTokenOf(payload: Record<string, unknown>): string | null {
  return typeof payload.shareToken === 'string' ? payload.shareToken : null;
}

/**
 * Bell notification menu — the per-user inbox shared by the project chrome and
 * the studio chrome.
 *
 * Rows come in two kinds. Five of them stand for a request somebody is waiting
 * on an answer to — the two invites, the two transfers, the role upgrade — and
 * each carries a token to the page they are all answered on. The rest are news
 * (`*_accepted`, `*_approved`, `*_rejected`) and mark themselves read.
 *
 * Deciding used to happen HERE, differently per flow: the studio invite and
 * both transfers confirmed inline through a bell-specific endpoint, while the
 * project invite alone linked out. That divergence is what this component no
 * longer has — every waiting row points at the same page, and a row is only
 * drawn as answerable when it has a token to point WITH.
 *
 * The React Query refetch is triggered both on popover open and a 30s
 * background interval (the collab stateless invalidate broadcast lands in a
 * later phase). The inbox query key (`['notifications', 'unread']`) is
 * page-agnostic, so this single component serves every chrome.
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
  const notifications = inboxQuery.data?.items ?? [];
  // Display names and links come from here, not from the notification payloads
  // — the payloads hold ids so a rename can never strand an old entry.
  const resolved = inboxQuery.data?.resolved ?? EMPTY_RESOLVED;
  const count = notifications.length;

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
              aria-label={t('chrome.tooltip.notifications')}
              className='relative'
              data-testid='bell-trigger'
              onFocusCapture={suppressTooltipFocusOpen}
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
                  resolved={resolved}
                  onOpenDecision={(token) => {
                    setOpen(false);
                    navigate(`/decision?token=${token}`);
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
  /** Current identities for the ids this notification carries. */
  resolved: NotificationResolved;
  onOpenDecision: (token: string) => void;
  onMarkRead: () => void;
}

/**
 * One inbox row — avatar glyph, headline/subtitle, age, and one of two
 * affordances: a row somebody is waiting on gets a countdown and a button to
 * the landing page it is answered on; everything else gets mark-read.
 * @param root0 - Notification item props.
 * @param root0.notification - Notification rendered by this row.
 * @param root0.resolved - Current identities for the ids it carries.
 * @param root0.onOpenDecision - Opens the shared landing page for this request.
 * @param root0.onMarkRead - Called when an informational notification is marked read.
 * @returns the notification row with its type-specific actions.
 */
function NotificationItem({
  notification,
  resolved,
  onOpenDecision,
  onMarkRead,
}: NotificationItemProps): React.JSX.Element {
  const t = useTranslation();
  const headline = notificationHeadline(notification, resolved, t);
  const subtitle = subtitleFor(notification, t);
  const isUpgradeRequest =
    notification.type === 'access.role_upgrade_request';
  const isTransferRequest =
    notification.type === 'studio.transfer_request' ||
    notification.type === 'project.transfer_request';
  const isStudioInviteRequest =
    notification.type === 'studio.invite_request';
  const isProjectInviteRequest =
    notification.type === 'project.invite_request';
  const isInviteRequest = isStudioInviteRequest || isProjectInviteRequest;
  // Everything with a deadline shows its countdown. The role upgrade was left
  // out while it had no deadline to show; it has one now, and it was the only
  // time-boxed row in the list hiding that fact from the person deciding it.
  // Two questions, and the second one is not a formality: a row of a waiting
  // KIND whose payload has no token has nowhere to send anybody, and drawing
  // the button anyway is how you get an affordance that silently does nothing.
  const token = shareTokenOf(notification.payload);
  const isDecidable =
    (isUpgradeRequest || isInviteRequest || isTransferRequest) &&
    token !== null;

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
          {isDecidable && notification.expiresAt
            ? expiresInLabel(notification.expiresAt, t)
            : timeAgoLabel(notification.createdAt)}
        </span>
        {isDecidable ? (
          // Every waiting request is answered on the shared landing page now.
          // The bell says one is waiting; it does not decide it.
          <Button
            size='sm'
            className='h-7 px-3 text-xs'
            onClick={() => onOpenDecision(token)}
            data-testid={`bell-open-decision-${notification.id}`}
          >
            {t('notifications.openDecision')}
          </Button>
        ) : (
          <Button
            variant='outline'
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
 *
 * Every type the inbox can hold names itself here. The two-letter forms follow
 * what the pair they belong to already established — a studio invite is IN and
 * a project one PI, so a studio transfer is TR and a project one PT. A settled
 * outcome is a mark rather than initials: a tick when the answer was yes, a
 * cross when it was no.
 * @param type - Notification type to represent.
 * @returns the glyph for the type, or `?` for a type this build does not know
 *   about, which is a wire carrying something newer than this bundle rather
 *   than one of ours.
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
    case 'project.transfer_request':
      return initialsFromString('PT');
    case 'project.transfer_approved':
      return '✓';
    case 'studio.invite_request':
      return initialsFromString('IN');
    case 'studio.invite_accepted':
      return '✓';
    case 'project.invite_request':
      return initialsFromString('PI');
    case 'project.invite_accepted':
      return '✓';
    case 'membership.ended':
      return initialsFromString('ME');
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
 * Extracts the optional subtitle for a notification.
 *
 * The four rows that hand you something answer one question on their second
 * line — what you hold if you accept: an invite names the role offered, a
 * transfer the role you take over.
 *
 * The fifth waiting row does not, and cannot. A role upgrade asks the reader
 * to grant something rather than take it, so what is useful there is the
 * message the requester typed, and it has none when they typed nothing —
 * `message` is optional on that route. So a waiting row with no second line is
 * a real state, not an oversight. Rows that decide nothing have no second line
 * either, because there is nothing to accept.
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
  if (n.type === 'studio.invite_request') {
    const roleKey = typeof p.role === 'string' ? STUDIO_ROLE_KEY[p.role] : null;
    return roleKey ? t(roleKey) : null;
  }
  if (n.type === 'project.invite_request') {
    const roleKey = typeof p.role === 'string' ? PROJECT_ROLE_KEY[p.role] : null;
    return roleKey ? t(roleKey) : null;
  }
  if (n.type === 'studio.transfer_request') {
    return t('notifications.subtitle.studioTransferHint');
  }
  if (n.type === 'project.transfer_request') {
    return t('notifications.subtitle.projectTransferHint');
  }
  return null;
}
