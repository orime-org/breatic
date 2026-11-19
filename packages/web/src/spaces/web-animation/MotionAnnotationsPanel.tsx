// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import * as React from 'react';
import type { ThreadData } from '@blocknote/core/comments';
import type { WebAnimationRowView } from '@breatic/shared/space-content';

import { FilterButton } from '@web/components/FilterButton';
import { Button } from '@web/components/ui/button';
import { ScrollArea } from '@web/components/ui/scroll-area';
import { useUserProfiles } from '@web/data/use-user-profiles';
import { useTranslation } from '@web/i18n/use-translation';
import { cn } from '@web/lib/utils';
import { bodyText } from '@web/spaces/document/use-comment-cards';
import { annotationGroups, type ListedAnnotation } from '@web/spaces/web-animation/annotation-groups';
import type { AnnotationFilter } from '@web/spaces/web-animation/use-motion-annotations';
import { MotionPanel, formatMotionTime } from '@web/spaces/web-animation/motion-parts';
import { webAnimationTitle } from '@web/spaces/web-animation/web-animation-title';

/** One listed thread. */
interface AnnotationItemProps {
  item: ListedAnnotation<ThreadData>;
  author: string | null;
  active: boolean;
  onOpen: (threadId: string) => void;
}

/**
 * One thread: its time, its first comment, who wrote it, how many replies and whether it marks a point.
 * @param props - The thread.
 * @param props.item - The thread and its anchor.
 * @param props.author - Its first comment's author, once known.
 * @param props.active - Whether its card is open.
 * @param props.onOpen - Opens it.
 * @returns The item.
 * @throws {never} Never.
 */
const AnnotationItem = React.memo(function AnnotationItem({ item, author, active, onOpen }: AnnotationItemProps): React.JSX.Element {
  const t = useTranslation();
  const open = React.useCallback((): void => onOpen(item.id), [onOpen, item.id]);
  const comments = item.thread.comments.filter((comment) => comment.deletedAt === undefined);
  const first = comments[0];
  const details = [
    author,
    comments.length > 1 ? t('spaces.webAnimation.replies', { count: comments.length - 1 }) : null,
    item.anchor.point !== null ? t('spaces.webAnimation.hasPoint') : null,
  ].filter((part): part is string => part !== null).join(' · ');
  // Recessive text one step stronger on the hovered or chosen fill, where muted-foreground falls under 4.5:1.
  const secondary = active ? 'text-row-foreground-muted' : 'text-muted-foreground group-hover/row:text-row-foreground-muted';
  return <Button type='button' variant={null} size={null} data-testid={`motion-annotation-${item.id}`} data-thread-id={item.id} aria-current={active ? 'true' : undefined} onClick={open}
    className={cn('group/row flex w-full gap-2 px-3 py-2 text-left hover-enabled:bg-accent', active && 'bg-accent-strong hover-enabled:bg-accent-strong')}>
    <span className={cn('mt-0.5 w-10 shrink-0 text-2xs tabular-nums', secondary)}>{formatMotionTime(item.anchor.timeSeconds)}</span>
    <span className='flex min-w-0 flex-1 flex-col gap-0.5'>
      <span className={cn('line-clamp-2 text-xs', item.thread.resolved && cn('line-through', secondary))}>{first === undefined ? '' : bodyText(first.body)}</span>
      {details !== '' && <span className={cn('truncate text-2xs', secondary)}>{details}</span>}
    </span>
  </Button>;
});

/** The annotation panel's props. */
interface MotionAnnotationsPanelProps {
  threads: readonly ThreadData[];
  /** Result ids in the execution list's order. */
  order: readonly string[];
  /** A result's row: on a loaded page, or the shown one. */
  rowOf: (id: string) => WebAnimationRowView | undefined;
  activeThreadId: string | null;
  /** Open leaves resolved threads out; opening a resolved thread switches it to All. */
  filter: AnnotationFilter;
  onFilter: (filter: AnnotationFilter) => void;
  /** The list's scroller, which opening a thread scrolls to its item. */
  viewportRef: React.Ref<HTMLDivElement>;
  onOpen: (threadId: string) => void;
  onClose: () => void;
}

/**
 * The annotation panel (#1490 design §7.1, §10.1): every thread of this Space grouped by the result it is on, each
 * group by time; Open leaves resolved threads out, All shows them struck through.
 * @param props - The threads and the panel's state.
 * @param props.threads - The Space's threads.
 * @param props.order - Result ids in the execution list's order.
 * @param props.rowOf - A result's row, for group titles.
 * @param props.activeThreadId - The thread whose card is open.
 * @param props.filter - Which threads it lists.
 * @param props.onFilter - Switches between Open and All.
 * @param props.viewportRef - Receives the list's scroller.
 * @param props.onOpen - Opens a thread on its result and time.
 * @param props.onClose - Closes the panel.
 * @returns The panel.
 * @throws {never} Never.
 */
export const MotionAnnotationsPanel = React.memo(function MotionAnnotationsPanel({ threads, order, rowOf, activeThreadId, filter, onFilter, viewportRef, onOpen, onClose }: MotionAnnotationsPanelProps): React.JSX.Element {
  const t = useTranslation();
  const showOpen = React.useCallback((): void => onFilter('open'), [onFilter]);
  const showAll = React.useCallback((): void => onFilter('all'), [onFilter]);
  const groups = React.useMemo(() => annotationGroups(threads, { order, filter }), [threads, order, filter]);
  const live = threads.filter((thread) => thread.deletedAt === undefined);
  const openCount = live.filter((thread) => !thread.resolved).length;
  const authorIds = React.useMemo(() => groups.flatMap((group) => group.threads.map((item) => item.thread.comments[0]?.userId ?? '')).filter(Boolean), [groups]);
  const profiles = useUserProfiles(authorIds);
  return <MotionPanel testId='motion-panel-annotations' title={t('spaces.webAnimation.annotations')} onClose={onClose}>
    <div className='flex h-9 shrink-0 items-center gap-0.5 border-b border-border px-2'>
      <FilterButton testId='motion-annotations-filter-open' on={filter === 'open'} label={t('spaces.webAnimation.annotationsOpen')} count={openCount} onPress={showOpen} />
      <FilterButton testId='motion-annotations-filter-all' on={filter === 'all'} label={t('spaces.webAnimation.annotationsAll')} count={live.length} onPress={showAll} />
    </div>
    <ScrollArea className='min-h-0 flex-1' viewportRef={viewportRef}>
      {groups.length === 0
        ? <p className='p-6 text-center text-xs text-muted-foreground'>{t(filter === 'open' && live.length > 0 ? 'spaces.webAnimation.noOpenAnnotations' : 'spaces.webAnimation.noAnnotations')}</p>
        : groups.map((group) => {
          const row = rowOf(group.executionId);
          return <section key={group.executionId}>
            <h4 className='truncate px-3 pb-1 pt-2.5 text-2xs font-medium text-muted-foreground'>{row === undefined ? t('spaces.webAnimation.unlistedResult') : webAnimationTitle(row, t)}</h4>
            {group.threads.map((item) => <AnnotationItem key={item.id} item={item} author={profiles.get(item.thread.comments[0]?.userId ?? '')?.name ?? null}
              active={item.id === activeThreadId} onOpen={onOpen} />)}
          </section>;
        })}
    </ScrollArea>
  </MotionPanel>;
});
