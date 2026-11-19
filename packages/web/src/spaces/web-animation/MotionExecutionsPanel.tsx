// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import * as React from 'react';
import type { WebAnimationRowView } from '@breatic/shared/space-content';

import { ScrollArea } from '@web/components/ui/scroll-area';
import { Skeleton } from '@web/components/ui/skeleton';
import { Tabs, TabsList, TabsTrigger } from '@web/components/ui/tabs';
import { useTranslation } from '@web/i18n/use-translation';
import { ListLoadError, LoadMoreButton, listShows } from '@web/spaces/web-animation/list-states';
import type { MotionTab } from '@web/spaces/web-animation/motion-panels';
import { MotionPanel, MotionRow } from '@web/spaces/web-animation/motion-parts';
import { rowsOf, type MotionLists } from '@web/spaces/web-animation/use-motion-lists';

/** One list of a tab, with its paging. */
interface ListBlockProps {
  query: MotionLists['done']['own'];
  selectedId: string | null;
  onPick: (row: WebAnimationRowView) => void;
}

/**
 * The rows of one list and its Load more.
 * @param props - The list.
 * @param props.query - Its pages.
 * @param props.selectedId - The row the preview shows.
 * @param props.onPick - Opens a row.
 * @returns The rows.
 * @throws {never} Never.
 */
function ListBlock({ query, selectedId, onPick }: ListBlockProps): React.JSX.Element {
  return <>
    {rowsOf(query).map((row) => <MotionRow key={row.id} row={row} selected={row.id === selectedId} onPick={onPick} />)}
    {query.hasNextPage && <div className='p-2'><LoadMoreButton query={query} /></div>}
  </>;
}

/** The execution list's props. */
interface MotionExecutionsPanelProps {
  lists: MotionLists;
  tab: MotionTab;
  selectedId: string | null;
  onTab: (tab: MotionTab) => void;
  onPick: (row: WebAnimationRowView) => void;
  onClose: () => void;
}

/**
 * The execution list (#1490 design §7.1, §7.3): Completed and In Progress with their totals; each tab lists this
 * Space's rows, then the group made in a Timeline before Motion when it has any. A press opens a row in the preview
 * and keeps the panel open.
 * @param props - The lists and the panel's state.
 * @param props.lists - The Space's lists.
 * @param props.tab - The tab shown.
 * @param props.selectedId - The row the preview shows.
 * @param props.onTab - Switches the tab.
 * @param props.onPick - Opens a row.
 * @param props.onClose - Closes the panel.
 * @returns The panel.
 * @throws {never} Never.
 */
export function MotionExecutionsPanel({ lists, tab, selectedId, onTab, onPick, onClose }: MotionExecutionsPanelProps): React.JSX.Element {
  const t = useTranslation();
  const changeTab = React.useCallback((value: string): void => onTab(value === 'running' ? 'running' : 'done'), [onTab]);
  const current = lists[tab];
  const { refetch: refetchOwn } = current.own;
  const { refetch: refetchLegacy } = current.legacy;
  const retry = React.useCallback((): void => { void refetchOwn(); void refetchLegacy(); }, [refetchOwn, refetchLegacy]);
  const shows = listShows(current.own, current.legacy);
  const empty = rowsOf(current.own).length === 0 && rowsOf(current.legacy).length === 0;
  return <MotionPanel testId='motion-panel-executions' title={t('spaces.webAnimation.executions')} onClose={onClose}>
    <Tabs value={tab} onValueChange={changeTab} className='shrink-0 border-b border-border px-2 py-1.5'>
      <TabsList>
        <TabsTrigger value='done'>{t('spaces.webAnimation.completed')}<span className='tabular-nums'>{lists.totals.done}</span></TabsTrigger>
        <TabsTrigger value='running'>{t('spaces.webAnimation.inProgress')}<span className='tabular-nums'>{lists.totals.inProgress}</span></TabsTrigger>
      </TabsList>
    </Tabs>
    <ScrollArea className='min-h-0 flex-1'>
      {shows === 'pending' ? <div className='flex flex-col gap-2 p-2'>{[0, 1, 2].map((index) => <Skeleton key={index} className='h-12 w-full' />)}</div>
        : shows === 'failed' ? <ListLoadError message={t('spaces.webAnimation.listError')} onRetry={retry} />
          : empty ? <p className='p-6 text-center text-xs text-muted-foreground'>{t(tab === 'done' ? 'spaces.webAnimation.empty' : 'spaces.webAnimation.emptyInProgress')}</p>
            : <>
              <ListBlock query={current.own} selectedId={selectedId} onPick={onPick} />
              {rowsOf(current.legacy).length > 0 && <section data-testid='motion-legacy-group'>
                <h4 className='bg-muted px-3 py-1.5 text-2xs font-medium text-muted-foreground'>{t('spaces.webAnimation.madeInTimeline')}</h4>
                <ListBlock query={current.legacy} selectedId={selectedId} onPick={onPick} />
              </section>}
            </>}
    </ScrollArea>
  </MotionPanel>;
}
