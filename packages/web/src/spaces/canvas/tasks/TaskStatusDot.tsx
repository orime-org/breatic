// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The mark saying which of the four states a task is in (#186).
 *
 * Each state gets its own shape as well as its own colour. Colour alone did
 * not carry it: dark theme measures failed at rgb(255,149,146) against
 * expired at rgb(255,160,87) — the same red channel, eleven apart on green,
 * and the rest of the difference in blue, the channel the eye weighs least.
 * At the size this mark is drawn the two read as one thing (user 2026-09-06).
 * Shape separates them, and it is also what keeps colour from being the only
 * carrier for a reader who does not see the four apart (WCAG 1.4.1).
 *
 * The state's name stays in the accessible tree, so a reader landing on a row
 * rather than on the panel's heading still hears which list they are in.
 *
 * It lives here rather than in `components/ui/` because the twelve places
 * this product shows a state colour are different things on screen — a ring
 * around a canvas node, a red line in the history panel, a dot on the
 * notification bell. They share colour tokens, not a shape, so there is
 * nothing for a shared primitive to hold (user 2026-09-03).
 */

import type { JSX } from 'react';
import { CircleCheck, CircleX, Clock, Loader2 } from 'lucide-react';

import { cn } from '@web/lib/utils';
import { useTranslation } from '@web/i18n/use-translation';

/** The four states a node task can be in. */
export type TaskStatus = 'running' | 'done' | 'failed' | 'expired';

/**
 * The shape per state. All four are round outlines so a column of them reads
 * as one kind of thing, and the running one turns — the way this product
 * already says "working" everywhere else.
 */
const SHAPE: Readonly<Record<TaskStatus, typeof Clock>> = {
  running: Loader2,
  done: CircleCheck,
  failed: CircleX,
  expired: Clock,
};

/** Semantic colour per state. */
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
 * Render one task's state as a coloured icon carrying its name for readers.
 *
 * Every state draws the same box, so a row settling does not move the
 * filename beside it.
 * @param props - The mark's inputs.
 * @param props.status - Which state this task is in.
 * @returns The mark element.
 */
export function TaskStatusDot({ status }: TaskStatusDotProps): JSX.Element {
  const t = useTranslation();
  const Icon = SHAPE[status];
  return (
    <span
      data-testid='task-status-dot'
      className={cn('relative flex-none', TONE[status])}
    >
      <Icon
        aria-hidden='true'
        className={cn('size-3', status === 'running' && 'animate-spin')}
      />
      <span className='sr-only'>{t(LABEL_KEY[status])}</span>
    </span>
  );
}
