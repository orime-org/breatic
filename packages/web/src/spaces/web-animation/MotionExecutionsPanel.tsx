// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import * as React from 'react';
import { RotateCcw, X } from 'lucide-react';
import type { WebAnimationRowView } from '@breatic/shared/space-content';

import { Button } from '@web/components/ui/button';
import { ScrollArea } from '@web/components/ui/scroll-area';
import { Tabs, TabsList, TabsTrigger } from '@web/components/ui/tabs';
import { useTranslation } from '@web/i18n/use-translation';
import { cn } from '@web/lib/utils';
import { useRunning } from '@web/stores/task-actions-in-flight';
import { cancelIntent, endedSentenceKey, exportIntent } from '@web/spaces/web-animation/execution-text';
import { ListLoadError, ListPending, LoadMoreButton, listShows } from '@web/spaces/web-animation/list-states';
import type { MotionTab } from '@web/spaces/web-animation/motion-panels';
import { MotionPanel, MotionRow, rowStep, rowSummary } from '@web/spaces/web-animation/motion-parts';
import { rowsOf, type MotionLists } from '@web/spaces/web-animation/use-motion-lists';
import { webAnimationTitle } from '@web/spaces/web-animation/web-animation-title';

/** The tabs in the order the list shows them, with the catalog key of each name and of its empty state. */
const TABS: ReadonlyArray<{ tab: MotionTab; name: string; empty: string }> = [
  { tab: 'succeeded', name: 'spaces.webAnimation.completed', empty: 'spaces.webAnimation.empty' },
  { tab: 'running', name: 'spaces.webAnimation.inProgress', empty: 'spaces.webAnimation.emptyInProgress' },
  { tab: 'failed', name: 'spaces.webAnimation.failed', empty: 'spaces.webAnimation.emptyFailed' },
];

/**
 * Whether a value names a tab.
 * @param value - The value.
 * @returns True for a tab.
 * @throws {never} Never.
 */
function isTab(value: string): value is MotionTab {
  return TABS.some(({ tab }) => tab === value);
}

/** What the rows of the In progress and Failed tabs act with. */
interface RowActions {
  spaceId: string;
  readOnly: boolean;
  onCancel: (row: WebAnimationRowView) => void;
  onRetry: (row: WebAnimationRowView) => void;
}

/** A row of the In progress or Failed tab. */
interface ActionRowProps extends RowActions {
  row: WebAnimationRowView;
  marked: boolean;
}

/**
 * A row in progress: its title, summary and step, and Cancel for this Project's own rows (#1490 design §7.2). A press
 * on the row changes nothing; the preview only holds succeeded results.
 * @param props - The row.
 * @param props.row - The execution.
 * @param props.marked - Whether the list marks it.
 * @param props.readOnly - Whether the user may act.
 * @param props.onCancel - Cancels it.
 * @returns The row.
 * @throws {never} Never.
 */
const ProgressRow = React.memo(function ProgressRow({ row, marked, readOnly, onCancel }: ActionRowProps): React.JSX.Element {
  const t = useTranslation();
  const cancelling = useRunning(cancelIntent(row.id)) !== undefined;
  const cancel = React.useCallback((): void => onCancel(row), [onCancel, row]);
  return <RowFrame row={row} marked={marked} detail={<span className='truncate text-2xs'>{rowStep(row, t)}</span>}
    action={!readOnly && row.ownProject && row.status !== 'cancelling'
      ? <Button type='button' data-testid='motion-cancel' variant='outline' size='sm' className='gap-1.5' loading={cancelling} onClick={cancel} icon={<X className='size-4' />}>{t('timeline.webAnimation.cancel')}</Button>
      : null} />;
});

/**
 * A row that failed, was cancelled or expired: its title, summary and reason, and Run again (Export again for an
 * export) (#1490 design §7.2). A press on the row changes nothing.
 * @param props - The row.
 * @param props.row - The execution.
 * @param props.marked - Whether the list marks it.
 * @param props.spaceId - The Motion Space, whose export of a source Export again waits on.
 * @param props.readOnly - Whether the user may act.
 * @param props.onRetry - Runs it again.
 * @returns The row.
 * @throws {never} Never.
 */
const FailedRow = React.memo(function FailedRow({ row, marked, spaceId, readOnly, onRetry }: ActionRowProps): React.JSX.Element {
  const t = useTranslation();
  const exporting = useRunning(row.kind === 'web_animation_export' ? exportIntent(spaceId, row.input.sourceVersionId) : '') !== undefined;
  const retry = React.useCallback((): void => onRetry(row), [onRetry, row]);
  return <RowFrame row={row} marked={marked}
    detail={<span className={cn('truncate text-2xs', row.status === 'failed' ? 'text-status-error-foreground' : 'text-muted-foreground')}>{t(endedSentenceKey(row.status, row.failureReason))}</span>}
    action={readOnly ? null : <Button type='button' data-testid='motion-retry' variant='outline' size='sm' className='gap-1.5' loading={exporting} onClick={retry} icon={<RotateCcw className='size-4' />}>
      {t(row.kind === 'web_animation_export' ? 'spaces.webAnimation.reexport' : 'timeline.webAnimation.retry')}</Button>} />;
});

/** The frame both kinds of action row share. */
interface RowFrameProps {
  row: WebAnimationRowView;
  marked: boolean;
  detail: React.ReactNode;
  action: React.ReactNode;
}

/**
 * The frame of a row that does not open in the preview: title, summary and one more line, the action on the right; a
 * marked row wears the selected look.
 * @param props - The row.
 * @param props.row - The execution.
 * @param props.marked - Whether the list marks it.
 * @param props.detail - The step or the reason.
 * @param props.action - Cancel or Run again, or nothing.
 * @returns The row.
 * @throws {never} Never.
 */
function RowFrame({ row, marked, detail, action }: RowFrameProps): React.JSX.Element {
  const t = useTranslation();
  return <div data-testid={`motion-row-${row.id}`} data-marked={marked || undefined}
    className={cn('flex items-start gap-2 border-b border-border px-3 py-2', marked && 'bg-accent-strong')}>
    <div className='flex min-w-0 flex-1 flex-col gap-0.5'>
      <span className='truncate text-xs font-medium'>{webAnimationTitle(row, t)}</span>
      <span className={cn('truncate text-2xs', marked ? 'text-row-foreground-muted' : 'text-muted-foreground')}>{rowSummary(row, t)}</span>
      {detail}
    </div>
    {action}
  </div>;
}

/** One list of a tab, with its paging. */
interface ListBlockProps extends RowActions {
  query: MotionLists['succeeded']['own'];
  tab: MotionTab;
  selectedId: string | null;
  markedId: string | null;
  onPick: (row: WebAnimationRowView) => void;
}

/**
 * The rows of one list and its Load more: Completed rows open in the preview, the others act from their buttons.
 * @param props - The list.
 * @param props.query - Its pages.
 * @param props.tab - Which tab it fills.
 * @param props.selectedId - The row the preview shows.
 * @param props.markedId - The row the list marks.
 * @param props.onPick - Opens a Completed row.
 * @returns The rows.
 * @throws {never} Never.
 */
function ListBlock({ query, tab, selectedId, markedId, onPick, ...actions }: ListBlockProps): React.JSX.Element {
  return <>
    {rowsOf(query).map((row) => tab === 'succeeded'
      ? <MotionRow key={row.id} row={row} selected={row.id === selectedId} onPick={onPick} />
      : tab === 'running'
        ? <ProgressRow key={row.id} row={row} marked={row.id === markedId} {...actions} />
        : <FailedRow key={row.id} row={row} marked={row.id === markedId} {...actions} />)}
    {query.hasNextPage && <div className='p-2'><LoadMoreButton query={query} /></div>}
  </>;
}

/** The execution list's props. */
interface MotionExecutionsPanelProps extends RowActions {
  lists: MotionLists;
  tab: MotionTab;
  selectedId: string | null;
  markedId: string | null;
  onTab: (tab: MotionTab) => void;
  onPick: (row: WebAnimationRowView) => void;
  onClose: () => void;
}

/**
 * The execution list (#1490 design §7.1, §7.3): Completed, In progress and Failed with their totals; each tab lists
 * this Space's rows, then the group made in a Timeline before Motion when it has any. A Completed row opens in the
 * preview and keeps the panel open; In progress rows offer Cancel and Failed rows Run again.
 * @param props - The lists and the panel's state.
 * @param props.lists - The Space's lists.
 * @param props.tab - The tab shown.
 * @param props.selectedId - The row the preview shows.
 * @param props.markedId - The row the list marks.
 * @param props.spaceId - The Motion Space.
 * @param props.readOnly - Whether the user may act.
 * @param props.onTab - Switches the tab.
 * @param props.onPick - Opens a Completed row.
 * @param props.onCancel - Cancels a row in progress.
 * @param props.onRetry - Runs a failed row again.
 * @param props.onClose - Closes the panel.
 * @returns The panel.
 * @throws {never} Never.
 */
export const MotionExecutionsPanel = React.memo(function MotionExecutionsPanel({ lists, tab, selectedId, markedId, onTab, onPick, onClose, ...actions }: MotionExecutionsPanelProps): React.JSX.Element {
  const t = useTranslation();
  const changeTab = React.useCallback((value: string): void => { if (isTab(value)) onTab(value); }, [onTab]);
  const current = lists[tab];
  const { refetch: refetchOwn } = current.own;
  const { refetch: refetchLegacy } = current.legacy;
  const retry = React.useCallback((): void => { void refetchOwn(); void refetchLegacy(); }, [refetchOwn, refetchLegacy]);
  const shows = listShows(current.own, current.legacy);
  const empty = rowsOf(current.own).length === 0 && rowsOf(current.legacy).length === 0;
  const emptyKey = TABS.find((entry) => entry.tab === tab)?.empty ?? 'spaces.webAnimation.empty';
  return <MotionPanel testId='motion-panel-executions' title={t('spaces.webAnimation.executions')} onClose={onClose}>
    <Tabs value={tab} onValueChange={changeTab} className='shrink-0 border-b border-border px-2 py-1.5'>
      <TabsList>
        {TABS.map((entry) => <TabsTrigger key={entry.tab} value={entry.tab}>{t(entry.name)}<span className='tabular-nums'>{lists.totals[entry.tab]}</span></TabsTrigger>)}
      </TabsList>
    </Tabs>
    <ScrollArea className='min-h-0 flex-1'>
      {shows === 'pending' ? <ListPending className='p-2' />
        : shows === 'failed' ? <ListLoadError message={t('spaces.webAnimation.listError')} onRetry={retry} />
          : empty ? <p className='p-6 text-center text-xs text-muted-foreground'>{t(emptyKey)}</p>
            : <>
              <ListBlock query={current.own} tab={tab} selectedId={selectedId} markedId={markedId} onPick={onPick} {...actions} />
              {rowsOf(current.legacy).length > 0 && <section data-testid='motion-legacy-group'>
                <h4 className='bg-muted px-3 py-1.5 text-2xs font-medium text-muted-foreground'>{t('spaces.webAnimation.madeInTimeline')}</h4>
                <ListBlock query={current.legacy} tab={tab} selectedId={selectedId} markedId={markedId} onPick={onPick} {...actions} />
              </section>}
            </>}
    </ScrollArea>
  </MotionPanel>;
});
