// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The grid a new table's size is picked from: nine rows of nine cells, lit
 * from the top left to the cell under the pointer, with the size named below.
 *
 * Each cell is a menu item, so the menu's own focus handling reaches it. The
 * menu moves the focus up and down one item at a time; the arrow keys here
 * move it across the grid instead, and ArrowLeft in the first column is left
 * to the menu, which closes the submenu.
 *
 * The slash menu draws the same grid without Radix (`PlainTableSizeGrid`):
 * the focus stays in the body there, so the menu owns the lit cell and moves
 * it from its own key handler (inner#1125 design 5.8).
 */

import * as React from 'react';

import { Button } from '@web/components/ui/button';
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

/** What every cell looks like, lit or not. */
const CELL = 'size-4 rounded-chrome-sm border border-border bg-background p-0';

/** What a lit cell adds. */
const CELL_ON = 'border-transparent bg-[var(--color-selection)]';

/**
 * Where an arrow key moves the lit cell, kept inside the grid.
 * @param at - The lit cell.
 * @param key - The key pressed.
 * @returns The cell it moves to, or undefined for a key that is not an arrow.
 */
export function stepCell(at: TableSize, key: string): TableSize | undefined {
  const step = STEP[key];
  if (step === undefined) return undefined;
  return {
    rows: Math.min(Math.max(at.rows + step[0], 1), GRID),
    cols: Math.min(Math.max(at.cols + step[1], 1), GRID),
  };
}

/**
 * The line under the grid naming the size lit.
 * @param props - The lit cell.
 * @param props.at - The lit cell, or null while none is.
 * @returns The line.
 */
function SizeLabel({ at }: { at: TableSize | null }): React.JSX.Element {
  const t = useTranslation();
  return (
    <div
      data-testid='doc-table-size-label'
      className='px-1 pb-1 text-center text-xs text-muted-foreground'
    >
      {at === null
        ? t('spaces.document.table.pickSize')
        : t('spaces.document.table.size', { rows: at.rows, cols: at.cols })}
    </div>
  );
}

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
  const [at, setAt] = React.useState<TableSize | null>(null);
  const gridRef = React.useRef<HTMLDivElement>(null);

  const onCellFocus = React.useCallback((event: React.FocusEvent<HTMLElement>): void => {
    setAt(sizeOf(event.currentTarget));
  }, []);

  const onCellKeyDown = React.useCallback((event: React.KeyboardEvent<HTMLElement>): void => {
    const from = sizeOf(event.currentTarget);
    const next = stepCell(from, event.key);
    if (next === undefined) return;
    // The first column's ArrowLeft goes to the menu, which closes this submenu.
    if (event.key === 'ArrowLeft' && from.cols === 1) return;
    event.preventDefault();
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
              className={cn(CELL, 'focus:bg-[var(--color-selection)]', on && CELL_ON)}
              onFocus={onCellFocus}
              onKeyDown={onCellKeyDown}
              onSelect={onCellSelect}
            />
          );
        })}
      </div>
      <SizeLabel at={at} />
    </>
  );
});

interface PlainTableSizeGridProps {
  /** The lit cell, owned by the menu; null while none is. */
  at: TableSize | null;
  /** What the pointer over a cell does. */
  onHover: (size: TableSize) => void;
  /** What pressing a cell does. */
  onPick: (size: TableSize) => void;
}

/**
 * The grid without a Radix menu around it, for a menu that keeps the focus in
 * the body: the cells never take the focus, the pointer lights them and a
 * press picks.
 * @param props - See {@link PlainTableSizeGridProps}.
 * @param props.at - The lit cell.
 * @param props.onHover - What the pointer over a cell does.
 * @param props.onPick - What pressing a cell does.
 * @returns The grid.
 */
export const PlainTableSizeGrid = React.memo(function PlainTableSizeGrid({
  at,
  onHover,
  onPick,
}: PlainTableSizeGridProps): React.JSX.Element {
  return (
    <>
      <div className='grid grid-cols-9 gap-1 p-1'>
        {CELLS.map((size) => {
          const on = at !== null && size.rows <= at.rows && size.cols <= at.cols;
          return (
            <Button
              key={`${size.rows}-${size.cols}`}
              variant={null}
              size={null}
              tabIndex={-1}
              data-testid={`doc-slash-table-size-${size.rows}-${size.cols}`}
              data-on={on ? '' : undefined}
              className={cn(CELL, on && CELL_ON)}
              onMouseEnter={() => {
                onHover(size);
              }}
              onMouseDown={(event) => {
                // Only the main button picks, as in the insert menu.
                if (event.button === 0) onPick(size);
              }}
            />
          );
        })}
      </div>
      <SizeLabel at={at} />
    </>
  );
});
