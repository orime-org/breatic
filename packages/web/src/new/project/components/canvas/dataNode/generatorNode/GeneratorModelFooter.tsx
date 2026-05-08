/**
 * Shared generator footer row — optional category dropdown (audio modes), model pill, credits, send.
 */
import React from 'react';
import { Icon } from '@/components/base/icon';
import { Button } from '@/components/base/button';
import Dropdown, { type MenuItemType } from '@/components/base/dropdown';
import CustomPopover from '@/components/base/popover';

export type GeneratorModelFooterProps = {
  /** When false (text / image / video generators), the mode dropdown is omitted — only audio keeps it. */
  showCategoryDropdown?: boolean;
  categoryMenuItems: MenuItemType[];
  categoryDisplayLabel: string;
  onCategorySelect: (key: string) => void;
  modelPillSummary: string;
  modelPanelOpen: boolean;
  onModelPanelOpenChange: (open: boolean) => void;
  modelPanelContent: React.ReactNode;
  creditEstimate: number;
  sendDisabled: boolean;
  onSend: () => void;
  /** Optional test id / aria for send */
  sendAriaLabel?: string;
};

/**
 * @param props - Footer controls for local generator nodes (`gen1001`–`gen1004`) and audio dock.
 */
const GeneratorModelFooter: React.FC<GeneratorModelFooterProps> = ({
  showCategoryDropdown = true,
  categoryMenuItems,
  categoryDisplayLabel,
  onCategorySelect,
  modelPillSummary,
  modelPanelOpen,
  onModelPanelOpenChange,
  modelPanelContent,
  creditEstimate,
  sendDisabled,
  onSend,
  sendAriaLabel = 'Generate',
}) => (
  <div className='nodrag nopan flex w-full min-h-[40px] items-center gap-1.5'>
    {showCategoryDropdown ? (
      <Dropdown
        trigger='click'
        placement='top-start'
        offset={8}
        items={categoryMenuItems}
        onClick={(key) => onCategorySelect(String(key))}
        popupClassName='rounded-[8px] border border-border-default-base shadow-[0px_8px_24px_-8px_rgba(12,12,13,0.25)]'
        itemClassName='min-h-8 px-2 py-1.5'
      >
        <button
          type='button'
          className='inline-flex h-9 max-w-[100px] shrink-0 items-center gap-1 rounded-[6px] bg-[#F3F3F3] px-2.5 text-[13px] font-medium text-text-default-base hover:bg-[#EBEBEB]'
        >
          <span className='min-w-0 truncate'>{categoryDisplayLabel}</span>
          <Icon name='base-chevron-down-icon' width={10} height={10} color='var(--color-icon-base)' />
        </button>
      </Dropdown>
    ) : null}

    <CustomPopover
      className='z-[600] min-w-0 w-max max-w-[calc(100%-8rem)]'
      trigger='click'
      position='top'
      open={modelPanelOpen}
      onOpenChange={onModelPanelOpenChange}
      popupClassName='border-0 bg-transparent p-0 shadow-none'
      htmlContent={modelPanelContent}
      btnElement={
        <button
          type='button'
          className='inline-flex h-9 min-h-9 max-w-full items-center gap-2 rounded-full border border-[#E0E0E0] bg-white px-2.5 text-left text-[13px] leading-snug text-text-default-base shadow-none hover:bg-[#FAFAFA]'
        >
          <span className='flex h-6 w-6 shrink-0 items-center justify-center rounded-[4px] border border-[#E8E8E8] bg-[#F7F7F7]'>
            <Icon name='videoNode-adjust' width={12} height={12} color='var(--color-icon-base)' />
          </span>
          <span className='min-w-0 shrink truncate'>{modelPillSummary}</span>
        </button>
      }
    />

    <div className='ml-auto flex shrink-0 items-center gap-1.5'>
      <div className='flex shrink-0 items-center gap-0.5 tabular-nums text-[13px] font-medium text-text-default-base'>
        <Icon name='imageEditor-nano-banana-credit-icon' width={16} height={16} />
        <span>{creditEstimate}</span>
      </div>

      <Button
        type='primary'
        size='medium'
        shape='round'
        disabled={sendDisabled}
        aria-label={sendAriaLabel}
        icon={<Icon name='project-chat-send-icon' width={18} height={16} color='#fff' />}
        onClick={() => {
          if (!sendDisabled) onSend();
        }}
        className='!h-9 w-[52px] shrink-0 !border-[#35C838] !bg-[#35C838] !py-[2px] !pl-[16px] !pr-[12px] hover:!border-[#35C838] hover:!bg-[#35C838] disabled:!border-[#CDCDCD] disabled:!bg-[#CDCDCD]'
      />
    </div>
  </div>
);

export default GeneratorModelFooter;
