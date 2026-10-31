// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The outlined badge a history row and a task row open with, naming what
 * kind of entry it is: an icon and a word.
 */

import type { JSX } from 'react';
import type { LucideIcon } from 'lucide-react';

/** What {@link KindBadge} renders. */
export interface KindBadgeProps {
  /** The kind's icon. */
  icon: LucideIcon;
  /** The kind's name, already translated. */
  label: string;
  /** The text colour, which each row sets for its own states. */
  colorClassName: string;
  /** Test hook, set as `data-testid`. */
  testId?: string;
}

/**
 * Render the badge.
 * @param props - The badge inputs.
 * @param props.icon - The kind's icon.
 * @param props.label - The kind's name.
 * @param props.colorClassName - The text colour.
 * @param props.testId - Test hook.
 * @returns The badge element.
 */
export function KindBadge({
  icon: Icon,
  label,
  colorClassName,
  testId,
}: KindBadgeProps): JSX.Element {
  return (
    <span
      data-testid={testId}
      className={
        'inline-flex shrink-0 items-center gap-1 rounded-content-xs border border-border px-1.5 py-px text-2xs font-semibold leading-tight ' +
        colorClassName
      }
    >
      <Icon className='h-2.5 w-2.5' aria-hidden='true' />
      {label}
    </span>
  );
}
