// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

import * as React from 'react';
import type { ThreadData } from '@blocknote/core/comments';
import type { WebAnimationRowView } from '@breatic/shared/space-content';

import { Button } from '@web/components/ui/button';
import { ScrollArea } from '@web/components/ui/scroll-area';
import { useUserProfiles } from '@web/data/use-user-profiles';
import { useTranslation } from '@web/i18n/use-translation';
import { cn } from '@web/lib/utils';
import { bodyText } from '@web/spaces/document/use-comment-cards';
import { annotationGroups, type ListedAnnotation } from '@web/spaces/web-animation/annotation-groups';
import { MotionPanel, rowTitle } from '@web/spaces/web-animation/motion-parts';

/**
 * A time in a result as the panel and the cards show it: minutes, seconds and tenths.
 * @param seconds - The time.
 * @returns The text.
 * @throws {never} Never.
 */
export function formatAnnotationTime(seconds: number): string {
  const tenths = Math.max(0, Math.round(seconds * 10));
  const minutes = Math.floor(tenths / 600);
  const rest = (tenths % 600) / 10;
  return `${minutes}:${rest.toFixed(1).padStart(4, '0')}`;
}

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
  return <Button type='button' variant={null} size={null} data-testid={`motion-annotation-${item.id}`} onClick={open}
    className={cn('flex w-full gap-2 px-3 py-2 text-left hover-enabled:bg-accent', active && 'bg-accent-strong hover-enabled:bg-accent-strong')}>
    <span className='mt-0.5 w-10 shrink-0 text-2xs tabular-nums text-muted-foreground'>{formatAnnotationTime(item.anchor.timeSeconds)}</span>
    <span className='flex min-w-0 flex-1 flex-col gap-0.5'>
      <span className={cn('line-clamp-2 text-xs', item.thread.resolved && 'text-muted-foreground line-through')}>{first === undefined ? '' : bodyText(first.body)}</span>
      {details !== '' && <span className='truncate text-2xs text-muted-foreground'>{details}</span>}
    </span>
  </Button>;
});

/** The annotation panel's props. */
interface MotionAnnotationsPanelProps {
  threads: readonly ThreadData[];
  /** Result ids in the execution list's order. */
  order: readonly string[];
  rows: ReadonlyMap<string, WebAnimationRowView>;
  activeThreadId: string | null;
  onOpen: (threadId: string) => void;
  onClose: () => void;
}

/**
 * The annotation panel (#1490 design §7.1, §10.1): every thread of this Space grouped by the result it is on, each
 * group by time; Open leaves resolved threads out, All shows them struck through.
 * @param props - The threads and the panel's state.
 * @param props.threads - The Space's threads.
 * @param props.order - Result ids in the execution list's order.
 * @param props.rows - The loaded rows, for group titles.
 * @param props.activeThreadId - The thread whose card is open.
 * @param props.onOpen - Opens a thread on its result and time.
 * @param props.onClose - Closes the panel.
 * @returns The panel.
 * @throws {never} Never.
 */
export function MotionAnnotationsPanel({ threads, order, rows, activeThreadId, onOpen, onClose }: MotionAnnotationsPanelProps): React.JSX.Element {
  const t = useTranslation();
  const [filter, setFilter] = React.useState<'open' | 'all'>('open');
  const showOpen = React.useCallback((): void => setFilter('open'), []);
  const showAll = React.useCallback((): void => setFilter('all'), []);
  const groups = React.useMemo(() => annotationGroups(threads, { order, filter }), [threads, order, filter]);
  const live = threads.filter((thread) => thread.deletedAt === undefined);
  const openCount = live.filter((thread) => !thread.resolved).length;
  const authorIds = React.useMemo(() => groups.flatMap((group) => group.threads.map((item) => item.thread.comments[0]?.userId ?? '')).filter(Boolean), [groups]);
  const profiles = useUserProfiles(authorIds);
  return <MotionPanel testId='motion-panel-annotations' title={t('spaces.webAnimation.annotations')} onClose={onClose}>
    <div className='flex h-9 shrink-0 items-center gap-1 border-b border-border px-2'>
      <Button type='button' variant='ghost' size='compact' aria-pressed={filter === 'open'} onClick={showOpen} className='aria-pressed:bg-accent-strong'>
        {t('spaces.webAnimation.annotationsOpen', { count: openCount })}
      </Button>
      <Button type='button' variant='ghost' size='compact' aria-pressed={filter === 'all'} onClick={showAll} className='aria-pressed:bg-accent-strong'>
        {t('spaces.webAnimation.annotationsAll', { count: live.length })}
      </Button>
    </div>
    <ScrollArea className='min-h-0 flex-1'>
      {groups.length === 0
        ? <p className='p-6 text-center text-xs text-muted-foreground'>{t(filter === 'open' && live.length > 0 ? 'spaces.webAnimation.noOpenAnnotations' : 'spaces.webAnimation.noAnnotations')}</p>
        : groups.map((group) => {
          const row = rows.get(group.executionId);
          return <section key={group.executionId}>
            <h4 className='truncate px-3 pb-1 pt-2.5 text-2xs font-medium text-muted-foreground'>{row === undefined ? t('spaces.webAnimation.unlistedResult') : rowTitle(row, t)}</h4>
            {group.threads.map((item) => <AnnotationItem key={item.id} item={item} author={profiles.get(item.thread.comments[0]?.userId ?? '')?.name ?? null}
              active={item.id === activeThreadId} onOpen={onOpen} />)}
          </section>;
        })}
    </ScrollArea>
  </MotionPanel>;
}
