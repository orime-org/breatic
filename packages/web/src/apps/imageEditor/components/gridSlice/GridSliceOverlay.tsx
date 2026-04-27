import React from 'react';
import { cn } from '@/utils/classnames';

type GridSliceOverlayProps = {
  rows: number;
  cols: number;
  selectedCells: string[];
  onToggleCell: (row: number, col: number) => void;
};

const GridSliceOverlay: React.FC<GridSliceOverlayProps> = ({ rows, cols, selectedCells, onToggleCell }) => {
  const getCellFromEvent = (event: React.MouseEvent<HTMLDivElement> | React.KeyboardEvent<HTMLDivElement>) => {
    const { row, col } = event.currentTarget.dataset;
    const nextRow = Number(row);
    const nextCol = Number(col);
    if (!Number.isFinite(nextRow) || !Number.isFinite(nextCol)) return null;
    return { row: nextRow, col: nextCol };
  };

  const handleCellClick = (event: React.MouseEvent<HTMLDivElement>) => {
    const next = getCellFromEvent(event);
    if (!next) return;
    onToggleCell(next.row, next.col);
  };

  const handleCellKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    event.preventDefault();
    const next = getCellFromEvent(event);
    if (!next) return;
    onToggleCell(next.row, next.col);
  };

  return (
    <div className='pointer-events-none absolute inset-0'>
      <div
        className='grid h-full w-full'
        style={{
          gridTemplateColumns: `repeat(${Math.max(1, cols)}, minmax(0, 1fr))`,
          gridTemplateRows: `repeat(${Math.max(1, rows)}, minmax(0, 1fr))`,
        }}
      >
        {Array.from({ length: rows }).map((_, rowIndex) =>
          Array.from({ length: cols }).map((__, colIndex) => {
            const row = rowIndex + 1;
            const col = colIndex + 1;
            const cellKey = `${row}-${col}`;
            const selectedCell = selectedCells.includes(cellKey);
            return (
              <div
                key={cellKey}
                role='button'
                tabIndex={0}
                data-row={row}
                data-col={col}
                style={{
                  borderTopWidth: 1,
                  borderLeftWidth: 1,
                  borderRightWidth: col === cols ? 1 : 0,
                  borderBottomWidth: row === rows ? 1 : 0,
                }}
                className={cn(
                  'pointer-events-auto relative border-solid border-[#98A2FF] transition-colors',
                  selectedCell ? 'bg-[rgba(109,124,255,0.20)]' : 'bg-transparent hover:bg-[rgba(109,124,255,0.12)]',
                )}
                onClick={handleCellClick}
                onKeyDown={handleCellKeyDown}
                aria-label={`Grid slice cell ${row}-${col}`}
              >
                <span className='pointer-events-none absolute right-1 top-1 inline-flex h-[14px] items-center justify-center rounded-full bg-[#7879F1] px-[4px] text-[10px] font-semibold leading-[14px] text-text-on-button-base'>
                  {cellKey}
                </span>
              </div>
            );
          }),
        )}
      </div>
    </div>
  );
};

export default GridSliceOverlay;
