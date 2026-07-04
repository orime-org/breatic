// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import { AlertTriangle, History, RotateCcw } from 'lucide-react';
import { useEffect, useRef, useState, type JSX } from 'react';
import {
  useInfiniteQuery,
  useQueryClient,
} from '@tanstack/react-query';
import type { HocuspocusProvider } from '@hocuspocus/provider';

import {
  ActivityNewSignalSchema,
  type ProjectActivityEntry,
  type ProjectActivityType,
  type ProjectRole,
} from '@breatic/shared';
import { activitiesApi } from '@web/data/api/activities';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetTitle,
  SheetTrigger,
} from '@web/components/ui/sheet';
import { Button } from '@web/components/ui/button';
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@web/components/ui/tooltip';
import { cn } from '@web/lib/utils';
import { useExclusiveOverlay } from '@web/lib/use-exclusive-overlay';
import { suppressTooltipFocusOpen } from '@web/lib/overlay-focus';
import { useTranslation } from '@web/i18n/use-translation';

/**
 * Project activity feed surfaced by the History clock icon on the
 * right of the tab bar (ADR 2026-07-04 project-activity-feed).
 *
 * Backed by the PG `project_activities` table via
 * `GET /projects/:id/activities` (keyset pages, actor names resolved
 * server-side) — replaces the retired meta-doc `projectMessages`
 * Y.Array reader. Live updates arrive as the `activity:new` stateless
 * signal on the project meta doc socket; the panel reacts by
 * invalidating the query (Figma-style signal + refetch).
 */
export interface ProjectMessagesButtonProps {
  projectId: string;
  /**
   * Live meta-doc provider carrying the `activity:new` stateless
   * signal. Null while the socket mounts — the panel still works via
   * REST (open = fetch), it just misses live pushes until connected.
   */
  provider?: Pick<HocuspocusProvider, 'on' | 'off'> | null;
  /** Caller's role on the project. Drives owner-only affordances. */
  currentUserRole?: ProjectRole;
  /** Owner restore handler. Promise lets us show transient progress. */
  onRestore?: (spaceId: string) => Promise<void> | void;
}

/**
 * Bucketed relative-time descriptor (key + ICU plural params).
 * Pure — returns the ICU message id to feed `t(rel.key, rel.params)`.
 */
export interface RelativeTime {
  key:
    | 'spaces.history.relative.justNow'
    | 'spaces.history.relative.minutesAgo'
    | 'spaces.history.relative.hoursAgo'
    | 'spaces.history.relative.yesterday'
    | 'spaces.history.relative.daysAgo'
    | 'spaces.history.relative.weeksAgo'
    | 'spaces.history.relative.monthsAgo'
    | 'spaces.history.relative.isoDate';
  params?: Record<string, string | number>;
}

/**
 * Buckets a past timestamp into a relative-time ICU descriptor
 * (just now / minutes / hours / yesterday / days / weeks / months / ISO date).
 * @param epochMs - The event timestamp in epoch milliseconds.
 * @param now - Reference "now" in epoch milliseconds; defaults to the current time.
 * @returns The ICU message key plus optional plural params for `t(...)`.
 */
function relativeTime(epochMs: number, now = Date.now()): RelativeTime {
  if (!Number.isFinite(epochMs))
    return {
      key: 'spaces.history.relative.isoDate',
      params: { date: String(epochMs) },
    };
  const diffMs = now - epochMs;
  const min = Math.floor(diffMs / 60_000);
  if (min < 1) return { key: 'spaces.history.relative.justNow' };
  if (min < 60)
    return { key: 'spaces.history.relative.minutesAgo', params: { count: min } };
  const hr = Math.floor(min / 60);
  if (hr < 24)
    return { key: 'spaces.history.relative.hoursAgo', params: { count: hr } };
  if (hr < 48) return { key: 'spaces.history.relative.yesterday' };
  const day = Math.floor(hr / 24);
  if (day < 7)
    return { key: 'spaces.history.relative.daysAgo', params: { count: day } };
  if (day < 30)
    return {
      key: 'spaces.history.relative.weeksAgo',
      params: { count: Math.floor(day / 7) },
    };
  if (day < 365)
    return {
      key: 'spaces.history.relative.monthsAgo',
      params: { count: Math.floor(day / 30) },
    };
  return {
    key: 'spaces.history.relative.isoDate',
    params: { date: new Date(epochMs).toISOString().slice(0, 10) },
  };
}

/**
 * Color-dot palette per event family. Uses semantic status / accent
 * tokens so dark / light mode both work.
 */
const TYPE_DOT_CLASS: Record<ProjectActivityType, string> = {
  'asset:uploaded': 'bg-status-success-border',
  'asset:deleted': 'bg-status-error-border',
  'generation:succeeded': 'bg-status-success-border',
  'generation:failed': 'bg-status-error-border',
  'space:created': 'bg-status-success-border',
  'space:deleted': 'bg-status-error-border',
  'space:locked': 'bg-status-info-border',
  'space:unlocked': 'bg-muted-foreground',
  'space:restored': 'bg-status-success-border',
  'space:renamed': 'bg-status-info-border',
  'member:joined': 'bg-status-success-border',
  'member:removed': 'bg-status-error-border',
  'member:role-changed': 'bg-status-info-border',
  'member:ownership-transferred': 'bg-status-info-border',
};

/**
 * Resolve the ICU message key + params for one feed entry. The space
 * family reuses the existing `spaces.history.kind.*` copy (same
 * wording, snapshot names travel in the payload now); asset /
 * generation / member events use the `activity.type.*` keys.
 * @param entry - The feed entry to render.
 * @returns The ICU key and its params.
 */
function entryMessage(entry: ProjectActivityEntry): {
  key: string;
  params: Record<string, string | number>;
} {
  const actor = entry.actorName ?? entry.actorUserId ?? 'system';
  const p = entry.payload;
  const spaceName = typeof p['spaceName'] === 'string' ? p['spaceName'] : '—';
  switch (entry.type) {
    case 'space:created':
      return { key: 'spaces.history.kind.spaceCreated', params: { actor, spaceName } };
    case 'space:deleted':
      return { key: 'spaces.history.kind.spaceDeleted', params: { actor, spaceName } };
    case 'space:locked':
      return { key: 'spaces.history.kind.spaceLocked', params: { actor, spaceName } };
    case 'space:unlocked':
      return { key: 'spaces.history.kind.spaceUnlocked', params: { actor, spaceName } };
    case 'space:restored':
      return { key: 'spaces.history.kind.spaceRestored', params: { actor, spaceName } };
    case 'space:renamed':
      return {
        key: 'spaces.history.kind.spaceRenamed',
        params: {
          actor,
          spaceName,
          oldSpaceName:
            typeof p['oldSpaceName'] === 'string' ? p['oldSpaceName'] : '',
        },
      };
    case 'asset:uploaded':
      return { key: 'activity.type.assetUploaded', params: { actor } };
    case 'asset:deleted':
      return { key: 'activity.type.assetDeleted', params: { actor } };
    case 'generation:succeeded':
      return typeof p['toolName'] === 'string'
        ? {
          key: 'activity.type.generationSucceededTool',
          params: { actor, toolName: p['toolName'] },
        }
        : { key: 'activity.type.generationSucceeded', params: { actor } };
    case 'generation:failed':
      return { key: 'activity.type.generationFailed', params: { actor } };
    case 'member:joined':
      return { key: 'activity.type.memberJoined', params: { actor } };
    case 'member:removed':
      return { key: 'activity.type.memberRemoved', params: { actor } };
    case 'member:role-changed':
      return {
        key: 'activity.type.memberRoleChanged',
        params: { actor, role: typeof p['role'] === 'string' ? p['role'] : '' },
      };
    case 'member:ownership-transferred':
      return { key: 'activity.type.ownershipTransferred', params: { actor } };
  }
}

/**
 * History clock icon on the right of the tab bar that opens the
 * project activity feed sheet (uploads, deletions, generations, space
 * lifecycle, member changes) with keyset paging, live signal-driven
 * refresh, and the owner-only restore affordance on space deletions.
 * @param root0 - Component props.
 * @param root0.projectId - Project whose feed to show.
 * @param root0.provider - Live meta-doc provider carrying the activity:new signal.
 * @param root0.currentUserRole - Caller's role, driving owner-only affordances.
 * @param root0.onRestore - Owner restore handler invoked with the deleted space's id.
 * @returns The history trigger button and its activity feed sheet.
 */
export function ProjectMessagesButton({
  projectId,
  provider,
  currentUserRole,
  onRestore,
}: ProjectMessagesButtonProps): JSX.Element {
  const t = useTranslation();
  const [open, setOpen] = useExclusiveOverlay('project-messages');
  const isOwner = currentUserRole === 'owner';
  const [busyId, setBusyId] = useState<string | null>(null);
  const queryClient = useQueryClient();
  const sentinelRef = useRef<HTMLLIElement | null>(null);

  const feed = useInfiniteQuery({
    queryKey: ['project-activities', projectId],
    queryFn: ({ pageParam }) =>
      activitiesApi.list(projectId, pageParam || undefined),
    initialPageParam: '',
    getNextPageParam: (lastPage) => lastPage.nextCursor,
    enabled: open,
    refetchOnWindowFocus: false,
  });

  // Live updates: the meta-doc socket broadcasts `activity:new`
  // whenever a row lands (collab directly; server/worker via the
  // control-plane relay). React by invalidating — the panel refetches
  // when open, and the next open fetches fresh anyway.
  useEffect(() => {
    if (!provider) return;
    /**
     * Parse a stateless payload and invalidate the feed on a signal.
     * @param data - The stateless message wrapper.
     * @param data.payload - Raw stateless string payload.
     */
    const onStateless = (data: { payload: string }): void => {
      try {
        const parsed = ActivityNewSignalSchema.safeParse(
          JSON.parse(data.payload),
        );
        if (parsed.success && parsed.data.projectId === projectId) {
          void queryClient.invalidateQueries({
            queryKey: ['project-activities', projectId],
          });
        }
      } catch {
        // Non-JSON stateless traffic (e.g. space RPC responses) — not ours.
      }
    };
    provider.on('stateless', onStateless);
    return (): void => {
      provider.off('stateless', onStateless);
    };
  }, [provider, projectId, queryClient]);

  // Infinite scroll: fetch the next page when the tail sentinel enters
  // the list viewport.
  useEffect(() => {
    const el = sentinelRef.current;
    if (!el || !open) return;
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting) && feed.hasNextPage && !feed.isFetchingNextPage) {
        void feed.fetchNextPage();
      }
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [open, feed]);

  /**
   * Restores a deleted space via `onRestore`, tracking per-entry busy
   * state, then refreshes the feed (the restore appends its own row).
   * @param spaceId - Id of the deleted space to restore.
   */
  const onClickRestore = async (spaceId: string): Promise<void> => {
    if (!onRestore) return;
    setBusyId(spaceId);
    try {
      await onRestore(spaceId);
      void queryClient.invalidateQueries({
        queryKey: ['project-activities', projectId],
      });
    } finally {
      setBusyId(null);
    }
  };

  const entries = feed.data?.pages.flatMap((p) => p.items) ?? [];

  return (
    <Sheet open={open} onOpenChange={setOpen} modal>
      <Tooltip>
        <TooltipTrigger asChild>
          <SheetTrigger asChild>
            <Button
              variant='chrome-ghost'
              size='chrome'
              aria-label={t('spaces.history.label')}
              data-testid='project-messages-trigger'
              onFocusCapture={suppressTooltipFocusOpen}
              style={{ height: 'var(--btn-chrome)', width: 'var(--btn-chrome)' }}
            >
              <History className='h-[18px] w-[18px]' />
            </Button>
          </SheetTrigger>
        </TooltipTrigger>
        <TooltipContent side='bottom'>
          {t('chrome.tooltip.projectMessages')}
        </TooltipContent>
      </Tooltip>
      {/*
        side='right-floating' = same variant as SpaceDrawer (sits between
        TabBar and ViewportToolbar). Width 315px = 75 % of the prior
        Popover width (420 × 0.75), product-confirmed. Sheet primitive
        ships the top-right [X] close button by default.
      */}
      <SheetContent
        side='right-floating'
        withOverlay
        className='flex w-[315px] flex-col p-0'
        data-testid='project-messages-sheet'
      >
        <header className='flex flex-col gap-2 border-b border-border px-4 py-3'>
          <SheetTitle className='pr-10 text-base font-semibold text-foreground'>
            {t('spaces.history.header')}
          </SheetTitle>
          <SheetDescription className='text-xs text-muted-foreground'>
            {t('activity.description')}
          </SheetDescription>
        </header>
        <ul
          className='flex flex-1 flex-col overflow-y-auto'
          role='list'
          data-testid='project-messages-list'
        >
          {entries.length === 0 ? (
            <li className='px-4 py-3 text-sm text-muted-foreground'>
              {feed.isLoading
                ? t('activity.loading')
                : t('spaces.history.empty')}
            </li>
          ) : (
            entries.map((m) => {
              const rel = relativeTime(m.createdAt);
              const alreadyRestored =
                m.type === 'space:deleted' && m.restored === true;
              const canRestore =
                isOwner &&
                m.type === 'space:deleted' &&
                Boolean(m.spaceId) &&
                !alreadyRestored;
              const showRestoredBadge =
                isOwner && m.type === 'space:deleted' && alreadyRestored;
              const msg = entryMessage(m);
              return (
                <li
                  key={m.id}
                  role='listitem'
                  data-testid={`project-messages-entry-${m.id}`}
                  className='flex items-start gap-3 border-b border-border px-4 py-3 last:border-b-0'
                >
                  <span
                    className={cn(
                      'mt-1.5 inline-block h-2 w-2 shrink-0 rounded-full',
                      TYPE_DOT_CLASS[m.type],
                    )}
                    aria-hidden
                    data-testid={`project-messages-dot-${m.id}`}
                  />
                  {m.type === 'generation:failed' ? (
                    <AlertTriangle
                      className='mt-0.5 h-4 w-4 shrink-0 text-status-warning-foreground'
                      aria-hidden
                    />
                  ) : null}
                  <div className='flex min-w-0 flex-1 flex-col gap-1'>
                    <p className='text-sm leading-relaxed text-foreground'>
                      {t(msg.key, msg.params)}
                    </p>
                    <p className='text-2xs tabular-nums text-muted-foreground'>
                      {t(rel.key, rel.params)}
                    </p>
                  </div>
                  {canRestore ? (
                    <button
                      type='button'
                      onClick={() => m.spaceId && onClickRestore(m.spaceId)}
                      disabled={busyId === m.spaceId}
                      data-testid={`project-messages-restore-${m.id}`}
                      className='mt-0.5 inline-flex items-center gap-1 rounded-md border border-border bg-background px-2 py-1 text-2xs text-foreground hover:bg-accent disabled:opacity-50'
                    >
                      <RotateCcw className='h-3 w-3' aria-hidden />
                      {t('spaces.history.action.restore')}
                    </button>
                  ) : showRestoredBadge ? (
                    <button
                      type='button'
                      disabled
                      aria-disabled
                      data-testid={`project-messages-restored-badge-${m.id}`}
                      className='mt-0.5 inline-flex items-center gap-1 rounded-md border border-border bg-background px-2 py-1 text-2xs text-muted-foreground opacity-60 cursor-not-allowed'
                    >
                      <RotateCcw className='h-3 w-3' aria-hidden />
                      {t('spaces.history.action.restored')}
                    </button>
                  ) : null}
                </li>
              );
            })
          )}
          {/* Tail sentinel: entering the viewport loads the next page. */}
          {feed.hasNextPage ? (
            <li
              ref={sentinelRef}
              role='listitem'
              aria-hidden
              data-testid='project-messages-load-more'
              className='px-4 py-2 text-center text-2xs text-muted-foreground'
            >
              {feed.isFetchingNextPage ? t('activity.loading') : ''}
            </li>
          ) : null}
        </ul>
      </SheetContent>
    </Sheet>
  );
}

export { relativeTime };
