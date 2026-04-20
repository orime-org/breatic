import React from 'react';
import { Icon } from '@/components/base/icon';
import Tooltip from '@/components/base/tooltip';
import Dropdown, { type MenuItemType } from '@/components/base/dropdown';
import Divider from '@/components/base/divider';

export type ToolbarProps = {
  nodeId: string;
  onCut?: (nodeId: string) => void;
};

const iconColor = 'var(--color-icon-base)';

type IconToolbarItem = { key: string; label: string; icon: string; w: number; h: number };

const dividerClass = 'mx-[2px] h-[18px]';

const Toolbar: React.FC<ToolbarProps> = ({ nodeId, onCut }) => {
  const mainActionsAfterQuickEdit: IconToolbarItem[] = [
    { key: 'cut', label: 'Cut', icon: 'videoNode-cut', w: 20, h: 21 },
    { key: 'speed', label: 'Speed', icon: 'videoNode-speed', w: 22, h: 18 },
    { key: 'upscale', label: 'Upscale', icon: 'videoNode-upscale-hd', w: 22, h: 18 },
    { key: 'interpolate', label: 'Interpolate', icon: 'videoNode-interpolate', w: 22, h: 20 },
    { key: 'erase', label: 'Erase', icon: 'videoNode-erase', w: 20, h: 20 },
    { key: 'extend', label: 'Extend', icon: 'videoNode-extend', w: 20, h: 20 },
  ];

  const moreItems: MenuItemType[] = [
    {
      key: 'stabilize',
      label: (
        <div className='flex items-center gap-1'>
          <Icon name='videoNode-speed' width={16} height={14} color={iconColor} />
          <span className='text-[13px] text-text-default-base'>Stabilize</span>
        </div>
      ),
    },
    {
      key: 'caption',
      label: (
        <div className='flex items-center gap-1'>
          <Icon name='videoNode-interpolate' width={16} height={14} color={iconColor} />
          <span className='text-[13px] text-text-default-base'>Captions</span>
        </div>
      ),
    },
  ];

  return (
    <div
      className='pointer-events-auto flex items-center gap-0 rounded-[8px] border border-border-default-base bg-background-default-base px-[6px] py-[4px] shadow-[0px_1px_4px_0px_rgba(12,12,13,0.05),0px_1px_8px_1px_rgba(12,12,13,0.05)]'
      onMouseDown={(e) => e.stopPropagation()}
    >
      <Tooltip title='Quick Edit' placement='top' offset={4}>
        <button
          type='button'
          className='flex h-8 shrink-0 items-center gap-1 rounded-[6px] px-[8px] text-icon-base transition-colors hover:bg-background-default-base-hover'
        >
          <Icon name='project-excalidraw-top-quick-edit-icon' width={18} height={18} color={iconColor} />
          <span className='whitespace-nowrap text-[14px] leading-none text-text-default-base'>Quick Edit</span>
        </button>
      </Tooltip>
      <Divider type='vertical' className={dividerClass} />
      {mainActionsAfterQuickEdit.map((item) => (
        <Tooltip key={item.key} title={item.label} placement='top' offset={4}>
          <button
            type='button'
            className='flex h-8 shrink-0 items-center gap-1 rounded-[6px] px-[8px] text-icon-base transition-colors hover:bg-background-default-base-hover'
            onClick={() => {
              if (item.key === 'cut') onCut?.(nodeId);
            }}
          >
            <Icon name={item.icon} width={item.w} height={item.h} color={iconColor} />
            <span className='whitespace-nowrap text-[14px] leading-none text-text-default-base'>{item.label}</span>
          </button>
        </Tooltip>
      ))}
      <Divider type='vertical' className={dividerClass} />
      <Dropdown
        trigger='click'
        placement='bottom-end'
        offset={6}
        items={moreItems}
        onClick={() => {}}
        popupClassName='rounded-[8px] border border-border-default-base shadow-[0px_8px_24px_-8px_rgba(12,12,13,0.25)]'
        itemClassName='min-h-8 px-2 py-1.5'
      >
        <Tooltip title='More' placement='top' offset={4}>
          <button
            type='button'
            className='flex h-8 w-8 items-center justify-center rounded-[6px] text-icon-base transition-colors hover:bg-background-default-base-hover'
          >
            <Icon name='project-excalidraw-top-more-icon' width={4} height={16} color={iconColor} />
          </button>
        </Tooltip>
      </Dropdown>
    </div>
  );
};

export default Toolbar;
