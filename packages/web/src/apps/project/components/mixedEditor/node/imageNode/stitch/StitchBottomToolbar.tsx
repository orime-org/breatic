import React, { useEffect, useState } from 'react';
import { Icon } from '@/components/base/icon';
import { Button } from '@/components/base/button';
import Input from '@/components/base/input';
import Divider from '@/components/base/divider';
import { cn } from '@/utils/classnames';
import GridSliceSettings, { type GridSliceValue } from '../gridSlice/GridSliceSettings';

type StitchBottomToolbarProps = {
  active: boolean;
  onSend: (payload: { gridSlice: GridSliceValue; selectedCells: string[] }) => void;
  gridSlice: GridSliceValue;
  onGridSliceChange: (next: GridSliceValue) => void;
  width: number;
  height: number;
  onDimensionChange: (next: { width: number; height: number }) => void;
};

const StitchBottomToolbar: React.FC<StitchBottomToolbarProps> = ({
  active,
  onSend,
  gridSlice,
  onGridSliceChange,
  width,
  height,
  onDimensionChange,
}) => {
  const [inputW, setInputW] = useState(String(Math.max(1, Math.round(width))));
  const [inputH, setInputH] = useState(String(Math.max(1, Math.round(height))));

  useEffect(() => {
    setInputW(String(Math.max(1, Math.round(width))));
  }, [width]);

  useEffect(() => {
    setInputH(String(Math.max(1, Math.round(height))));
  }, [height]);

  const handleSendClick = () => {
    const targetCells = Array.from({ length: Math.max(1, gridSlice.rows) }, (_, rowIndex) =>
      Array.from({ length: Math.max(1, gridSlice.cols) }, (_, colIndex) => `${rowIndex + 1}-${colIndex + 1}`),
    ).flat();

    onSend({
      gridSlice,
      selectedCells: targetCells,
    });
  };

  const commitW = (raw: string) => {
    const parsed = parseInt(raw, 10);
    if (Number.isNaN(parsed) || parsed < 1) {
      setInputW(String(Math.max(1, Math.round(width))));
      return;
    }
    const nextWidth = Math.max(1, parsed);
    setInputW(String(nextWidth));
    onDimensionChange({ width: nextWidth, height: Math.max(1, Math.round(height)) });
  };

  const commitH = (raw: string) => {
    const parsed = parseInt(raw, 10);
    if (Number.isNaN(parsed) || parsed < 1) {
      setInputH(String(Math.max(1, Math.round(height))));
      return;
    }
    const nextHeight = Math.max(1, parsed);
    setInputH(String(nextHeight));
    onDimensionChange({ width: Math.max(1, Math.round(width)), height: nextHeight });
  };

  if (!active) return null;

  return (
    <div className='nodrag nopan pointer-events-auto flex flex-col items-center gap-3'>
      <div
        className={cn(
          'nodrag nopan pointer-events-auto flex h-[40px] items-center gap-1 rounded-[8px] border border-[#DBDBDB] bg-background-default-base px-[12px] py-[4px] shadow-[0_1px_3px_rgba(0,0,0,0.08)]'
        )}
        onMouseDown={(e) => e.stopPropagation()}
        onPointerDown={(e) => e.stopPropagation()}
      >
        <div className='nodrag nopan inline-flex h-8 items-center gap-1'>
          <Icon name='project-image-editor-more-grid-slice-icon' width={18} height={18} color='var(--color-icon-base)' />
          <span className='text-text-default-base text-sm font-bold'>Stitch</span>
        </div>
        <Divider type='vertical' className='mx-2 h-[18px] bg-[#D0D0D0]' />
        <div className='flex items-center gap-1'>
          <span className='text-[12px] text-text-default-secondary'>W</span>
          <Input
            size='middle'
            type='outlined'
            inputType='text'
            value={inputW}
            onChange={(e) => setInputW(e.target.value)}
            onBlur={(e) => commitW(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') commitW((e.target as HTMLInputElement).value);
            }}
            className='!h-[28px] !w-[60px] !bg-background-default-base !px-2 !text-center !text-[13px] !font-semibold text-text-default-base'
            aria-label='Stitch width'
          />
        </div>
        <div className='flex items-center gap-1'>
          <span className='text-[12px] text-text-default-secondary'>H</span>
          <Input
            size='middle'
            type='outlined'
            inputType='text'
            value={inputH}
            onChange={(e) => setInputH(e.target.value)}
            onBlur={(e) => commitH(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') commitH((e.target as HTMLInputElement).value);
            }}
            className='!h-[28px] !w-[60px] !bg-background-default-base !px-2 !text-center !text-[13px] !font-semibold text-text-default-base'
            aria-label='Stitch height'
          />
        </div>
        <Divider type='vertical' className='mx-2 h-[18px] bg-[#D0D0D0]' />
        <GridSliceSettings value={gridSlice} onChange={onGridSliceChange} />
        <Divider type='vertical' className='mx-2 h-[18px] bg-[#D0D0D0]' />
        <Button
          type='primary'
          size='medium'
          shape='round'
          className='!h-[28px] !w-[52px] !min-w-[52px] !py-[2px] !pl-[16px] !pr-[12px] !bg-[#2FB344] !border-[#2FB344] hover:!bg-[#28A13D] hover:!border-[#28A13D] disabled:!bg-[#D8D8D8] disabled:!border-[#D8D8D8]'
          icon={<Icon name='project-chat-send-icon' width={18} height={16} color='#fff' />}
          onClick={handleSendClick}
          aria-label='Send stitch'
        />
      </div>
    </div>
  );
};

export default StitchBottomToolbar;
