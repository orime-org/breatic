// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The counts outside a node's top-right corner (#186 §7.1).
 *
 * They are the whole of what the shared document says about this node's
 * tasks: four numbers, no entries, no ids. The rows behind a number are
 * fetched only when the reader asks for them by clicking it.
 *
 * A state this node has nothing in draws nothing, and a node with no task at
 * all draws no column: zero is not a value this column renders, it is the
 * absence of that count (user 2026-09-06). Most nodes on a canvas have never
 * been uploaded to, and four dimmed zeroes on each of them is the loudest
 * thing on the board while saying nothing. The counts that are there keep
 * their lifecycle order, so the column reads the same way every time.
 */

import type { JSX } from 'react';
import React from 'react';
import { CircleCheck, CircleX, Clock, Loader2 } from 'lucide-react';
import type { NodeTaskCounts } from '@breatic/shared';

import { Button } from '@web/components/ui/button';
import { cn } from '@web/lib/utils';
import { useTranslation } from '@web/i18n/use-translation';
import type { TaskStatus } from '@web/spaces/canvas/tasks/TaskStatusDot';

/**
 * Top to bottom, and the colour each one carries. The order is the task's own
 * lifecycle: what is happening now, then the three ways it can end.
 */
const ORDER: readonly TaskStatus[] = ['running', 'done', 'failed', 'expired'];

/**
 * The mark's colour per state. The state rides on the mark rather than on the
 * number: light theme measures these four against the cell's fills at 3.4 to
 * 4.6, under the 4.5 an 11px number needs (WCAG 1.4.3), while a graphic
 * clears its own 3:1 floor at every one of them. So the mark says which state
 * and the number, in the foreground colour, says how many (user 2026-09-06).
 */
const MARK_TONE: Readonly<Record<TaskStatus, string>> = {
  running: 'text-status-info-foreground',
  done: 'text-status-success-foreground',
  failed: 'text-status-error-foreground',
  expired: 'text-status-warning-foreground',
};

/**
 * The mark's shape per state, the same four the rows use. Two of the colours
 * read as one thing at this size, so shape is what separates them
 * (see `TaskStatusDot`).
 */
const MARK_SHAPE: Readonly<Record<TaskStatus, typeof Clock>> = {
  running: Loader2,
  done: CircleCheck,
  failed: CircleX,
  expired: Clock,
};

/** The open cell's border, so which list is showing reads without the fill. */
const OPEN_BORDER: Readonly<Record<TaskStatus, string>> = {
  running: 'border-status-info-foreground',
  done: 'border-status-success-foreground',
  failed: 'border-status-error-foreground',
  expired: 'border-status-warning-foreground',
};

/** i18n key for the button's accessible name, one per state. */
const LABEL_KEY: Readonly<Record<TaskStatus, string>> = {
  running: 'canvas.task.status.running',
  done: 'canvas.task.status.done',
  failed: 'canvas.task.status.failed',
  expired: 'canvas.task.status.expired',
};

/** What {@link TaskCountColumn} renders and reports. */
export interface TaskCountColumnProps {
  /** The node's four numbers, straight off the shared document. */
  counts: NodeTaskCounts;
  /** Which state's list is open right now, `null` when none is. */
  openFor: TaskStatus | null;
  /** Ask for one state's list, or `null` to close the open one. */
  onOpen: (status: TaskStatus | null) => void;
}

/**
 * One count: a number, its colour, and whether its list is open.
 * @param props - The count's inputs.
 * @param props.status - Which state this number counts.
 * @param props.value - How many tasks are in it.
 * @param props.isOpen - Whether this state's list is the open one.
 * @param props.onOpen - Called with the state to open, or `null` to close.
 * @returns The count button.
 */
function TaskCount({
  status,
  value,
  isOpen,
  onOpen,
}: {
  status: TaskStatus;
  value: number;
  isOpen: boolean;
  onOpen: (status: TaskStatus | null) => void;
}): JSX.Element {
  const t = useTranslation();
  const Mark = MARK_SHAPE[status];
  const handleClick = React.useCallback(() => {
    onOpen(isOpen ? null : status);
  }, [isOpen, onOpen, status]);

  return (
    <Button
      variant={null}
      size={null}
      type='button'
      data-testid={`task-count-${status}`}
      aria-pressed={isOpen}
      aria-label={t(LABEL_KEY[status])}
      onClick={handleClick}
      className={cn(
        // The shape the shared `outline` variant draws, minus its hover text
        // colour, which this cell has no use for.
        'flex min-w-11 items-center justify-center gap-1.5 rounded-chrome border border-border bg-background px-2 py-1 text-2xs font-medium tabular-nums hover:bg-accent',
        // The open cell repeats its own fill on hover. Both rules survive the
        // merge — different modifier groups — and the hovered one wins on
        // specificity, so without this the open cell repaints as any hovered
        // neighbour does and loses half of what says it is open.
        isOpen && cn(OPEN_BORDER[status], 'bg-muted hover:bg-muted'),
      )}
    >
      <Mark
        aria-hidden='true'
        className={cn(
          'size-3 flex-none',
          MARK_TONE[status],
          status === 'running' && 'animate-spin',
        )}
      />
      {value}
    </Button>
  );
}

const TaskCountMemo = React.memo(TaskCount);

/**
 * Render the states this node has tasks in as a column of buttons.
 * @param props - The column inputs.
 * @param props.counts - The four numbers from the shared document.
 * @param props.openFor - Which state's list is open, `null` when none is.
 * @param props.onOpen - Called with the state to open, or `null` to close.
 * @returns The column element, or null when this node carries no task.
 */
export function TaskCountColumn({
  counts,
  openFor,
  onOpen,
}: TaskCountColumnProps): JSX.Element | null {
  const shown = ORDER.filter((status) => counts[status] > 0);
  if (shown.length === 0) return null;

  return (
    <div className='flex flex-col gap-1' data-testid='node-task-counts'>
      {shown.map((status) => (
        <TaskCountMemo
          key={status}
          status={status}
          value={counts[status]}
          isOpen={openFor === status}
          onOpen={onOpen}
        />
      ))}
    </div>
  );
}
