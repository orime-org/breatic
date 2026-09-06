// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * One row of a node's task list (#186 §7.1).
 *
 * What the row says comes from the state the task is in; what it offers comes
 * from {@link taskRowActions}. Neither the clock nor the retry stash is read
 * here — both arrive as props, so every combination renders without a canvas
 * around it.
 */

import type { JSX } from 'react';
import * as React from 'react';
import { getLocale } from '@breatic/shared';

import { Button } from '@web/components/ui/button';
import { asTaskFailureReason } from '@breatic/shared';
import type { NodeTaskEntry } from '@web/data/api/canvas';
import { useCollaboratorNames } from '@web/features/collab-editor/collaborator-names-context';
import { useTranslation } from '@web/i18n/use-translation';
import type { TaskStatus } from '@web/spaces/canvas/tasks/TaskStatusDot';
import { TaskStatusDot } from '@web/spaces/canvas/tasks/TaskStatusDot';
import {
  elapsedMs,
  formatDuration,
  remainingMs,
} from '@web/spaces/canvas/tasks/task-timing';
import type { TaskRowAction } from '@web/spaces/canvas/tasks/task-row-actions';
import { taskRowActions } from '@web/spaces/canvas/tasks/task-row-actions';

/** i18n key per button. */
const ACTION_KEY: Readonly<Record<TaskRowAction, string>> = {
  replace: 'canvas.task.action.replace',
  retry: 'canvas.task.action.retry',
  finish: 'canvas.task.action.finish',
  clear: 'canvas.task.action.clear',
};

/** What {@link TaskRow} renders and reports. */
export interface TaskRowProps {
  /** The task, as the server last described it. */
  entry: NodeTaskEntry;
  /** The reader's clock, ticking in the panel above. */
  now: number;
  /** Whether this session still holds the File this upload was carrying. */
  hasRetryFile: boolean;
  /** Whether this reader may write; a read-only row carries no buttons. */
  readOnly: boolean;
  /** Write this task's result onto the node. */
  onReplace: (taskId: string) => void;
  /** Send the stashed File again as a new task. */
  onRetry: (taskId: string) => void;
  /** Drop this row, whether it ended well or badly. */
  onDismiss: (taskId: string) => void;
}

/**
 * The sentence under a settled task's name, or null while it runs.
 * @param entry - The task.
 * @param t - The translator.
 * @returns The sentence, or null.
 */
function settledNote(
  entry: NodeTaskEntry,
  t: ReturnType<typeof useTranslation>,
): string | null {
  if (entry.status === 'failed') {
    // A cause this product knows travels as a code and becomes a sentence
    // here, where the reader's language is. Anything else is what some
    // provider said about its own failure, and it travels as itself.
    const reason = asTaskFailureReason(entry.errorMessage);
    return reason !== null
      ? t(`canvas.task.failure.${reason}`)
      : entry.errorMessage;
  }
  if (entry.status !== 'expired') return null;
  // §4.5: a report can land after the verdict, and the row has to say so —
  // otherwise the Replace button beside "ran out of time" reads as a mistake.
  return entry.content !== null
    ? t('canvas.task.lateResult')
    : t('canvas.task.expired');
}

/**
 * Render one task as a row: its state, name, who started it, its timing, and
 * the buttons its state allows.
 * @param props - The row inputs.
 * @param props.entry - The task, as the server last described it.
 * @param props.now - The reader's clock.
 * @param props.hasRetryFile - Whether this session holds the File.
 * @param props.readOnly - Whether this reader may write.
 * @param props.onReplace - Write the result onto the node.
 * @param props.onRetry - Send the stashed File again.
 * @param props.onDismiss - Drop this row.
 * @returns The row element.
 */
export const TaskRow = React.memo(function TaskRow({
  entry,
  now,
  hasRetryFile,
  readOnly,
  onReplace,
  onRetry,
  onDismiss,
}: TaskRowProps): JSX.Element {
  const t = useTranslation();
  const names = useCollaboratorNames();
  // A person who left the project is gone from the roster while their tasks
  // remain, so an unresolved id drops the name and keeps the row.
  const starter = names?.resolve(entry.startedByUserId) ?? null;
  const status = entry.status as TaskStatus;

  const actions = taskRowActions({
    status,
    hasResult: entry.content !== null,
    hasRetryFile,
    readOnly,
  });

  const run = React.useCallback(
    (action: TaskRowAction): void => {
      if (action === 'replace') onReplace(entry.id);
      else if (action === 'retry') onRetry(entry.id);
      else onDismiss(entry.id);
    },
    [entry.id, onReplace, onRetry, onDismiss],
  );

  const note = settledNote(entry, t);
  // Whichever instant this row has: a running task says when it began, a
  // settled one when it ended. §7.1 asks a running row for both its elapsed
  // time and the moment it started. One slot carrying two different facts
  // needs the word too, or the reader cannot tell which one they are looking
  // at (user 2026-09-06).
  const instant = entry.settledAt ?? entry.startedAt;
  const instantKey =
    entry.settledAt !== null ? 'canvas.task.endedAt' : 'canvas.task.startedAt';

  return (
    <div
      data-testid='node-task-row'
      className='flex flex-col gap-1.5 rounded-content-sm px-2 py-2 hover:bg-accent'
    >
      <div className='flex items-center gap-2'>
        <TaskStatusDot status={status} />
        <span className='min-w-0 flex-1 truncate text-xs font-medium'>
          {entry.label}
        </span>
        {starter !== null ? (
          <span className='shrink-0 text-2xs text-muted-foreground'>
            {starter}
          </span>
        ) : null}
      </div>

      {entry.status === 'running' ? (
        <div className='flex items-center gap-3 text-2xs tabular-nums text-muted-foreground'>
          <span data-testid='task-elapsed'>
            {t('canvas.task.elapsed', {
              duration: formatDuration(elapsedMs(entry.startedAt, now)),
            })}
          </span>
          <span data-testid='task-remaining'>
            {t('canvas.task.remaining', {
              duration: formatDuration(
                remainingMs(entry.startedAt, entry.budgetMs, now),
              ),
            })}
          </span>
        </div>
      ) : null}

      {note !== null && note !== '' ? (
        <span
          className={
            'text-2xs leading-relaxed ' +
            (entry.status === 'failed'
              ? 'text-status-error-foreground'
              : 'text-muted-foreground')
          }
        >
          {note}
        </span>
      ) : null}

      <div className='flex items-center gap-2'>
        {instant !== null ? (
          <span
            data-testid='task-instant'
            className='flex-1 text-2xs tabular-nums text-muted-foreground'
          >
            {t(instantKey, {
              when: new Date(instant).toLocaleString(getLocale(), {
                month: 'short',
                day: 'numeric',
                hour: '2-digit',
                minute: '2-digit',
              }),
            })}
          </span>
        ) : null}
        {actions.map((action) => (
          <Button
            key={action}
            type='button'
            variant='outline'
            size='sm'
            data-testid={`task-action-${action}`}
            onClick={(): void => run(action)}
            className='h-6 px-2 text-2xs'
          >
            {t(ACTION_KEY[action])}
          </Button>
        ))}
      </div>
    </div>
  );
});
