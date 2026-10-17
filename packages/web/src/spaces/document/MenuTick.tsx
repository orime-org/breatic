// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The column that marks the row in force, in every menu that has one.
 *
 * Four menus mark a row this way — the bubble bar's block type and alignment
 * slots, and the block handle menu's two submenus — and the column is the same
 * column in all four: a fixed 16px box holding a tick, drawn whether the row
 * is marked or not so a marked row lays out no narrower than the rest.
 *
 * Written out per menu it drifts. Only the margin is the caller's: three of
 * the four grow the label to fill the row and want the 4px this one defaults
 * to, while the bubble bar's alignment slot leaves its label at its own width
 * and pushes the column over with `ml-auto`.
 *
 * A tick rather than a fill: a fill would sit one step of grey from the hover
 * fill, leaving two similar greys on screen at once — and in the block handle
 * menu the fill is already taken, since Radix paints an open submenu's trigger
 * with it.
 */

import { Check } from 'lucide-react';
import type * as React from 'react';

import { cn } from '@web/lib/utils';

interface MenuTickProps {
  /** Whether this row is the one in force. */
  on: boolean;
  /** The margin, where a menu whose label does not grow needs `ml-auto`. */
  className?: string;
  /** Test id for the column, which a case reads to prove it is always drawn. */
  testId?: string;
  /** Test id for the tick itself. */
  tickTestId?: string;
}

/**
 * One tick column.
 * @param props - See {@link MenuTickProps}.
 * @param props.on - Whether this row is the one in force.
 * @param props.className - Extra classes.
 * @param props.testId - Test id for the column.
 * @param props.tickTestId - Test id for the tick.
 * @returns The column.
 */
export function MenuTick({
  on,
  className,
  testId,
  tickTestId,
}: MenuTickProps): React.JSX.Element {
  return (
    <span
      data-testid={testId}
      className={cn(
        'ml-1 flex size-4 shrink-0 items-center justify-center',
        className,
      )}
    >
      {on ? (
        <Check data-testid={tickTestId} className='size-4' strokeWidth={3} />
      ) : null}
    </span>
  );
}
