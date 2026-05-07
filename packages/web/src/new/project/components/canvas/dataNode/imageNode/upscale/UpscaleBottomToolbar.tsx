import React, { useEffect, useState } from 'react';
import { Icon } from '@/ui/icon';
import { Button } from '@/ui/button';
import Dropdown, { type MenuItemType } from '@/ui/dropdown';
import Tooltip from '@/ui/tooltip';
import { cn } from '@/utils/classnames';

type UpscaleResolution = '2k' | '4k' | '8k';

type UpscaleBottomToolbarProps = {
  active: boolean;
  onClose: () => void;
  onSend: (payload: { resolution: UpscaleResolution; promptEnabled: boolean; prompt: string }) => void;
};

const resolutionLabelMap: Record<UpscaleResolution, string> = {
  '2k': '2K 2048x2605',
  '4k': '4K 4096x5210',
  '8k': '8K 8192x10420',
};

const resolutionMenuItems: MenuItemType[] = (Object.keys(resolutionLabelMap) as UpscaleResolution[]).map((key) => ({
  key,
  label: <span className='text-[13px] font-semibold text-text-default-base'>{resolutionLabelMap[key]}</span>,
}));

const iconBtnClass =
  'nodrag nopan flex h-8 w-8 items-center justify-center rounded-[4px] text-icon-base transition-colors hover:bg-background-default-base-hover';

const UpscaleBottomToolbar: React.FC<UpscaleBottomToolbarProps> = ({ active, onClose, onSend }) => {
  const [resolution, setResolution] = useState<UpscaleResolution>('4k');
  const [menuOpen, setMenuOpen] = useState(false);
  const [promptEnabled, setPromptEnabled] = useState(true);
  const [prompt, setPrompt] = useState('');

  useEffect(() => {
    if (!active) return;
    setResolution('4k');
    setPromptEnabled(true);
    setPrompt('');
  }, [active]);

  if (!active) return null;

  return (
    <div
      className='nodrag nopan pointer-events-auto w-[430px] rounded-[8px] border border-[#DBDBDB] bg-background-default-base p-[12px] shadow-[0_1px_3px_rgba(0,0,0,0.08)]'
      onMouseDown={(e) => e.stopPropagation()}
      onPointerDown={(e) => e.stopPropagation()}
    >
      <div className='flex items-center justify-between gap-1 px-1 pb-1'>
        <div className='inline-flex items-center gap-1'>
          <Icon name='project-excalidraw-top-enhance-icon' width={18} height={15} color='var(--color-icon-base)' />
          <span className='text-sm font-bold text-text-default-base'>Upscale</span>
        </div>
        <button type='button' className={iconBtnClass} onClick={onClose} aria-label='Close upscale toolbar'>
          <Icon name='imageEditor-multi-angle-close-icon' width={18} height={18} />
        </button>
      </div>

      {promptEnabled && (
        <div className='flex'>
          <textarea
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            placeholder='details to preserve or recover'
            className='h-[96px] w-full resize-none rounded-[8px] border border-border-default-base bg-transparent px-2 py-1.5 text-[13px] text-text-default-base outline-none placeholder:text-text-default-tertiary'
          />
        </div>
      )}

      <div className='mt-3 flex items-center justify-between gap-3 px-1'>
        <div className='flex min-w-0 flex-1 flex-wrap items-center gap-x-4 gap-y-2 text-[13px] font-semibold text-text-default-base'>
          <Dropdown
            trigger='click'
            placement='top-start'
            offset={8}
            items={resolutionMenuItems}
            selectedKeys={[resolution]}
            open={menuOpen}
            onOpenChange={setMenuOpen}
            onClick={(key) => setResolution(String(key) as UpscaleResolution)}
            popupClassName='rounded-[6px] border border-border-default-base p-1 shadow-[0px_8px_24px_-8px_rgba(12,12,13,0.25)]'
            itemClassName='h-8 px-2'
          >
            <button
              type='button'
              className='px-1 nodrag nopan inline-flex h-[28px] items-center rounded-[6px] bg-background-default-base hover:bg-background-default-base-hover'
            >
              <span className='pr-2 text-[13px] font-semibold text-text-default-base'>{resolutionLabelMap[resolution]}</span>
              <span
                className={cn(
                  'ml-auto flex shrink-0 items-center justify-center transition-transform duration-200',
                  menuOpen ? 'rotate-180' : '',
                )}
              >
                <Icon name='base-chevron-down-icon' width={10} height={10} color='var(--color-icon-base)' />
              </span>
            </button>
          </Dropdown>
          <span>Prompt</span>
          <button
            type='button'
            className={cn(
              'relative inline-flex h-4 w-7 items-center rounded-full transition-colors',
              promptEnabled ? 'bg-[#2FB344]' : 'bg-[#D8D8D8]',
            )}
            onClick={() => setPromptEnabled((v) => !v)}
            aria-label='Toggle prompt'
          >
            <span
              className={cn(
                'inline-block h-3 w-3 transform rounded-full bg-white transition-transform',
                promptEnabled ? 'translate-x-3.5' : 'translate-x-0.5',
              )}
            />
          </button>
        </div>
        <div className='flex items-center gap-1'>
          <div className='inline-flex items-center gap-1 text-[12px] font-semibold text-text-default-tertiary'>
            <Icon name='imageEditor-nano-banana-credit-icon' width={16} height={16} />
            <span>120</span>
          </div>
          <Tooltip title='Run Upscale' placement='top' offset={4}>
            <Button
              type='primary'
              size='medium'
              shape='round'
              className='!h-[28px] !w-[52px] !min-w-[52px] !py-[2px] !pl-[16px] !pr-[12px] !bg-[#2FB344] !border-[#2FB344] hover:!bg-[#28A13D] hover:!border-[#28A13D] disabled:!bg-[#D8D8D8] disabled:!border-[#D8D8D8]'
              icon={<Icon name='project-chat-send-icon' width={18} height={16} color='#fff' />}
              onClick={() => onSend({ resolution, promptEnabled, prompt })}
              aria-label='Send upscale'
            />
          </Tooltip>
        </div>
      </div>
    </div>
  );
};

export default UpscaleBottomToolbar;

