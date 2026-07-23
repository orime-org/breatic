// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import { Activity, AlertCircle, Film, Music, RotateCcw, Star } from 'lucide-react';
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
import { ScrollArea } from '@web/components/ui/scroll-area';
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
import { formatCredits } from '@web/lib/format-credits';
import { useExclusiveOverlay } from '@web/lib/use-exclusive-overlay';
import { suppressTooltipFocusOpen } from '@web/lib/overlay-focus';
import { HoverPreview } from '@web/spaces/canvas/nodes/_shared/HoverPreview';
import { useTranslation } from '@web/i18n/use-translation';

/**
 * Project activity feed surfaced by the Activity icon on the
 * right of the tab bar (ADR 2026-07-04 project-activity-feed).
 *
 * Backed by the PG `project_activities` table via
 * `GET /projects/:id/activities` (keyset pages, actor names resolved
 * server-side) — replaces the retired meta-doc `projectMessages`
 * Y.Array reader. Live updates arrive as the `activity:new` stateless
 * signal on the project meta doc socket; the panel reacts by
 * invalidating the query (Figma-style signal + refetch).
 */
export interface ProjectActivityButtonProps {
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
    | 'activity.relative.justNow'
    | 'activity.relative.minutesAgo'
    | 'activity.relative.hoursAgo'
    | 'activity.relative.yesterday'
    | 'activity.relative.daysAgo'
    | 'activity.relative.weeksAgo'
    | 'activity.relative.monthsAgo'
    | 'activity.relative.isoDate';
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
      key: 'activity.relative.isoDate',
      params: { date: String(epochMs) },
    };
  const diffMs = now - epochMs;
  const min = Math.floor(diffMs / 60_000);
  if (min < 1) return { key: 'activity.relative.justNow' };
  if (min < 60)
    return { key: 'activity.relative.minutesAgo', params: { count: min } };
  const hr = Math.floor(min / 60);
  if (hr < 24)
    return { key: 'activity.relative.hoursAgo', params: { count: hr } };
  if (hr < 48) return { key: 'activity.relative.yesterday' };
  const day = Math.floor(hr / 24);
  if (day < 7)
    return { key: 'activity.relative.daysAgo', params: { count: day } };
  if (day < 30)
    return {
      key: 'activity.relative.weeksAgo',
      params: { count: Math.floor(day / 7) },
    };
  if (day < 365)
    return {
      key: 'activity.relative.monthsAgo',
      params: { count: Math.floor(day / 30) },
    };
  return {
    key: 'activity.relative.isoDate',
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
 * Resolve the ICU message key + params for one feed entry. Every family
 * (space / asset / generation / member) uses the unified `activity.type.*`
 * keys (snapshot names travel in the payload now).
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
      return { key: 'activity.type.spaceCreated', params: { actor, spaceName } };
    case 'space:deleted':
      return { key: 'activity.type.spaceDeleted', params: { actor, spaceName } };
    case 'space:locked':
      return { key: 'activity.type.spaceLocked', params: { actor, spaceName } };
    case 'space:unlocked':
      return { key: 'activity.type.spaceUnlocked', params: { actor, spaceName } };
    case 'space:restored':
      return { key: 'activity.type.spaceRestored', params: { actor, spaceName } };
    case 'space:renamed':
      return {
        key: 'activity.type.spaceRenamed',
        params: {
          actor,
          spaceName,
          oldSpaceName:
            typeof p['oldSpaceName'] === 'string' ? p['oldSpaceName'] : '',
        },
      };
    case 'asset:uploaded': {
      // Specific copy per media kind (image / video / audio); a `file` kind or
      // an absent kind falls back to the generic upload message (#1622).
      const k = p['kind'];
      const key =
        k === 'image'
          ? 'activity.type.assetUploadedImage'
          : k === 'video'
            ? 'activity.type.assetUploadedVideo'
            : k === 'audio'
              ? 'activity.type.assetUploadedAudio'
              : 'activity.type.assetUploaded';
      return { key, params: { actor } };
    }
    case 'asset:deleted':
      return { key: 'activity.type.assetDeleted', params: { actor } };
    case 'generation:succeeded': {
      // A mini-tool names the tool it ran (more specific than the modality).
      if (typeof p['toolName'] === 'string')
        return {
          key: 'activity.type.generationSucceededTool',
          params: { actor, toolName: p['toolName'] },
        };
      // A canvas task generation says what modality it produced; a non-media
      // generation (understand) falls back to the generic message (#1622).
      const k = p['kind'];
      const key =
        k === 'image'
          ? 'activity.type.generationSucceededImage'
          : k === 'video'
            ? 'activity.type.generationSucceededVideo'
            : k === 'audio'
              ? 'activity.type.generationSucceededAudio'
              : 'activity.type.generationSucceeded';
      return { key, params: { actor } };
    }
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

/** A feed entry's renderable media preview (thumbnail + hover). */
export interface ActivityMedia {
  kind: 'image' | 'video' | 'audio';
  /** Primary media / image URL (the preview src). */
  src: string;
  /** Video cover (video only). */
  poster?: string;
}

/**
 * Derive the preview media for a feed entry, or null when the row has none.
 * Only an upload or a successful generation of one of the three renderable
 * modalities (image / video / audio) with a usable URL gets a thumbnail +
 * hover preview — a `file` upload, a non-media generation, a failure, or a
 * space / member event is a plain message row (spec §6.3).
 * @param entry - The feed entry.
 * @returns The preview media, or null.
 */
export function entryMedia(entry: ProjectActivityEntry): ActivityMedia | null {
  if (entry.type !== 'asset:uploaded' && entry.type !== 'generation:succeeded')
    return null;
  const p = entry.payload;
  const kind = p['kind'];
  if (kind !== 'image' && kind !== 'video' && kind !== 'audio') return null;
  const src = typeof p['fileUrl'] === 'string' ? p['fileUrl'] : undefined;
  if (!src) return null;
  const cover =
    kind === 'video' && typeof p['thumbnailUrl'] === 'string'
      ? p['thumbnailUrl']
      : undefined;
  return cover ? { kind, src, poster: cover } : { kind, src };
}

/**
 * The credit cost to show on a feed entry, or undefined to hide it. Only a
 * successful generation records an ACTUAL deducted cost (`payload.credits` —
 * the billed value, not the run-time estimate); uploads, failures, space /
 * member events and frontend mini-tools carry none. Gates through the shared
 * {@link formatCredits} so it matches the node-history row (spec §6.4 / INV-8).
 * @param entry - The feed entry.
 * @returns The credit cost, or undefined.
 */
function entryActivityCredits(entry: ProjectActivityEntry): number | undefined {
  if (entry.type !== 'generation:succeeded') return undefined;
  return formatCredits(entry.payload['credits']);
}

/**
 * Activity icon on the right of the tab bar that opens the
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
export function ProjectActivityButton({
  projectId,
  provider,
  currentUserRole,
  onRestore,
}: ProjectActivityButtonProps): JSX.Element {
  const t = useTranslation();
  const [open, setOpen] = useExclusiveOverlay('project-activity');
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
    let debounce: ReturnType<typeof setTimeout> | null = null;
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
          // Coalesce a burst (a bulk op emits many signals) into one
          // refetch on a short trailing timer.
          if (debounce) clearTimeout(debounce);
          debounce = setTimeout(() => {
            void queryClient.invalidateQueries({
              queryKey: ['project-activities', projectId],
            });
          }, 250);
        }
      } catch {
        // Non-JSON stateless traffic (e.g. space RPC responses) — not ours.
      }
    };
    provider.on('stateless', onStateless);
    return (): void => {
      if (debounce) clearTimeout(debounce);
      provider.off('stateless', onStateless);
    };
  }, [provider, projectId, queryClient]);

  // Infinite scroll: fetch the next page when the tail sentinel enters
  // the list viewport. Depends only on the primitives that matter (not
  // the whole query object, whose identity changes every render and
  // would tear down + rebuild the observer on each render).
  const { hasNextPage, isFetchingNextPage, fetchNextPage } = feed;
  useEffect(() => {
    const el = sentinelRef.current;
    if (!el || !open) return;
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting) && hasNextPage && !isFetchingNextPage) {
        void fetchNextPage();
      }
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [open, hasNextPage, isFetchingNextPage, fetchNextPage]);

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
              aria-label={t('activity.label')}
              data-testid='project-activity-trigger'
              onFocusCapture={suppressTooltipFocusOpen}
              style={{ height: 'var(--btn-chrome)', width: 'var(--btn-chrome)' }}
            >
              <Activity className='h-[18px] w-[18px]' />
            </Button>
          </SheetTrigger>
        </TooltipTrigger>
        <TooltipContent side='bottom'>
          {t('chrome.tooltip.projectActivity')}
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
        data-testid='project-activity-sheet'
      >
        <header className='flex flex-col gap-2 border-b border-border px-4 py-3'>
          <SheetTitle className='pr-10 text-base font-semibold text-foreground'>
            {t('activity.header')}
          </SheetTitle>
          <SheetDescription className='text-xs text-muted-foreground'>
            {t('activity.description')}
          </SheetDescription>
        </header>
        {/* ScrollArea (#1773): overlay scrollbar — appears only while
            scrolling, no layout space, hover changes color only. */}
        <ScrollArea className='min-h-0 flex-1'>
          <ul
            className='flex flex-col'
            role='list'
            data-testid='project-activity-list'
          >
            {entries.length === 0 ? (
              <li className='px-4 py-3 text-sm text-muted-foreground'>
                {feed.isLoading
                  ? t('activity.loading')
                  : t('activity.empty')}
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
                const media = entryMedia(m);
                const credits = entryActivityCredits(m);
                // 46px thumbnail: the image / video cover itself, or a modality
                // icon when there is no still (audio, or a cover-less video —
                // #1816). Mirrors NodeHistoryRow's fallback.
                const thumb = media ? (
                  <div
                    data-testid={`project-activity-thumb-${m.id}`}
                    className='flex h-[46px] w-[46px] shrink-0 items-center justify-center overflow-hidden rounded-content-sm border border-border bg-muted text-muted-foreground'
                  >
                    {media.kind === 'image' ||
                    (media.kind === 'video' && media.poster) ? (
                        <img
                          src={media.kind === 'image' ? media.src : media.poster}
                          alt=''
                          className='h-full w-full object-cover'
                          loading='lazy'
                          decoding='async'
                          draggable={false}
                        />
                      ) : media.kind === 'video' ? (
                        <Film className='h-4 w-4' aria-hidden='true' />
                      ) : (
                        <Music className='h-4 w-4' aria-hidden='true' />
                      )}
                  </div>
                ) : null;
                return (
                  <li
                    key={m.id}
                    role='listitem'
                    data-testid={`project-activity-entry-${m.id}`}
                    className='flex items-start gap-3 border-b border-border px-4 py-3 last:border-b-0'
                  >
                    <span
                      className={cn(
                        'mt-1.5 inline-block h-2 w-2 shrink-0 rounded-full',
                        TYPE_DOT_CLASS[m.type],
                      )}
                      aria-hidden
                      data-testid={`project-activity-dot-${m.id}`}
                    />
                    {m.type === 'generation:failed' ? (
                      <div
                        data-testid={`project-activity-failed-icon-${m.id}`}
                        className='flex h-[46px] w-[46px] shrink-0 items-center justify-center overflow-hidden rounded-content-sm border border-border bg-muted text-status-error'
                        aria-hidden
                      >
                        <AlertCircle className='h-4 w-4' />
                      </div>
                    ) : null}
                    {/* Media rows get a thumbnail whose hover pops a large,
                        playable preview (image = still, audio / video =
                        MediaPlayer). Non-media rows render no thumbnail. */}
                    {media && thumb ? (
                      <HoverPreview
                        kind={media.kind}
                        src={media.src}
                        poster={media.poster}
                      >
                        {thumb}
                      </HoverPreview>
                    ) : null}
                    <div className='flex min-w-0 flex-1 flex-col gap-1'>
                      <p className='text-sm leading-relaxed text-foreground'>
                        {t(msg.key, msg.params)}
                      </p>
                      <div className='flex items-center justify-between gap-2'>
                        <span className='text-2xs tabular-nums text-muted-foreground'>
                          {t(rel.key, rel.params)}
                        </span>
                        {/* Actual credits deducted (spec §6.4 / INV-8): raw
                            value, 0 shown, hidden when there is no cost. */}
                        {credits != null ? (
                          <span
                            data-testid={`project-activity-credits-${m.id}`}
                            className='inline-flex shrink-0 items-center gap-0.5 text-xs tabular-nums text-foreground'
                          >
                            <Star
                              className='h-3 w-3 text-muted-foreground'
                              aria-hidden='true'
                            />
                            {credits}
                          </span>
                        ) : null}
                      </div>
                    </div>
                    {canRestore ? (
                      <button
                        type='button'
                        onClick={() => m.spaceId && onClickRestore(m.spaceId)}
                        disabled={busyId === m.spaceId}
                        data-testid={`project-activity-restore-${m.id}`}
                        className='mt-0.5 inline-flex items-center gap-1 rounded-md border border-border bg-background px-2 py-1 text-2xs text-foreground hover:bg-accent disabled:opacity-50'
                      >
                        <RotateCcw className='h-3 w-3' aria-hidden />
                        {t('activity.action.restore')}
                      </button>
                    ) : showRestoredBadge ? (
                      <button
                        type='button'
                        disabled
                        aria-disabled
                        data-testid={`project-activity-restored-badge-${m.id}`}
                        className='mt-0.5 inline-flex items-center gap-1 rounded-md border border-border bg-background px-2 py-1 text-2xs text-muted-foreground opacity-60 cursor-not-allowed'
                      >
                        <RotateCcw className='h-3 w-3' aria-hidden />
                        {t('activity.action.restored')}
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
                data-testid='project-activity-load-more'
                className='px-4 py-2 text-center text-2xs text-muted-foreground'
              >
                {feed.isFetchingNextPage ? t('activity.loading') : ''}
              </li>
            ) : null}
          </ul>
        </ScrollArea>
      </SheetContent>
    </Sheet>
  );
}

export { relativeTime, entryMessage };
