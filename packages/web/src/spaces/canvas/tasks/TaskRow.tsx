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
import { getLocale, type NodeTaskEntry } from '@breatic/shared';

import { Button } from '@web/components/ui/button';
import { failureSentence } from '@web/spaces/canvas/failure-sentence';
import { useCollaboratorNames } from '@web/features/collab-editor/collaborator-names-context';
import { useTranslation } from '@web/i18n/use-translation';
import { TaskStatusDot } from '@web/spaces/canvas/tasks/TaskStatusDot';
import { formatDuration } from '@web/spaces/canvas/lib/duration';
import {
  elapsedMs,
  remainingMs,
} from '@web/spaces/canvas/tasks/task-timing';
import type { TaskRowAction } from '@web/spaces/canvas/tasks/task-row-actions';
import { taskRowActions } from '@web/spaces/canvas/tasks/task-row-actions';
import { taskRowTitle } from '@web/spaces/canvas/tasks/task-row-title';

/**
 * Used when no catalog is at hand: every model shows as its id.
 * @returns Never a name.
 */
const NO_NAMES = (): null => null;

/**
 * The actions that lead somewhere. The rest end the row.
 */
const PRIMARY_ACTIONS: ReadonlySet<TaskRowAction> = new Set(['view', 'retry']);

/** i18n key per button. */
const ACTION_KEY: Readonly<Record<TaskRowAction, string>> = {
  view: 'canvas.task.action.view',
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
  /**
   * What the host node holds, when it holds one of the three media.
   *
   * Read by the refusal sentence, which names the formats we would have taken
   * instead — a row refused for its format offers no Retry, so that sentence
   * is the only place left to say what would have worked.
   */
  medium?: 'image' | 'video' | 'audio';
  /** Open the node's history at this task's late result. */
  onView: (taskId: string) => void;
  /** The catalog's name for a model id; without one the id is shown. */
  displayNameOf?: (modelId: string) => string | null;
  /** Send the stashed File again as a new task. */
  onRetry: (taskId: string) => void;
  /** Drop this row, whether it ended well or badly. */
  onDismiss: (taskId: string) => void;
}

/**
 * The sentence under a settled task's name, or null while it runs.
 * @param entry - The task.
 * @param t - The translator.
 * @param medium - What the host node holds, for a refusal's format list.
 * @returns The sentence, or null.
 */
function settledNote(
  entry: NodeTaskEntry,
  t: ReturnType<typeof useTranslation>,
  medium: 'image' | 'video' | 'audio' | undefined,
): string | null {
  if (entry.status === 'failed') {
    return failureSentence(entry.errorMessage, t, medium);
  }
  if (entry.status !== 'expired') return null;
  // §4.5: a report can land after the verdict, and the row has to say so —
  // otherwise the View button beside "ran out of time" reads as a mistake.
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
 * @param props.medium - What the host node holds, for a refusal's format list.
 * @param props.onView - Open the node's history at the late result.
 * @param props.displayNameOf - The catalog's name for a model id.
 * @param props.onRetry - Send the stashed File again.
 * @param props.onDismiss - Drop this row.
 * @returns The row element.
 */
export const TaskRow = React.memo(function TaskRow({
  entry,
  now,
  hasRetryFile,
  readOnly,
  medium,
  onView,
  displayNameOf = NO_NAMES,
  onRetry,
  onDismiss,
}: TaskRowProps): JSX.Element {
  const t = useTranslation();
  const names = useCollaboratorNames();
  // A person who left the project is gone from the roster while their tasks
  // remain, so an unresolved id drops the name and keeps the row.
  const starter = names?.resolve(entry.startedByUserId) ?? null;
  const status = entry.status;

  const actions = taskRowActions({
    status,
    hasResult: entry.content !== null,
    hasRetryFile,
    readOnly,
  });

  const run = React.useCallback(
    (action: TaskRowAction): void => {
      if (action === 'view') onView(entry.id);
      else if (action === 'retry') onRetry(entry.id);
      else onDismiss(entry.id);
    },
    [entry.id, onView, onRetry, onDismiss],
  );
  const title = taskRowTitle(entry, t, displayNameOf);

  const note = settledNote(entry, t, medium);
  // Whichever instant this row has: a running task says when it began, a
  // settled one when it ended. §7.1 asks a running row for both its elapsed
  // time and the moment it started. One slot carrying two different facts
  // needs the word too, or the reader cannot tell which one they are looking
  // at (user 2026-09-06).
  const instant = entry.settledAt ?? entry.startedAt;
  const instantKey =
    entry.settledAt !== null ? 'canvas.task.endedAt' : 'canvas.task.startedAt';

  return (
    // No fill under the pointer: this row's text takes colours measured
    // against the panel's own fill, and `accent` is a step closer to each of
    // them than that — the failure sentence lands at 4.10:1 in light and the
    // timing lines at 4.46:1 in dark, both under the 4.5:1 every line here is
    // small enough to need (WCAG 2.2 SC 1.4.3). The tint reveals nothing:
    // every row's buttons are drawn already, and each carries its own hover.
    <div
      data-testid='node-task-row'
      className='flex flex-col gap-1.5 rounded-content-sm px-1.5 py-2'
    >
      <div className='flex items-center gap-2'>
        <TaskStatusDot status={status} />
        {/* What the task was doing, at the weight of context. What the reader
            came for is the sentence below, so this sits between it and the
            timing. */}
        <span
          data-testid='task-title'
          className='min-w-0 flex-1 truncate text-2xs text-foreground-secondary'
        >
          {title}
        </span>
        {starter !== null ? (
          <span className='shrink-0 text-2xs text-muted-foreground'>
            {starter}
          </span>
        ) : null}
      </div>

      {entry.status === 'running' ? (
        <div className='flex items-center gap-3 pl-5 text-2xs tabular-nums text-muted-foreground'>
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
          // The one line a settled row exists to deliver: why it ended that
          // way. It outranks the filename above, which only says which of the
          // listed files this row is about.
          className={
            'pl-5 text-sm font-medium ' +
            (entry.status === 'failed'
              ? 'text-status-error-foreground'
              : 'text-muted-foreground')
          }
        >
          {note}
        </span>
      ) : null}

      <div className='flex items-center gap-2 pl-5'>
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
            // Filling the one that puts a result on the node separates it from
            // the one that throws the row away: side by side in the same
            // outline they read as a pair of equals, and a list of five rows
            // becomes ten identical pills the reader has to read before acting.
            variant={PRIMARY_ACTIONS.has(action) ? 'default' : 'outline'}
            size='compact'
            data-testid={`task-action-${action}`}
            onClick={(): void => run(action)}
            className='text-2xs'
          >
            {t(ACTION_KEY[action])}
          </Button>
        ))}
      </div>
    </div>
  );
});
