// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The badge on a task row saying which of the four states it is in (#186).
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

/** Semantic colour per state: border, tint and text, all from one family. */
const TONE: Readonly<Record<TaskStatus, string>> = {
  running:
    'border-status-info-border bg-status-info-bg text-status-info-foreground',
  done: 'border-status-success-border bg-status-success-bg text-status-success-foreground',
  failed:
    'border-status-error-border bg-status-error-bg text-status-error-foreground',
  expired:
    'border-status-warning-border bg-status-warning-bg text-status-warning-foreground',
};

/** i18n key per state. */
const LABEL_KEY: Readonly<Record<TaskStatus, string>> = {
  running: 'canvas.task.status.running',
  done: 'canvas.task.status.done',
  failed: 'canvas.task.status.failed',
  expired: 'canvas.task.status.expired',
};

/** What {@link TaskStatusBadge} renders. */
export interface TaskStatusBadgeProps {
  status: TaskStatus;
}

/**
 * Render one task's state as a coloured, named badge.
 *
 * The word carries the meaning and the colour reinforces it, so the state
 * still reads for anyone who does not see the four tints apart (WCAG 1.4.1).
 * Every state renders at the same type size and padding, so a row changing
 * state does not move what sits beside it.
 * @param props - The badge inputs.
 * @param props.status - Which state this task is in.
 * @returns The badge element.
 */
export function TaskStatusBadge({
  status,
}: TaskStatusBadgeProps): JSX.Element {
  const t = useTranslation();
  return (
    <span
      data-testid='task-status-badge'
      className={cn(
        'inline-flex items-center gap-1.5 whitespace-nowrap rounded-chrome border px-2 py-0.5 text-2xs font-semibold',
        TONE[status],
      )}
    >
      <span
        aria-hidden='true'
        className='size-1.5 flex-none rounded-full bg-current'
      />
      {t(LABEL_KEY[status])}
    </span>
  );
}
