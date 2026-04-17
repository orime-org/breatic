import React, { useEffect, useState } from 'react';
import { Icon } from '@/components/base/icon';
import { Button } from '@/components/base/button';
import Input from '@/components/base/input';
import Divider from '@/components/base/divider';
import { cn } from '@/utils/classnames';

type BlankBottomToolbarProps = {
  active: boolean;
  width: number;
  height: number;
  /** Carries the parsed dimensions from the input only when Save is clicked; does not update canvas node size before that */
  onSave: (next: { width: number; height: number }) => void;
};

/**
 * Blank node bottom toolbar: Blank label + W/H + Save on the left (visually consistent with the crop toolbar Save area).
 * W/H are validated locally on blur/Enter; dimensions are written to the canvas only on Save.
 *
 * @param props - {@link BlankBottomToolbarProps}
 * @returns React element; returns null when `active` is false
 */
const BlankBottomToolbar: React.FC<BlankBottomToolbarProps> = ({ active, width, height, onSave }) => {
  const [inputW, setInputW] = useState(String(Math.max(1, Math.round(width))));
  const [inputH, setInputH] = useState(String(Math.max(1, Math.round(height))));

  useEffect(() => {
    setInputW(String(Math.max(1, Math.round(width))));
  }, [width]);

  useEffect(() => {
    setInputH(String(Math.max(1, Math.round(height))));
  }, [height]);

  const commitW = (raw: string) => {
    const parsed = parseInt(raw, 10);
    if (Number.isNaN(parsed) || parsed < 1) {
      setInputW(String(Math.max(1, Math.round(width))));
      return;
    }
    setInputW(String(Math.max(1, parsed)));
  };

  const commitH = (raw: string) => {
    const parsed = parseInt(raw, 10);
    if (Number.isNaN(parsed) || parsed < 1) {
      setInputH(String(Math.max(1, Math.round(height))));
      return;
    }
    setInputH(String(Math.max(1, parsed)));
  };

  const parseCommittedDim = (raw: string, fallback: number): number => {
    const parsed = parseInt(raw, 10);
    if (Number.isNaN(parsed) || parsed < 1) return Math.max(1, Math.round(fallback));
    return Math.max(1, parsed);
  };

  const handleSaveClick = () => {
    const w = parseCommittedDim(inputW, width);
    const h = parseCommittedDim(inputH, height);
    setInputW(String(w));
    setInputH(String(h));
    onSave({ width: w, height: h });
  };

  if (!active) return null;

  return (
    <div className='nodrag nopan pointer-events-auto flex flex-col items-center gap-3'>
      <div
        className={cn(
          'nodrag nopan pointer-events-auto flex h-[40px] items-center gap-1 rounded-[8px] border border-[#DBDBDB] bg-background-default-base px-[12px] py-[4px]',
          'shadow-[0_1px_3px_rgba(0,0,0,0.08)]',
        )}
        onMouseDown={(e) => e.stopPropagation()}
        onPointerDown={(e) => e.stopPropagation()}
      >
        <div className='nodrag nopan inline-flex h-8 items-center gap-1'>
          <Icon
            name='project-image-editor-more-grid-slice-icon'
            width={18}
            height={18}
            color='var(--color-icon-base)'
          />
          <span className='text-[13px] font-bold text-text-default-base'>Blank</span>
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
            aria-label='Blank width'
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
            aria-label='Blank height'
          />
        </div>
        <Divider type='vertical' className='mx-2 h-[18px] bg-[#D0D0D0]' />
        <Button
          type='primary'
          shape='round'
          className='nodrag nopan !h-[28px] !bg-[#2FB344] !px-3 !text-[13px] !font-semibold !text-white hover:!bg-[#28A13D]'
          onClick={handleSaveClick}
        >
          <Icon name='imageEditor-mark-save-icon' width={18} height={18} />
          <span className='pl-2'>Save</span>
        </Button>
      </div>
    </div>
  );
};

export default BlankBottomToolbar;
