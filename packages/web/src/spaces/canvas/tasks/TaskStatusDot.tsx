// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The dot marking which of the four states a task row is in (#186).
 *
 * The panel shows one state at a time and names it in its own heading, so
 * every row under that heading is in it. Spelling the word out again on each
 * row made the loudest thing in the panel the one thing all its rows agree
 * on, while the filename — the only thing telling them apart — came second
 * (user 2026-09-06).
 *
 * The word stays in the accessible tree so a reader who lands on a row rather
 * than on the heading still hears the state, which is also what keeps the
 * colour from being the only thing carrying it (WCAG 1.4.1).
 *
 * It lives here rather than in `components/ui/` because the twelve places
 * this product shows a state colour are different things on screen — a ring
 * around a canvas node, a red line in the history panel, a dot on the
 * notification bell. They share colour tokens, not a shape, so there is
 * nothing for a shared primitive to hold (user 2026-09-03).
 */

import type { JSX } from 'react';

import { cn } from '@web/lib/utils';
import { useTranslation } from '@web/i18n/use-translation';

/** The four states a node task can be in. */
export type TaskStatus = 'running' | 'done' | 'failed' | 'expired';

/** Semantic colour per state; the dot is painted from the text colour. */
const TONE: Readonly<Record<TaskStatus, string>> = {
  running: 'text-status-info-foreground',
  done: 'text-status-success-foreground',
  failed: 'text-status-error-foreground',
  expired: 'text-status-warning-foreground',
};

/** i18n key per state. */
const LABEL_KEY: Readonly<Record<TaskStatus, string>> = {
  running: 'canvas.task.status.running',
  done: 'canvas.task.status.done',
  failed: 'canvas.task.status.failed',
  expired: 'canvas.task.status.expired',
};

/** What {@link TaskStatusDot} renders. */
export interface TaskStatusDotProps {
  status: TaskStatus;
}

/**
 * Render one task's state as a coloured dot carrying its name for readers.
 *
 * Every state draws the same box, so a row settling does not move the
 * filename beside it. 8px is what this repo gives a dot that carries state;
 * at 6px two of the four colours were not tellable apart (user 2026-09-06).
 * @param props - The dot inputs.
 * @param props.status - Which state this task is in.
 * @returns The dot element.
 */
export function TaskStatusDot({ status }: TaskStatusDotProps): JSX.Element {
  const t = useTranslation();
  return (
    <span
      data-testid='task-status-dot'
      className={cn(
        'relative size-2 flex-none rounded-full bg-current',
        TONE[status],
      )}
    >
      <span className='sr-only'>{t(LABEL_KEY[status])}</span>
    </span>
  );
}
