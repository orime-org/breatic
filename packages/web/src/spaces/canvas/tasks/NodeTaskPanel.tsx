// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The list that opens beside a node when one of its counts is clicked
 * (#186 §7.1).
 *
 * It holds one state's rows: the reader asked for the failures, so the
 * successes are not what they are looking at. The rows are fetched from the
 * server rather than read off the shared document — the document carries four
 * numbers and nothing else (§3.3), so the detail behind a number is only
 * pulled when somebody asks for it.
 */

import type { JSX } from 'react';
import * as React from 'react';
import { RotateCw, X } from 'lucide-react';

import { Button } from '@web/components/ui/button';
import { ScrollArea } from '@web/components/ui/scroll-area';
import { Skeleton } from '@web/components/ui/skeleton';
import type { NodeTaskEntry } from '@web/data/api/canvas';
import { useTranslation } from '@web/i18n/use-translation';
import { TaskRow } from '@web/spaces/canvas/tasks/TaskRow';
import type { TaskStatus } from '@web/spaces/canvas/tasks/TaskStatusBadge';

/** What {@link NodeTaskPanel} renders and reports. */
export interface NodeTaskPanelProps {
  /** The state whose count was clicked; only these rows show. */
  status: TaskStatus;
  /** Every live task on the node, as the server last listed them. */
  entries: readonly NodeTaskEntry[];
  /** The reader's clock, ticking once a second while rows are running. */
  now: number;
  /** Whether the list is still being fetched. */
  isLoading: boolean;
  /** Whether the fetch failed. */
  isError: boolean;
  /** Whether this session still holds one task's File. */
  hasRetryFile: (taskId: string) => boolean;
  /** Fetch the list again. */
  onReload: () => void;
  /** Close the list. */
  onClose: () => void;
  /** Write one task's result onto the node. */
  onReplace: (taskId: string) => void;
  /** Send one task's stashed File again. */
  onRetry: (taskId: string) => void;
  /** Drop one row. */
  onDismiss: (taskId: string) => void;
}

/**
 * Render one node's tasks in a single state.
 * @param props - The panel inputs.
 * @param props.status - The state whose count was clicked.
 * @param props.entries - Every live task on the node.
 * @param props.now - The reader's clock.
 * @param props.isLoading - Whether the list is still being fetched.
 * @param props.isError - Whether the fetch failed.
 * @param props.hasRetryFile - Whether this session holds one task's File.
 * @param props.onReload - Fetch the list again.
 * @param props.onClose - Close the list.
 * @param props.onReplace - Write one task's result onto the node.
 * @param props.onRetry - Send one task's stashed File again.
 * @param props.onDismiss - Drop one row.
 * @returns The panel element.
 */
export function NodeTaskPanel({
  status,
  entries,
  now,
  isLoading,
  isError,
  hasRetryFile,
  onReload,
  onClose,
  onReplace,
  onRetry,
  onDismiss,
}: NodeTaskPanelProps): JSX.Element {
  const t = useTranslation();
  const shown = React.useMemo(
    () => entries.filter((task) => task.status === status),
    [entries, status],
  );

  return (
    // `nowheel` and `nodrag` free the panel from ReactFlow's pane gestures the
    // same way the history panel does: the ScrollArea scrolls on wheel, and
    // dragging the panel never moves the node behind it.
    <div className='nowheel nodrag flex w-[min(344px,92vw)] flex-col rounded-overlay border border-border bg-popover text-popover-foreground shadow-md'>
      <div className='flex items-center justify-between px-3 py-2.5'>
        <div className='flex items-baseline gap-2'>
          <span className='text-sm font-semibold'>
            {t('canvas.task.panelTitle')}
          </span>
          <span
            data-testid='node-task-panel-count'
            className='text-2xs tabular-nums text-muted-foreground'
          >
            {shown.length}
          </span>
        </div>
        <Button
          type='button'
          variant={null}
          size={null}
          data-testid='node-task-panel-close'
          aria-label={t('canvas.task.panelClose')}
          onClick={onClose}
          className='flex h-6 w-6 items-center justify-center rounded-content-sm text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring'
        >
          <X className='h-3.5 w-3.5' aria-hidden='true' />
        </Button>
      </div>

      {isLoading ? (
        <div
          data-testid='node-task-panel-loading'
          className='flex flex-col gap-1.5 px-3 pb-3'
          role='status'
          aria-busy='true'
          aria-label={t('canvas.task.panelTitle')}
        >
          {[0, 1].map((i) => (
            <Skeleton key={i} className='h-12 w-full rounded-content-sm' />
          ))}
        </div>
      ) : isError ? (
        <div
          role='alert'
          className='flex flex-col items-start gap-2 px-3 pb-3 text-xs text-muted-foreground'
        >
          <span>{t('canvas.task.panelError')}</span>
          <Button
            type='button'
            variant='outline'
            size='sm'
            data-testid='node-task-panel-reload'
            onClick={onReload}
            className='h-6 gap-1 px-2 text-2xs'
          >
            <RotateCw className='h-3 w-3' aria-hidden='true' />
            {t('canvas.task.panelReload')}
          </Button>
        </div>
      ) : shown.length === 0 ? (
        // The counts and the list are two reads of the same thing taken at two
        // different instants, so a count of one can meet a list of none.
        <div
          data-testid='node-task-panel-empty'
          className='px-3 pb-4 text-xs text-muted-foreground'
        >
          {t('canvas.task.panelEmpty')}
        </div>
      ) : (
        <ScrollArea viewportClassName='max-h-[318px] px-1.5 pb-1.5'>
          <div className='flex flex-col gap-0.5'>
            {shown.map((task) => (
              <TaskRow
                key={task.id}
                entry={task}
                now={now}
                hasRetryFile={hasRetryFile(task.id)}
                onReplace={onReplace}
                onRetry={onRetry}
                onDismiss={onDismiss}
              />
            ))}
          </div>
        </ScrollArea>
      )}
    </div>
  );
}
