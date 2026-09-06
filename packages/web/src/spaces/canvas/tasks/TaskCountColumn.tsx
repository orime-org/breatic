// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The four counts outside a node's top-right corner (#186 §7.1).
 *
 * They are the whole of what the shared document says about this node's
 * tasks: four numbers, no entries, no ids. The rows behind a number are
 * fetched only when the reader asks for them by clicking it.
 *
 * The column is always there, whatever the numbers are, so a node does not
 * change size the moment its first task opens.
 */

import type { JSX } from 'react';
import React from 'react';
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

/** Text colour per state, from the same families the badge uses. */
const TONE: Readonly<Record<TaskStatus, string>> = {
  running: 'text-status-info-foreground',
  done: 'text-status-success-foreground',
  failed: 'text-status-error-foreground',
  expired: 'text-status-warning-foreground',
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
      // A state with nothing in it opens a list that says no more than the
      // zero beside it already does.
      disabled={value === 0}
      onClick={handleClick}
      className={cn(
        'flex min-w-11 items-center justify-center gap-1.5 rounded-chrome border border-border bg-background px-2 py-1 text-2xs font-medium tabular-nums',
        TONE[status],
        value === 0 && 'opacity-40',
        isOpen && 'border-current bg-muted',
      )}
    >
      <span aria-hidden='true' className='size-1.5 rounded-full bg-current' />
      {value}
    </Button>
  );
}

const TaskCountMemo = React.memo(TaskCount);

/**
 * Render the node's four task counts as a column of buttons.
 * @param props - The column inputs.
 * @param props.counts - The four numbers from the shared document.
 * @param props.openFor - Which state's list is open, `null` when none is.
 * @param props.onOpen - Called with the state to open, or `null` to close.
 * @returns The column element.
 */
export function TaskCountColumn({
  counts,
  openFor,
  onOpen,
}: TaskCountColumnProps): JSX.Element {
  return (
    <div className='flex flex-col gap-1' data-testid='node-task-counts'>
      {ORDER.map((status) => (
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
