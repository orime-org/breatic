import { useEffect, useState } from 'react';
import type { KeyboardEvent, MouseEvent } from 'react';
import { cn } from '@/utils/classnames';

export const SLASH_TABLE_GRID_SIZE = 9;

const SLASH_TABLE_CELL_PX = 20;
const SLASH_TABLE_CELL_GAP_PX = 2;

type GridPoint = { row: number; col: number };

type SlashTableSizePickerProps = {
  /** When true, resets hover to 3×3 (each time the table flyout is shown). */
  open: boolean;
  onCommit: (rows: number, cols: number) => void;
  onHoverChange?: (rows: number, cols: number) => void;
};

const getCellFromEvent = (event: { currentTarget: HTMLDivElement }): GridPoint | null => {
  const { row, col } = event.currentTarget.dataset;
  const nextRow = Number(row);
  const nextCol = Number(col);
  if (!Number.isFinite(nextRow) || !Number.isFinite(nextCol)) return null;
  return { row: nextRow, col: nextCol };
};

/** Hover: rectangle from (1,1) to cell. Commit on left mousedown + preventDefault (keeps editor focus / slash range). */
export function SlashTableSizePicker({ open, onCommit, onHoverChange }: SlashTableSizePickerProps) {
  const [hoverEnd, setHoverEnd] = useState<GridPoint>({ row: 3, col: 3 });

  useEffect(() => {
    if (!open) return;
    const end = { row: 3, col: 3 };
    setHoverEnd(end);
    onHoverChange?.(3, 3);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only reset when flyout opens
  }, [open]);

  const applyHover = (next: GridPoint) => {
    setHoverEnd(next);
    onHoverChange?.(next.row, next.col);
  };

  const handleCellMouseEnter = (event: MouseEvent<HTMLDivElement>) => {
    const next = getCellFromEvent(event);
    if (!next) return;
    applyHover(next);
  };

  const handleCellMouseDown = (event: MouseEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    const next = getCellFromEvent(event);
    if (!next) return;
    onCommit(next.row, next.col);
  };

  const minRow = 1;
  const minCol = 1;
  const maxRow = hoverEnd.row;
  const maxCol = hoverEnd.col;

  const track = `repeat(${SLASH_TABLE_GRID_SIZE}, ${SLASH_TABLE_CELL_PX}px)`;
  const gridGapStyle = { gap: SLASH_TABLE_CELL_GAP_PX } as const;

  return (
    <div
      className='box-border max-w-[calc(100vw-24px)] shrink-0 overflow-hidden rounded-[10px] border border-border-default-base bg-background-default-base shadow-[0px_8px_24px_-8px_rgba(12,12,13,0.25)]'
      data-breatic-slash-menu
      data-breatic-table-picker
      onMouseDown={(e) => e.preventDefault()}
    >
      <div className='flex items-center justify-between gap-2 px-[10px] pb-2 pt-[10px]'>
        <span className='select-none text-left text-[12px] leading-normal text-text-default-secondary'>Insert table</span>
        <span className='select-none whitespace-nowrap text-[12px] tabular-nums leading-normal text-text-default-base'>
          {hoverEnd.col} x {hoverEnd.row}
        </span>
      </div>
      <div className='box-border px-[10px] pb-[10px]'>
        <div className='rounded-[4px] border border-border-default-base bg-background-default-base p-[10px]'>
          <div
            className='mx-auto grid w-fit rounded-[4px] bg-background-default-base'
            style={{
              ...gridGapStyle,
              gridTemplateColumns: track,
              gridTemplateRows: track,
            }}
          >
            {Array.from({ length: SLASH_TABLE_GRID_SIZE }).map((_, rowIndex) =>
              Array.from({ length: SLASH_TABLE_GRID_SIZE }).map((__, colIndex) => {
                const nextRow = rowIndex + 1;
                const nextCol = colIndex + 1;
                const selected =
                  nextRow >= minRow && nextRow <= maxRow && nextCol >= minCol && nextCol <= maxCol;
                return (
                  <div
                    key={`cell-${rowIndex}-${colIndex}`}
                    role='button'
                    tabIndex={0}
                    data-row={nextRow}
                    data-col={nextCol}
                    style={{ width: SLASH_TABLE_CELL_PX, height: SLASH_TABLE_CELL_PX }}
                    className={cn(
                      'box-border shrink-0 cursor-pointer rounded-[2px] transition-colors',
                      selected ? 'bg-brand-200' : 'bg-background-default-secondary',
                    )}
                    onMouseEnter={handleCellMouseEnter}
                    onMouseDown={handleCellMouseDown}
                    onKeyDown={(e: KeyboardEvent<HTMLDivElement>) => {
                      if (e.key !== 'Enter' && e.key !== ' ') return;
                      e.preventDefault();
                      const next = getCellFromEvent(e);
                      if (!next) return;
                      onCommit(next.row, next.col);
                    }}
                  />
                );
              }),
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
