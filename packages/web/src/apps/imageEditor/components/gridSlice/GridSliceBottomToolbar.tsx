import React, { useEffect, useState } from 'react';
import { Icon } from '@/components/base/icon';
import { Button } from '@/components/base/button';
import Dropdown, { type MenuItemType } from '@/components/base/dropdown';
import Divider from '@/components/base/divider';
import Tooltip from '@/components/base/tooltip';
import { cn } from '@/utils/classnames';
import GridSliceSettings, { type GridSliceValue } from './GridSliceSettings';

type GridSliceBottomToolbarProps = {
  active: boolean;
  onClose: () => void;
  onSend: (payload: EnhanceSendPayload) => void;
  gridSlice: GridSliceValue;
  onGridSliceChange: (next: GridSliceValue) => void;
  selectedCellCount: number;
  selectedCells: string[];
};

type EnhanceResolution = 'none' | '2k' | '4k' | '8k';
type EnhanceSendPayload = {
  resolution: EnhanceResolution;
  gridSlice: GridSliceValue;
  selectedCells: string[];
  promptEnabled: boolean;
  prompt: string;
};

const iconBtnClass = 'nodrag nopan flex h-8 w-8 items-center justify-center rounded-[4px] text-icon-base transition-colors hover:bg-background-default-base-hover';

const upscaleLabelMap: Record<EnhanceResolution, string> = {
  none: 'No Upscale',
  '2k': 'Upscale to 2K',
  '4k': 'Upscale to 4K',
  '8k': 'Upscale to 8K',
};

const upscaleMenuItems: MenuItemType[] = (Object.keys(upscaleLabelMap) as EnhanceResolution[]).map((key) => ({
  key,
  label: <span className='text-[13px] font-semibold text-text-default-base'>{upscaleLabelMap[key]}</span>,
}));

const GridSliceBottomToolbar: React.FC<GridSliceBottomToolbarProps> = ({
  active,
  onClose,
  onSend,
  gridSlice,
  onGridSliceChange,
  selectedCellCount,
  selectedCells,
}) => {
  const [resolution, setResolution] = useState<EnhanceResolution>('2k');
  const [upscaleOpen, setUpscaleOpen] = useState(false);
  const [promptEnabled, setPromptEnabled] = useState(false);
  const [prompt, setPrompt] = useState('');

  const credit = 120;
  const selectedUpscaleLabel = upscaleLabelMap[resolution];
  const consumeCredit = resolution === 'none' ? 0 : credit;

  useEffect(() => {
    if (!active) return;
    setResolution('2k');
    setPromptEnabled(false);
    setPrompt('');
  }, [active]);

  const handleSendClick = () => {
    const excluded = new Set(selectedCells);
    const targetCells = Array.from({ length: Math.max(1, gridSlice.rows) }, (_, rowIndex) =>
      Array.from({ length: Math.max(1, gridSlice.cols) }, (_, colIndex) => `${rowIndex + 1}-${colIndex + 1}`)
    )
      .flat()
      .filter((cellKey) => !excluded.has(cellKey));

    onSend({
      resolution,
      gridSlice,
      selectedCells: targetCells,
      promptEnabled,
      prompt,
    });
  };

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
              <span className='whitespace-nowrap text-sm font-bold text-text-default-base'>Grid Slice</span>
            </div>
            <Divider type='vertical' className='mx-2 h-[18px] bg-[#D0D0D0]' />
            <GridSliceSettings value={gridSlice} onChange={onGridSliceChange} />
            <Divider type='vertical' className='mx-2 h-[18px] bg-[#D0D0D0]' />
            <Dropdown
              trigger='click'
              placement='top-start'
              offset={8}
              items={upscaleMenuItems}
              selectedKeys={[resolution]}
              open={upscaleOpen}
              onOpenChange={setUpscaleOpen}
              onClick={(key) => setResolution(String(key) as EnhanceResolution)}
              popupClassName='rounded-[6px] border border-border-default-base p-1 shadow-[0px_8px_24px_-8px_rgba(12,12,13,0.25)]'
              itemClassName='h-8 px-2'
            >
              <Button
                type='default'
                size='small'
                className='nodrag nopan !inline-flex !h-[28px] !items-center !gap-1 !rounded-[6px] !border-0 !bg-background-default-base !px-2 hover:!bg-background-default-base-hover'
                aria-label='Upscale option'
              >
                <span className='whitespace-nowrap text-[13px] font-semibold text-text-default-base'>{selectedUpscaleLabel}</span>
                <span className={cn('transition-transform duration-200', upscaleOpen ? 'rotate-180' : '')}>
                  <Icon name='base-chevron-down-icon' width={10} height={10} color='var(--color-icon-base)' />
                </span>
              </Button>
            </Dropdown>
            <Divider type='vertical' className='mx-2 h-[18px] bg-[#D0D0D0]' />
            <span className='whitespace-nowrap text-[12px] font-semibold text-text-default-tertiary'>{selectedCellCount} cells selected</span>
          </div>

          <div className='flex shrink-0 items-center gap-1'>
            <Divider type='vertical' className='mx-2 h-[18px] bg-[#D0D0D0]' />
            <div className='flex items-center gap-1 text-text-default-tertiary text-[12px] font-semibold'>
              <Icon name='imageEditor-nano-banana-credit-icon' width={18} height={18} />
              <span>{consumeCredit}</span>
            </div>
            <Button
              type='primary'
              size='medium'
              shape='round'
              className='!h-[28px] !w-[52px] !min-w-[52px] !py-[2px] !pl-[16px] !pr-[12px] !bg-[#2FB344] !border-[#2FB344] hover:!bg-[#28A13D] hover:!border-[#28A13D] disabled:!bg-[#D8D8D8] disabled:!border-[#D8D8D8]'
              icon={<Icon name='project-chat-send-icon' width={18} height={16} color='#fff' />}
              onClick={handleSendClick}
              aria-label='Send enhance'
            />
            <Divider type='vertical' className='mx-2 h-[18px] bg-[#D0D0D0]' />
            <Tooltip title='Exit' placement='top' offset={4}>
              <button type='button' className={iconBtnClass} onClick={onClose} aria-label='Close enhance toolbar'>
                <Icon name='imageEditor-multi-angle-close-icon' width={20} height={20} />
              </button>
            </Tooltip>
          </div>
        </div>
      </div>
    </div>
  );
};

export default GridSliceBottomToolbar;
