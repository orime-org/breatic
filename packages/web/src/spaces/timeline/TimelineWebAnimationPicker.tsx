// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import * as React from 'react';
import { useInfiniteQuery } from '@tanstack/react-query';
import { Clapperboard, Code } from 'lucide-react';
import type { WebAnimationRowView } from '@breatic/shared/space-content';

import { Button } from '@web/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@web/components/ui/dialog';
import { ScrollArea } from '@web/components/ui/scroll-area';
import { Skeleton } from '@web/components/ui/skeleton';
import { timelineApi } from '@web/data/api/timeline';
import { useProjectSpaceList, type ProjectSpace } from '@web/data/yjs/project-meta';
import { useTranslation } from '@web/i18n/use-translation';
import { useReturnFocus } from '@web/lib/overlay-focus';
import { ListLoadError, LoadMoreButton, listShows } from '@web/spaces/web-animation/list-states';
import { webAnimationTitle } from '@web/spaces/web-animation/web-animation-title';

/** A result the picker offers: a create or a modification that succeeded, with the source a copy binds to. */
export type PickableResult = Extract<WebAnimationRowView, { kind: 'web_animation_create' | 'web_animation_modify' }> & { resultSourceVersionId: string };

/**
 * Whether a row of the results list is a result the picker offers.
 * @param row - The row.
 * @returns True for a succeeded create or modification.
 * @throws {never} Never.
 */
function isPickable(row: WebAnimationRowView): row is PickableResult {
  return row.kind !== 'web_animation_export' && row.status === 'succeeded' && row.resultSourceVersionId !== null;
}

/** One group of the picker: the Space that made its results. */
interface ResultGroup {
  /** The Space's id, or `deleted` for Spaces the Project no longer lists. */
  key: string;
  name: string;
  rows: PickableResult[];
}

/**
 * The picker's groups (#1490 design §8.2): Motion Spaces first, then Timelines (results made there before Motion), then
 * Spaces no longer listed; groups keep the order their newest result has, rows stay newest first.
 * @param rows - The Project's results, newest first.
 * @param spaces - The Project's Spaces.
 * @param deletedName - The name of the group of Spaces no longer listed.
 * @returns The groups.
 * @throws {never} Never.
 */
function groupResults(rows: readonly PickableResult[], spaces: ReadonlyArray<ProjectSpace>, deletedName: string): ResultGroup[] {
  const byId = new Map(spaces.map((space) => [space.id, space]));
  const groups = new Map<string, ResultGroup & { rank: number }>();
  for (const row of rows) {
    const space = byId.get(row.spaceId);
    const key = space === undefined ? 'deleted' : space.id;
    const rank = space === undefined ? 2 : space.type === 'web_animation' ? 0 : 1;
    const group = groups.get(key) ?? { key, name: space?.name ?? deletedName, rows: [], rank };
    group.rows.push(row);
    groups.set(key, group);
  }
  return [...groups.values()].sort((a, b) => a.rank - b.rank);
}

/** One result row. */
interface PickerRowProps { row: PickableResult; onPick: (row: PickableResult) => void }

/**
 * One result: its title, aspect and length.
 * @param props - The row.
 * @param props.row - The result.
 * @param props.onPick - Places a copy of it.
 * @returns The row.
 * @throws {never} Never.
 */
const PickerRow = React.memo(function PickerRow({ row, onPick }: PickerRowProps): React.JSX.Element {
  const t = useTranslation();
  const pick = React.useCallback((): void => onPick(row), [onPick, row]);
  return <Button type='button' variant={null} size={null} data-testid={`timeline-picker-row-${row.id}`} onClick={pick}
    className='flex w-full min-w-0 items-center gap-2 rounded-chrome px-2 py-2 text-left text-sm hover-enabled:bg-accent'>
    <Code className='size-4 shrink-0 text-[color:var(--color-palette-violet)]' />
    <span className='flex min-w-0 flex-1 flex-col gap-1'>
      <span className='min-w-0 truncate leading-normal'>{webAnimationTitle(row, t)}</span>
      <span className='text-xs tabular-nums text-muted-foreground'>
        {`${row.input.aspect} · ${t('timeline.webAnimation.durationShort', { seconds: row.input.durationSeconds })}`}
      </span>
    </span>
  </Button>;
});

/** The picker's props. */
interface TimelineWebAnimationPickerProps {
  projectId: string;
  /** Whether a Motion Space is being made for "Make in Motion". */
  making: boolean;
  onPick: (row: PickableResult) => void;
  onGoMake: () => void;
  onClose: () => void;
}

/**
 * "Add web animation" (#1490 design §8.2): the Project's succeeded web-animation results, read again on every open and
 * grouped by the Space that made them; a pick places a copy at the playhead, and "Make in Motion" opens the newest
 * Motion Space.
 * @param props - The Project and what a pick does.
 * @param props.projectId - The Project.
 * @param props.making - Whether a Motion Space is being made.
 * @param props.onPick - Places a copy of the picked result.
 * @param props.onGoMake - Opens the newest Motion Space, or makes one.
 * @param props.onClose - Closes the picker.
 * @returns The picker.
 * @throws {never} Never.
 */
export function TimelineWebAnimationPicker({ projectId, making, onPick, onGoMake, onClose }: TimelineWebAnimationPickerProps): React.JSX.Element {
  const t = useTranslation();
  const returnFocus = useReturnFocus(true);
  const spaces = useProjectSpaceList(projectId);
  const queryKey = React.useMemo(() => ['timeline-web-results', projectId], [projectId]);
  const queryFn = React.useCallback(({ pageParam, signal }: { pageParam: string | undefined; signal: AbortSignal }) => timelineApi.listResults(projectId, pageParam, signal), [projectId]);
  const list = useInfiniteQuery({ queryKey, queryFn, initialPageParam: undefined as string | undefined, getNextPageParam: (page) => page.nextCursor ?? undefined });
  const { refetch } = list;
  const shows = listShows(list);
  const rows = React.useMemo(() => (list.data?.pages.flatMap((page) => page.rows) ?? [])
    .filter(isPickable), [list.data]);
  const groups = React.useMemo(() => groupResults(rows, spaces, t('timeline.webAnimation.picker.deletedSpace')), [rows, spaces, t]);
  const changeOpen = React.useCallback((open: boolean): void => { if (!open) onClose(); }, [onClose]);
  const retry = React.useCallback((): void => { void refetch(); }, [refetch]);
  return <Dialog open onOpenChange={changeOpen}>
    <DialogContent data-testid='timeline-web-animation-picker' onCloseAutoFocus={returnFocus} className='grid max-h-[min(36rem,85vh)] grid-rows-[auto_minmax(0,1fr)_auto] gap-0 p-0'>
      <DialogHeader className='shrink-0 border-b border-border p-4'>
        <DialogTitle>{t('timeline.webAnimation.picker.title')}</DialogTitle>
        <DialogDescription>{t('timeline.webAnimation.picker.description')}</DialogDescription>
      </DialogHeader>
      {/* The body grows with the rows and scrolls at the cap; grid tracks keep the cap definite for the scroller. */}
      <ScrollArea className='min-h-0' viewportClassName='p-4'>
        {shows === 'pending' && <div className='flex flex-col gap-2'>{[0, 1, 2].map((index) => <Skeleton key={index} className='h-12 w-full' />)}</div>}
        {shows === 'failed' && <ListLoadError message={t('timeline.webAnimation.picker.error')} onRetry={retry} testId='timeline-web-animation-picker-retry' />}
        {shows === 'ready' && rows.length === 0 && <p className='py-6 text-sm text-muted-foreground'>{t('timeline.webAnimation.picker.empty')}</p>}
        <div className='flex flex-col gap-4'>
          {groups.map((group) => <section key={group.key} data-testid={`timeline-picker-group-${group.key}`} className='flex flex-col gap-1'>
            <h3 className='truncate text-xs font-medium text-muted-foreground'>{group.name}</h3>
            {group.rows.map((row) => <PickerRow key={row.id} row={row} onPick={onPick} />)}
          </section>)}
        </div>
        <LoadMoreButton query={list} className='mt-3' />
      </ScrollArea>
      <DialogFooter className='shrink-0 border-t border-border p-4 sm:justify-between'>
        <Button type='button' data-testid='timeline-web-animation-go-make' variant='outline' className='gap-1.5' loading={making} onClick={onGoMake} icon={<Clapperboard className='size-4' />}>{t('timeline.webAnimation.goMake')}</Button>
        <Button type='button' variant='outline' onClick={onClose}>{t('timeline.cancel')}</Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>;
}
