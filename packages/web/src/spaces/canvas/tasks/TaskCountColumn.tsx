// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * The counts outside a node's top-right corner (#186 §7.1).
 *
 * They are the whole of what the shared document says about this node's
 * tasks: its counts (running, and how many of those wait for a free running
 * slot, then the three ways a task ends), no entries, no ids. The rows behind a number are
 * fetched only when the user asks for them by clicking it.
 *
 * A state this node has nothing in draws nothing, and a node with no task at
 * all draws no column: zero is not a value this column renders, it is the
 * absence of that count (user 2026-09-06). Most nodes on a canvas have never
 * been uploaded to, and a column of dimmed zeroes on each of them is the loudest
 * thing on the board while saying nothing. The counts that are there keep
 * their lifecycle order, so the column reads the same way every time.
 *
 * `endedShown` is the second half of what gets drawn: the three ways a task
 * can end may give up their cells when the canvas has taken them below the
 * size a target may be, and the running and waiting ones keep their cells at every zoom
 * (user 2026-09-13). Reading a board zoomed out is when "this node is working
 * right now" matters most, and those two are what is still happening.
 */

import type { JSX } from 'react';
import React from 'react';
import type { NodeTaskCounts } from '@breatic/shared';

import { Button } from '@web/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@web/components/ui/tooltip';
import { cn } from '@web/lib/utils';
import { useTranslation } from '@web/i18n/use-translation';
import { waitReason } from '@web/spaces/canvas/tasks/wait-reason';
import { TASK_COUNT_CELLS } from '@web/spaces/canvas/overlay-scale';
import { countInList } from '@web/spaces/canvas/tasks/NodeTaskPanel';
import { TASK_LABEL_KEY, TASK_SHAPE, TASK_TONE, type TaskListKind } from '@web/spaces/canvas/tasks/TaskStatusDot';

/** The open cell's border, so which list is showing reads without the fill. */
const OPEN_BORDER: Readonly<Record<TaskListKind, string>> = {
  running: 'border-status-info-foreground',
  waiting: 'border-active-border',
  done: 'border-status-success-foreground',
  failed: 'border-status-error-foreground',
  expired: 'border-status-warning-foreground',
};

/** What {@link TaskCountColumn} renders and reports. */
export interface TaskCountColumnProps {
  /** The node's counts, straight off the shared document. */
  counts: NodeTaskCounts;
  /**
   * Whether the three ways a task can end are drawn. The running one is drawn
   * either way.
   */
  endedShown: boolean;
  /** Which state's list is open right now, `null` when none is. */
  openFor: TaskListKind | null;
  /** Ask for one state's list, or `null` to close the open one. */
  onOpen: (status: TaskListKind | null) => void;
}

/**
 * One count: a number, its colour, and whether its list is open.
 * @param props - The count's inputs.
 * @param props.status - Which state this number counts.
 * @param props.value - How many tasks are in it.
 * @param props.isOpen - Whether this state's list is the open one.
 * @param props.onOpen - Called with the state to open, or `null` to close.
 * @param props.waitingLimit - The waiting cell's running-task limit, when the counts carry it.
 * @returns The count button.
 */
function TaskCount({
  status,
  value,
  isOpen,
  onOpen,
  waitingLimit,
}: {
  status: TaskListKind;
  value: number;
  isOpen: boolean;
  onOpen: (status: TaskListKind | null) => void;
  waitingLimit?: number;
}): JSX.Element {
  const t = useTranslation();
  const Mark = TASK_SHAPE[status];
  const handleClick = React.useCallback(() => {
    onOpen(isOpen ? null : status);
  }, [isOpen, onOpen, status]);

  // The state's name and how many are in it: the icon alone says nothing to a
  // user meeting it for the first time, and it is where the number the cell
  // used to print now lives (user 2026-09-06).
  const tip = t('canvas.task.countTip', {
    status: t(TASK_LABEL_KEY[status]),
    count: value,
  });

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          variant='outline'
          size={null}
          type='button'
          data-testid={`task-count-${status}`}
          aria-pressed={isOpen}
          aria-label={tip}
          onClick={handleClick}
          className={cn(
            'flex items-center justify-center rounded-chrome p-1.5',
            // The open cell keeps the fill its neighbours have, and the coloured
            // rim is what says it is open: a darker fill made the cell the
            // user had picked read as the least present of the column. The base
            // fill is repeated under `hover-enabled:` so this one does not take
            // the variant's `hover-enabled:bg-accent` like any other cell — the
            // two share a modifier, so the merge keeps only this one.
            isOpen && cn(OPEN_BORDER[status], 'hover-enabled:bg-background'),
          )}
        >
          <Mark
            aria-hidden='true'
            className={cn('size-3 flex-none', TASK_TONE[status], status === 'running' && 'animate-spin')}
          />
        </Button>
      </TooltipTrigger>
      <TooltipContent side='right'>
        {tip}
        {status === 'waiting' ? <span className='block'>{waitReason(t, waitingLimit, 'each')}</span> : null}
      </TooltipContent>
    </Tooltip>
  );
}

const TaskCountMemo = React.memo(TaskCount);

/**
 * Render the states this node has tasks in as a column of buttons.
 * @param props - The column inputs.
 * @param props.counts - The counts from the shared document.
 * @param props.endedShown - Whether the three ended states are drawn.
 * @param props.openFor - Which state's list is open, `null` when none is.
 * @param props.onOpen - Called with the state to open, or `null` to close.
 * @returns The column element, or null when this node has nothing to draw.
 */
export function TaskCountColumn({ counts, endedShown, openFor, onOpen }: TaskCountColumnProps): JSX.Element | null {
  /**
   * How many tasks one cell counts.
   * @param cell - The cell.
   * @returns Its count.
   */
  const value = (cell: TaskListKind): number => countInList(counts, cell);
  const shown = TASK_COUNT_CELLS.filter(
    (cell) => value(cell) > 0 && (endedShown || cell === 'running' || cell === 'waiting'),
  );
  if (shown.length === 0) return null;

  return (
    <div className='flex flex-col gap-1' data-testid='node-task-counts'>
      {shown.map((cell) => (
        <TaskCountMemo
          key={cell}
          status={cell}
          value={value(cell)}
          isOpen={openFor === cell}
          onOpen={onOpen}
          {...(cell === 'waiting' && counts.waitingLimit !== undefined && { waitingLimit: counts.waitingLimit })}
        />
      ))}
    </div>
  );
}
