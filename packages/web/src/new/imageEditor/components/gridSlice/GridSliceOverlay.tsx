import React from 'react';
import { cn } from '@/utils/classnames';

type GridSliceOverlayProps = {
  rows: number;
  cols: number;
  selectedCells: string[];
  onToggleCell: (row: number, col: number) => void;
  viewportScale?: number;
};

const GridSliceOverlay: React.FC<GridSliceOverlayProps> = ({
  rows,
  cols,
  selectedCells,
  onToggleCell,
  viewportScale,
}) => {
  const safeScale = Math.max(0.0001, viewportScale ?? 1);
  const inverseScale = 1 / safeScale;
  const borderWidth = Math.max(1 * inverseScale, 0.5);
  const labelHeight = Math.max(14 * inverseScale, 10);
  const labelFontSize = Math.max(10 * inverseScale, 8);
  const labelHorizontalPadding = Math.max(5 * inverseScale, 3);
  const labelMinWidth = Math.max(24 * inverseScale, 16);
  const labelLineHeight = `${labelHeight}px`;
  const labelOffset = Math.max(4 * inverseScale, 2);

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
                  borderTopWidth: borderWidth,
                  borderLeftWidth: borderWidth,
                  borderRightWidth: col === cols ? borderWidth : 0,
                  borderBottomWidth: row === rows ? borderWidth : 0,
                }}
                className={cn(
                  'pointer-events-auto border-solid border-[#98A2FF] transition-colors',
                  selectedCell ? 'bg-[rgba(109,124,255,0.20)]' : 'bg-transparent hover:bg-[rgba(109,124,255,0.12)]',
                )}
                onClick={handleCellClick}
                onKeyDown={handleCellKeyDown}
                aria-label={`Grid slice cell ${row}-${col}`}
              />
            );
          }),
        )}
      </div>
      <div className='pointer-events-none absolute inset-0'>
        {Array.from({ length: rows }).map((_, rowIndex) =>
          Array.from({ length: cols }).map((__, colIndex) => {
            const row = rowIndex + 1;
            const col = colIndex + 1;
            const cellKey = `${row}-${col}`;
            const cellWidthPercent = 100 / Math.max(1, cols);
            const cellHeightPercent = 100 / Math.max(1, rows);
            const cellRightPercent = 100 - col * cellWidthPercent;
            const cellTopPercent = (row - 1) * cellHeightPercent;
            return (
              <span
                key={`label-${cellKey}`}
                className='absolute inline-flex items-center justify-center whitespace-nowrap rounded-full bg-[#7879F1] font-semibold text-text-on-button-base'
                style={{
                  right: `calc(${cellRightPercent}% + ${labelOffset}px)`,
                  top: `calc(${cellTopPercent}% + ${labelOffset}px)`,
                  height: labelHeight,
                  minWidth: labelMinWidth,
                  paddingLeft: labelHorizontalPadding,
                  paddingRight: labelHorizontalPadding,
                  fontSize: labelFontSize,
                  lineHeight: labelLineHeight,
                }}
              >
                {cellKey}
              </span>
            );
          }),
        )}
      </div>
    </div>
  );
};

export default GridSliceOverlay;
