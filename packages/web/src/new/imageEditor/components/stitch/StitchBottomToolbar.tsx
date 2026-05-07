import React from 'react';
import { Icon } from '@/ui/icon';
import { Button } from '@/ui/button';
import Divider from '@/ui/divider';
import Tooltip from '@/ui/tooltip';
import { cn } from '@/utils/classnames';
import StitchSettings, { type StitchValue } from './StitchSettings';

type StitchBottomToolbarProps = {
  active: boolean;
  onClose: () => void;
  onSend: () => void;
  stitch: StitchValue;
  onStitchChange: (next: StitchValue) => void;
};

const iconBtnClass = 'nodrag nopan flex h-8 w-8 items-center justify-center rounded-[4px] text-icon-base transition-colors hover:bg-background-default-base-hover';

const StitchBottomToolbar: React.FC<StitchBottomToolbarProps> = ({
  active,
  onClose,
  onSend,
  stitch,
  onStitchChange,
}) => {
  if (!active) return null;

  return (
    <div className='nodrag nopan pointer-events-auto flex flex-col items-center gap-1'>
      <div
        className={cn(
          'nodrag nopan pointer-events-auto flex min-h-[40px] items-center gap-1 rounded-[8px] border border-[#DBDBDB] bg-background-default-base px-[12px] py-[4px] shadow-[0_1px_3px_rgba(0,0,0,0.08)]',
        )}
        onMouseDown={(e) => e.stopPropagation()}
        onPointerDown={(e) => e.stopPropagation()}
      >
        <div className='flex w-full items-center justify-between gap-1'>
          <div className='flex min-w-0 items-center gap-1'>
            <div className='nodrag nopan inline-flex h-8 items-center gap-1'>
              <Icon name='project-image-editor-more-grid-slice-icon' width={22} height={22} color='var(--bg-icon-base)' />
              <span className='whitespace-nowrap text-sm font-bold text-text-default-base'>Stitch</span>
            </div>
            <Divider type='vertical' className='mx-2 h-[18px] bg-[#D0D0D0]' />
            <StitchSettings value={stitch} onChange={onStitchChange} />
          </div>

          <div className='flex shrink-0 items-center gap-1'>
            <Divider type='vertical' className='mx-2 h-[18px] bg-[#D0D0D0]' />
            <Button
              type='primary'
              size='medium'
              shape='round'
              className='!h-[28px] !w-[52px] !min-w-[52px] !py-[2px] !pl-[16px] !pr-[12px] !bg-[#2FB344] !border-[#2FB344] hover:!bg-[#28A13D] hover:!border-[#28A13D] disabled:!bg-[#D8D8D8] disabled:!border-[#D8D8D8]'
              icon={<Icon name='project-chat-send-icon' width={18} height={16} color='#fff' />}
              onClick={onSend}
              aria-label='Send stitch'
            />
            <Divider type='vertical' className='mx-2 h-[18px] bg-[#D0D0D0]' />
            <Tooltip title='Exit' placement='top' offset={4}>
              <button type='button' className={iconBtnClass} onClick={onClose} aria-label='Close stitch toolbar'>
                <Icon name='imageEditor-multi-angle-close-icon' width={20} height={20} />
              </button>
            </Tooltip>
          </div>
        </div>
      </div>
    </div>
  );
};

export default StitchBottomToolbar;
