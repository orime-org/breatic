// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The grid a new table's size is picked from: nine rows of nine cells, lit
 * from the top left to the cell under the pointer, with the size named below.
 *
 * Each cell is a menu item, so the menu's own focus handling reaches it. The
 * menu moves the focus up and down one item at a time; the arrow keys here
 * move it across the grid instead, and ArrowLeft in the first column is left
 * to the menu, which closes the submenu.
 */

import * as React from 'react';

import { DropdownMenuItem } from '@web/components/ui/dropdown-menu';
import { useTranslation } from '@web/i18n/use-translation';
import { cn } from '@web/lib/utils';
import type { TableSize } from '@web/spaces/document/document-insert-row';

/** How many rows and columns the grid offers. */
const GRID = 9;

/** Every cell, row by row. */
const CELLS: readonly TableSize[] = Array.from({ length: GRID * GRID }, (_, index) => ({
  rows: Math.floor(index / GRID) + 1,
  cols: (index % GRID) + 1,
}));

/** How far each arrow key moves, in rows and columns. */
const STEP: Readonly<Record<string, readonly [number, number]>> = {
  ArrowUp: [-1, 0],
  ArrowDown: [1, 0],
  ArrowLeft: [0, -1],
  ArrowRight: [0, 1],
};

interface DocumentTableSizeGridProps {
  /** What picking a cell does. */
  onPick: (size: TableSize) => void;
}

/**
 * Reads the size a cell stands for off its element.
 * @param element - The cell.
 * @returns Its size.
 */
function sizeOf(element: HTMLElement): TableSize {
  return { rows: Number(element.dataset['rows']), cols: Number(element.dataset['cols']) };
}

/**
 * The grid and the line naming the size under it.
 * @param props - See {@link DocumentTableSizeGridProps}.
 * @param props.onPick - What picking a cell does.
 * @returns The grid.
 */
export const DocumentTableSizeGrid = React.memo(function DocumentTableSizeGrid({
  onPick,
}: DocumentTableSizeGridProps): React.JSX.Element {
  const t = useTranslation();
  const [at, setAt] = React.useState<TableSize | null>(null);
  const gridRef = React.useRef<HTMLDivElement>(null);

  const onCellFocus = React.useCallback((event: React.FocusEvent<HTMLElement>): void => {
    setAt(sizeOf(event.currentTarget));
  }, []);

  const onCellKeyDown = React.useCallback((event: React.KeyboardEvent<HTMLElement>): void => {
    const step = STEP[event.key];
    if (step === undefined) return;
    const { rows, cols } = sizeOf(event.currentTarget);
    // The first column's ArrowLeft goes to the menu, which closes this submenu.
    if (event.key === 'ArrowLeft' && cols === 1) return;
    event.preventDefault();
    const next = {
      rows: Math.min(Math.max(rows + step[0], 1), GRID),
      cols: Math.min(Math.max(cols + step[1], 1), GRID),
    };
    gridRef.current
      ?.querySelector<HTMLElement>(`[data-rows="${next.rows}"][data-cols="${next.cols}"]`)
      ?.focus();
  }, []);

  const onCellSelect = React.useCallback(
    (event: Event): void => {
      onPick(sizeOf(event.currentTarget as HTMLElement));
    },
    [onPick],
  );

  return (
    <>
      <div ref={gridRef} role='none' className='grid grid-cols-9 gap-1 p-1'>
        {CELLS.map(({ rows, cols }) => {
          const on = at !== null && rows <= at.rows && cols <= at.cols;
          return (
            <DropdownMenuItem
              key={`${rows}-${cols}`}
              data-testid={`doc-table-size-${rows}-${cols}`}
              data-rows={rows}
              data-cols={cols}
              data-on={on ? '' : undefined}
              className={cn(
                'size-4 rounded-chrome-sm border border-border bg-background p-0 focus:bg-[var(--color-selection)]',
                on && 'border-transparent bg-[var(--color-selection)]',
              )}
              onFocus={onCellFocus}
              onKeyDown={onCellKeyDown}
              onSelect={onCellSelect}
            />
          );
        })}
      </div>
      <div
        data-testid='doc-table-size-label'
        className='px-1 pb-1 text-center text-xs text-muted-foreground'
      >
        {at === null
          ? t('spaces.document.table.pickSize')
          : t('spaces.document.table.size', { rows: at.rows, cols: at.cols })}
      </div>
    </>
  );
});
