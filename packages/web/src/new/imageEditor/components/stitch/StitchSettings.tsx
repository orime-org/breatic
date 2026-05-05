import React, { useEffect, useState } from 'react';
import { Icon } from '@/components/base/icon';
import Input from '@/components/base/input';
import Dropdown from '@/components/base/dropdown';
import { cn } from '@/utils/classnames';

const minGrid = 1;
const maxGrid = 8;

export type StitchValue = {
  rows: number;
  cols: number;
};

type StitchSettingsProps = {
  value: StitchValue;
  onChange: (next: StitchValue) => void;
};

type GridPoint = {
  row: number;
  col: number;
};

const clampGrid = (value: number) => Math.max(minGrid, Math.min(maxGrid, Math.round(value)));

const StitchSettings: React.FC<StitchSettingsProps> = ({ value, onChange }) => {
  const [openPicker, setOpenPicker] = useState(false);
  const [isDraggingGrid, setIsDraggingGrid] = useState(false);
  const [selectionStart, setSelectionStart] = useState<GridPoint | null>(null);
  const [selectionEnd, setSelectionEnd] = useState<GridPoint | null>(null);
  const rows = clampGrid(value.rows);
  const cols = clampGrid(value.cols);

  const setDimension = (key: 'rows' | 'cols', nextValue: number) => {
    const next = clampGrid(nextValue);
    const nextRows = key === 'rows' ? next : rows;
    const nextCols = key === 'cols' ? next : cols;
    onChange({ rows: nextRows, cols: nextCols });
    setSelectionStart({ row: 1, col: 1 });
    setSelectionEnd({ row: nextRows, col: nextCols });
  };

  useEffect(() => {
    if (!isDraggingGrid) return;
    const handleMouseUp = () => setIsDraggingGrid(false);
    window.addEventListener('mouseup', handleMouseUp);
    return () => window.removeEventListener('mouseup', handleMouseUp);
  }, [isDraggingGrid]);

  const getCellFromEvent = (event: React.MouseEvent<HTMLDivElement> | React.KeyboardEvent<HTMLDivElement>): GridPoint | null => {
    const { row, col } = (event.currentTarget as HTMLDivElement).dataset;
    const nextRow = Number(row);
    const nextCol = Number(col);
    if (!Number.isFinite(nextRow) || !Number.isFinite(nextCol)) return null;
    return { row: nextRow, col: nextCol };
  };

  const toDimensions = (start: GridPoint, end: GridPoint): StitchValue => ({
    rows: Math.abs(end.row - start.row) + 1,
    cols: Math.abs(end.col - start.col) + 1,
  });

  const handleCellMouseEnter = (event: React.MouseEvent<HTMLDivElement>) => {
    if (!isDraggingGrid || !selectionStart) return;
    const next = getCellFromEvent(event);
    if (!next) return;
    setSelectionEnd(next);
    onChange(toDimensions(selectionStart, next));
  };

  const handleCellMouseDown = (event: React.MouseEvent<HTMLDivElement>) => {
    const next = getCellFromEvent(event);
    if (!next) return;
    setIsDraggingGrid(true);
    setSelectionStart(next);
    setSelectionEnd(next);
    onChange({ rows: 1, cols: 1 });
  };

  const handleCellMouseUp = () => setIsDraggingGrid(false);

  const handleCellClick = (event: React.MouseEvent<HTMLDivElement>) => {
    const next = getCellFromEvent(event);
    if (!next) return;
    setSelectionStart(next);
    setSelectionEnd(next);
    onChange({ rows: 1, cols: 1 });
  };

  const handleCellKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    event.preventDefault();
    const next = getCellFromEvent(event);
    if (!next) return;
    setSelectionStart(next);
    setSelectionEnd(next);
    onChange({ rows: 1, cols: 1 });
  };

  const renderGridPopup = () => (
    <div className='h-[150px] w-[150px] rounded-[8px] border border-[#D2D2D2] bg-white p-[4px] shadow-[0px_8px_24px_-8px_rgba(12,12,13,0.25)]'>
      <div className='grid h-full w-full grid-cols-8 grid-rows-8 gap-[2px] rounded-[4px]'>
        {Array.from({ length: maxGrid }).map((_, rowIndex) =>
          Array.from({ length: maxGrid }).map((__, colIndex) => {
            const nextRow = rowIndex + 1;
            const nextCol = colIndex + 1;
            const activeStart = selectionStart ?? { row: 1, col: 1 };
            const activeEnd = selectionEnd ?? { row: rows, col: cols };
            const minRow = Math.min(activeStart.row, activeEnd.row);
            const maxRow = Math.max(activeStart.row, activeEnd.row);
            const minCol = Math.min(activeStart.col, activeEnd.col);
            const maxCol = Math.max(activeStart.col, activeEnd.col);
            const selected = nextRow >= minRow && nextRow <= maxRow && nextCol >= minCol && nextCol <= maxCol;
            return (
              <div
                key={`cell-${rowIndex}-${colIndex}`}
                role='button'
                tabIndex={0}
                data-row={nextRow}
                data-col={nextCol}
                className={cn(
                  'aspect-square h-full min-h-0 w-full min-w-0 cursor-pointer rounded-[2px] p-0 transition-colors',
                  selected
                    ? 'border border-[#7879F1] bg-[rgba(109,124,255,0.20)]'
                    : 'border border-[#D9D9D9] bg-[#F3F3F3]',
                )}
                onMouseEnter={handleCellMouseEnter}
                onMouseDown={handleCellMouseDown}
                onMouseUp={handleCellMouseUp}
                onClick={handleCellClick}
                onKeyDown={handleCellKeyDown}
                aria-label={`Set stitch grid ${nextCol} by ${nextRow}`}
              />
            );
          }),
        )}
      </div>
    </div>
  );

  return (
    <div className='relative flex items-center gap-2'>
      <div className='flex h-7 items-center gap-2 rounded-[6px] bg-background-default-base'>
        <Icon name='imageEditor-grid-cols-icon' width={18} height={18} />
        <Input
          size='middle'
          type='outlined'
          inputType='text'
          min={minGrid}
          max={maxGrid}
          value={String(cols)}
          onChange={(e) => {
            const raw = Number(e.target.value);
            if (Number.isNaN(raw)) return;
            setDimension('cols', raw);
          }}
          className='nodrag nopan !h-[24px] !w-[28px] !bg-transparent !p-0 text-center !text-[13px] !font-semibold text-text-default-base'
          aria-label='Stitch cols count'
        />
      </div>
      <div className='flex h-7 items-center gap-2 rounded-[6px] bg-background-default-base'>
        <Icon name='imageEditor-grid-rows-icon' width={18} height={18} />
        <Input
          size='middle'
          type='outlined'
          inputType='text'
          min={minGrid}
          max={maxGrid}
          value={String(rows)}
          onChange={(e) => {
            const raw = Number(e.target.value);
            if (Number.isNaN(raw)) return;
            setDimension('rows', raw);
          }}
          className='nodrag nopan !h-[24px] !w-[28px] !bg-transparent !p-0 text-center !text-[13px] !font-semibold text-text-default-base'
          aria-label='Stitch rows count'
        />
      </div>
      <Dropdown
        trigger='click'
        placement='top-end'
        offset={8}
        items={[]}
        open={openPicker}
        onOpenChange={setOpenPicker}
        popupRender={renderGridPopup}
      >
        <Icon
          name='base-chevron-down-icon'
          width={10}
          height={10}
          color='var(--color-icon-base)'
          className={cn('transition-transform duration-200', openPicker ? 'rotate-180' : '')}
        />
      </Dropdown>
    </div>
  );
};

export default StitchSettings;
