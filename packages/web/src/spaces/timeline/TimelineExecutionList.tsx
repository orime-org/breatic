// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

import * as React from 'react';
import { Check, CircleDashed, Code, Dot, LoaderCircle, Plus, RotateCcw, X } from 'lucide-react';
import { formatCredits, getLocale, type TimelineExecutionStatus } from '@breatic/shared';
import { TimelineExecutionInputSchema, type TimelineExecutionInput } from '@breatic/shared/space-content';

import { Button } from '@web/components/ui/button';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@web/components/ui/tabs';
import { Tooltip, TooltipContent, TooltipTrigger } from '@web/components/ui/tooltip';
import type { TimelineExecutionRow } from '@web/data/api/timeline';
import { useTranslation } from '@web/i18n/use-translation';
import { cn } from '@web/lib/utils';
import { useRunning } from '@web/stores/task-actions-in-flight';
import { timelineExecutionUnfinished } from '@web/spaces/timeline/use-timeline-executions';
import { WEB_ANIMATION_ENGINE_NAMES } from '@web/spaces/timeline/TimelineWebAnimationDialog';
import { TimelineWebResultPreview } from '@web/spaces/timeline/TimelineWebResultPreview';

/** The list's two views. */
export type TimelineExecutionView = 'completed' | 'inProgress';

const PHASES = ['writing', 'validating', 'saving'] as const;
// Failure reasons that have a sentence of their own; any other reads as a general failure.
const EXPLAINED_FAILURES: ReadonlySet<string> = new Set(['feature_disabled']);

/**
 * The input an execution froze, when it can be read.
 * @param row - The execution.
 * @returns Its input, or null.
 * @throws {never} Never.
 */
export function timelineExecutionInput(row: Pick<TimelineExecutionRow, 'input'>): TimelineExecutionInput | null {
  const parsed = TimelineExecutionInputSchema.safeParse(row.input);
  return parsed.success ? parsed.data : null;
}

/**
 * The run-once intent of cancelling one execution, which its button reads.
 * @param executionId - The execution.
 * @returns The intent.
 * @throws {never} Never.
 */
export function timelineCancelIntent(executionId: string): string {
  return `timeline-cancel:${executionId}`;
}

/** What one row offers an Editor. */
interface RowActions {
  onCancel: (row: TimelineExecutionRow) => void;
  onAdd: (row: TimelineExecutionRow) => void;
  onRetry: (row: TimelineExecutionRow) => void;
}

/** One row and whether it is open. */
interface ExecutionRowProps extends RowActions { projectId: string; row: TimelineExecutionRow; open: boolean; readOnly: boolean; onToggle: (id: string) => void }

/**
 * Where a step stands: done, running now, or not reached.
 * @param row - The execution.
 * @param index - The step: 0 is saving the request, then the phases.
 * @returns Its mark.
 * @throws {never} Never.
 */
function stepMark(row: TimelineExecutionRow, index: number): 'done' | 'current' | 'pending' {
  if (row.status === 'succeeded') return 'done';
  if (index === 0) return row.status === 'awaiting_landing' ? 'current' : 'done';
  const reached = row.phase === null ? -1 : PHASES.indexOf(row.phase);
  if (index - 1 < reached) return 'done';
  return index - 1 === reached && row.status === 'running' ? 'current' : 'pending';
}

/**
 * The colour a status is told in: a result in the text colour, a failure or expiry in the error colour, the rest muted.
 * @param status - The status.
 * @returns The class.
 * @throws {never} Never.
 */
function statusTone(status: TimelineExecutionStatus): string {
  if (status === 'succeeded') return 'text-foreground';
  return status === 'failed' || status === 'expired' ? 'text-status-error-foreground' : 'text-muted-foreground';
}

/**
 * One execution: a summary that opens to its steps, usage and the actions its status allows.
 * @param props - The row and its actions.
 * @param props.projectId - The Project, for its result's preview.
 * @param props.row - The execution.
 * @param props.open - Whether its details show.
 * @param props.readOnly - Whether the user may act on it.
 * @param props.onToggle - Opens or closes it.
 * @param props.onCancel - Cancels it.
 * @param props.onAdd - Adds its result, or a placeholder while it runs, at the playhead.
 * @param props.onRetry - Opens a prefilled dialog for a new run.
 * @returns The row.
 * @throws {never} Never.
 */
const ExecutionRow = React.memo(function ExecutionRow({ projectId, row, open, readOnly, onToggle, onCancel, onAdd, onRetry }: ExecutionRowProps): React.JSX.Element {
  const t = useTranslation();
  const input = timelineExecutionInput(row);
  const unfinished = timelineExecutionUnfinished(row.status);
  const cancelling = useRunning(timelineCancelIntent(row.id)) !== undefined;
  const toggle = React.useCallback((): void => onToggle(row.id), [onToggle, row.id]);
  const cancel = React.useCallback((): void => onCancel(row), [onCancel, row]);
  const add = React.useCallback((): void => onAdd(row), [onAdd, row]);
  const retry = React.useCallback((): void => onRetry(row), [onRetry, row]);
  const status = t(`timeline.webAnimation.status.${row.status}`);
  const phase = row.status === 'running' && row.phase !== null ? t(`timeline.webAnimation.phase.${row.phase}`) : null;
  const created = new Date(row.createdAt).toLocaleTimeString(getLocale(), { hour: '2-digit', minute: '2-digit' });
  const summary = input === null ? created
    : `${WEB_ANIMATION_ENGINE_NAMES[input.engine]} · ${input.aspect} · ${t('timeline.material.duration', { seconds: input.durationSeconds })} · ${created}`;
  const steps = ['timeline.webAnimation.step.landing', ...PHASES.map((item) => `timeline.webAnimation.phase.${item}`)];
  return <li data-testid={`timeline-execution-${row.id}`} data-status={row.status} className='border-b border-border last:border-b-0'>
    <Button data-testid={`timeline-execution-toggle-${row.id}`} type='button' variant={null} size={null} aria-expanded={open} onClick={toggle}
      className='flex w-full min-w-0 items-start gap-2 px-3 py-2.5 text-left text-xs hover-enabled:bg-accent'>
      <Code className='mt-0.5 size-4 shrink-0 text-[color:var(--color-palette-violet)]' />
      <span className='flex min-w-0 flex-1 flex-col gap-0.5'>
        <span className='truncate text-sm font-medium leading-normal'>{input?.prompt ?? t('timeline.webAnimation.copy')}</span>
        <span className='truncate text-muted-foreground'>{summary}</span>
      </span>
      <span className={cn('flex shrink-0 items-center gap-1 whitespace-nowrap', statusTone(row.status))}>
        {unfinished && <CircleDashed className='size-3.5' />}
        {phase === null ? status : `${status} · ${phase}`}
      </span>
    </Button>
    {open && <div data-testid={`timeline-execution-detail-${row.id}`} className='flex flex-col gap-3 px-3 pb-3 text-xs'>
      <ol className='flex flex-col gap-1'>
        {steps.map((key, index) => {
          const mark = stepMark(row, index);
          return <li key={key} className={cn('flex items-center gap-2', mark === 'pending' && 'text-muted-foreground')}>
            {mark === 'done' ? <Check className='size-3.5 shrink-0' /> : mark === 'current' ? <LoaderCircle className='size-3.5 shrink-0 animate-spin' /> : <Dot className='size-3.5 shrink-0' />}
            {t(key)}
          </li>;
        })}
      </ol>
      {row.status === 'failed' && <p className='text-status-error-foreground'>
        {t(row.failureReason !== null && EXPLAINED_FAILURES.has(row.failureReason) ? `timeline.webAnimation.failure.${row.failureReason}` : 'timeline.webAnimation.failure.unknown')}
      </p>}
      <dl className='grid grid-cols-[auto_1fr] gap-x-3 gap-y-1'>
        <dt className='text-muted-foreground'>{t('timeline.webAnimation.dialog.prompt')}</dt>
        <dd className='min-w-0 break-words'>{input?.prompt ?? ''}</dd>
        <dd className='col-span-2 text-muted-foreground'>
          {unfinished ? t('timeline.webAnimation.usagePending') : t('timeline.webAnimation.usage', { credits: formatCredits(row.usageCredits, getLocale()) })}
        </dd>
      </dl>
      {row.status === 'succeeded' && row.resultSourceVersionId !== null && input !== null
        && <TimelineWebResultPreview projectId={projectId} executionId={row.id} sourceVersionId={row.resultSourceVersionId} input={input} />}
      {!readOnly && <div className='flex flex-wrap gap-2'>
        {unfinished && row.status !== 'cancelling' && <Button data-testid={`timeline-execution-cancel-${row.id}`} variant='outline' size='sm' loading={cancelling} onClick={cancel}
          icon={<X className='size-4' />}>{t('timeline.webAnimation.cancel')}</Button>}
        {(row.status === 'queued' || row.status === 'running') && <Button data-testid={`timeline-execution-add-placeholder-${row.id}`} variant='outline' size='sm' onClick={add}
          icon={<Plus className='size-4' />}>{t('timeline.webAnimation.addPlaceholder')}</Button>}
        {row.status === 'succeeded' && row.resultSourceVersionId !== null && <Button data-testid={`timeline-execution-add-${row.id}`} size='sm' onClick={add}
          icon={<Plus className='size-4' />}>{t('timeline.webAnimation.addToTimeline')}</Button>}
        {(row.status === 'failed' || row.status === 'cancelled' || row.status === 'expired') && <Button data-testid={`timeline-execution-retry-${row.id}`} variant='outline' size='sm' onClick={retry}
          icon={<RotateCcw className='size-4' />}>{t('timeline.webAnimation.retry')}</Button>}
      </div>}
    </div>}
  </li>;
});

/** The execution list panel. */
interface TimelineExecutionListProps extends RowActions {
  projectId: string;
  rows: readonly TimelineExecutionRow[] | undefined;
  view: TimelineExecutionView;
  openId: string | null;
  readOnly: boolean;
  onView: (view: TimelineExecutionView) => void;
  onToggle: (id: string) => void;
  onClose: () => void;
}

/**
 * One Timeline Space's executions in two views, Completed and In Progress (inner#1711 design §8). Viewers read rows
 * and details; only an Editor sees the actions.
 * @param props - The rows, the view and the actions.
 * @param props.projectId - The Project.
 * @param props.rows - The executions, newest first, once read.
 * @param props.view - The view shown.
 * @param props.openId - The row whose details show.
 * @param props.readOnly - Whether the user may act.
 * @param props.onView - Switches the view.
 * @param props.onToggle - Opens or closes a row.
 * @param props.onClose - Closes the list.
 * @param props.onCancel - Cancels an execution.
 * @param props.onAdd - Adds a result, or a placeholder while it runs, at the playhead.
 * @param props.onRetry - Opens a prefilled dialog for a new run.
 * @returns The list.
 * @throws {never} Never.
 */
export function TimelineExecutionList({ projectId, rows, view, openId, readOnly, onView, onToggle, onClose, onCancel, onAdd, onRetry }: TimelineExecutionListProps): React.JSX.Element {
  const t = useTranslation();
  const changeView = React.useCallback((value: string): void => onView(value === 'completed' ? 'completed' : 'inProgress'), [onView]);
  const inProgress = React.useMemo(() => (rows ?? []).filter((row) => timelineExecutionUnfinished(row.status)), [rows]);
  const completed = React.useMemo(() => (rows ?? []).filter((row) => !timelineExecutionUnfinished(row.status)), [rows]);
  /**
   * One view's rows, or its empty state once the list is read.
   * @param list - The rows.
   * @param empty - The empty state's key.
   * @returns The rows.
   * @throws {never} Never.
   */
  const body = (list: readonly TimelineExecutionRow[], empty: string): React.JSX.Element | null => {
    if (rows === undefined) return null;
    if (list.length === 0) return <p className='px-3 py-6 text-center text-xs text-muted-foreground'>{t(empty)}</p>;
    return <ul>{list.map((row) => <ExecutionRow key={row.id} projectId={projectId} row={row} open={openId === row.id} readOnly={readOnly} onToggle={onToggle} onCancel={onCancel} onAdd={onAdd} onRetry={onRetry} />)}</ul>;
  };
  return <section data-testid='timeline-executions' className='flex flex-col rounded-chrome border border-border'>
    <header className='flex items-center justify-between gap-2 border-b border-border px-3 py-2'>
      <h3 className='text-sm font-semibold'>{t('timeline.webAnimation.executions')}</h3>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button data-testid='timeline-close-executions' variant='ghost' size='compact' className='px-1' aria-label={t('timeline.webAnimation.list.close')} onClick={onClose} icon={<X className='size-4' />} />
        </TooltipTrigger>
        <TooltipContent>{t('timeline.webAnimation.list.close')}</TooltipContent>
      </Tooltip>
    </header>
    <Tabs value={view} onValueChange={changeView} className='flex flex-col'>
      <TabsList className='m-2'>
        <TabsTrigger value='completed'>{t('timeline.webAnimation.list.completed')}<span className='tabular-nums'>{completed.length}</span></TabsTrigger>
        <TabsTrigger value='inProgress'>{t('timeline.webAnimation.list.inProgress')}<span className='tabular-nums'>{inProgress.length}</span></TabsTrigger>
      </TabsList>
      <TabsContent value='completed'>{body(completed, 'timeline.webAnimation.list.emptyCompleted')}</TabsContent>
      <TabsContent value='inProgress'>{body(inProgress, 'timeline.webAnimation.list.emptyInProgress')}</TabsContent>
    </Tabs>
  </section>;
}
