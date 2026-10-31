// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import type * as React from 'react';

import { cn } from '@web/lib/utils';

interface CountChipProps extends React.HTMLAttributes<HTMLSpanElement> {
  /** The number shown. Whether a zero is shown at all is the caller's call. */
  count: number;
}

/**
 * The muted chip after a tab or filter label that says how many things sit
 * behind it (studio sections, the comment panel's filters).
 * @param root0 - Chip props, plus any extra span attributes.
 * @param root0.count - The number shown.
 * @param root0.className - Extra classes, merged over the chip's own.
 * @returns The chip.
 */
export function CountChip({
  count,
  className,
  ...rest
}: CountChipProps): React.JSX.Element {
  return (
    <span
      className={cn(
        'rounded-full bg-muted px-1.5 text-xs font-medium leading-[18px] text-muted-foreground',
        className,
      )}
      {...rest}
    >
      {count}
    </span>
  );
}
