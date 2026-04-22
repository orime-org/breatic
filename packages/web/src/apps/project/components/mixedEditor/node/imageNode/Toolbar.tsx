import React from 'react';
import { Icon } from '@/components/base/icon';
import Tooltip from '@/components/base/tooltip';
import Dropdown, { type MenuItemType } from '@/components/base/dropdown';
import Divider from '@/components/base/divider';

export type ToolbarProps = {
  nodeId: string;
  onReplace: (id: string, file: File) => void;
  onCrop: (id: string) => void;
  onExpand: (id: string) => void;
  onAdjust: (id: string) => void;
  onInpaint: (id: string) => void;
  onQuickEdit: (id: string) => void;
  onMark: (id: string) => void;
  onEnhance: (id: string) => void;
  onMultiAngle: (id: string) => void;
  onRelight: (id: string) => void;
  onGridSlice: (id: string) => void;
  onFlipRotate: (id: string) => void;
  onGraffiti: (id: string) => void;
};

const Toolbar: React.FC<ToolbarProps> = ({
  nodeId,
  onReplace: _onReplace,
  onCrop,
  onExpand,
  onAdjust,
  onInpaint,
  onQuickEdit,
  onMark,
  onEnhance,
  onMultiAngle,
  onRelight,
  onGridSlice,
  onFlipRotate,
  onGraffiti,
}) => {
  const actionItems = [
    { icon: 'project-excalidraw-top-quick-edit-icon', label: 'Quick Edit', width: 18, height: 18, key: 'quick-edit' },
    { icon: 'project-excalidraw-top-inpaint-icon', label: 'Inpaint', width: 18, height: 18, key: 'inpaint' },
    { icon: 'project-excalidraw-top-remove-bg-icon', label: 'Cutout', width: 17, height: 17, key: 'remove-bg' },
    { icon: 'project-excalidraw-top-erase-icon', label: 'Erase', width: 18, height: 18, key: 'eraser' },
    { icon: 'project-excalidraw-top-enhance-icon', label: 'Upscale', width: 18, height: 15, key: 'enhance' },
    { icon: 'project-excalidraw-top-multi-angle-icon', label: 'Multi-Angle', width: 20, height: 20, key: 'multi-angle' },
  ] as const;

  const moreItems: MenuItemType[] = [
    {
      key: 'mark',
      label: (
        <div className='flex items-center gap-1'>
          <Icon name='imageEditor-mark-title-icon' width={16} height={16} color='var(--color-icon-base)' />
          <span className='text-[13px] text-text-default-base'>Mark</span>
        </div>
      ),
    },
    {
      key: 'crop',
      label: (
        <div className='flex items-center gap-1'>
          <Icon name='project-image-editor-more-crop-icon' width={16} height={16} color='var(--color-icon-base)' />
          <span className='text-[13px] text-text-default-base'>Crop</span>
        </div>
      ),
    },
    {
      key: 'adjust',
      label: (
        <div className='flex items-center gap-1'>
          <Icon name='project-image-editor-more-adjust-icon' width={16} height={16} color='var(--color-icon-base)' />
          <span className='text-[13px] text-text-default-base'>Adjust</span>
        </div>
      ),
    },
    {
      key: 'expand',
      label: (
        <div className='flex items-center gap-1'>
          <Icon name='project-image-editor-more-expand-icon' width={16} height={16} color='var(--color-icon-base)' />
          <span className='text-[13px] text-text-default-base'>Expand</span>
        </div>
      ),
    },
    {
      key: 'retext',
      label: (
        <div className='flex items-center gap-1'>
          <Icon name='imageEditor-more-graffiti-icon' width={16} height={16} color='var(--color-icon-base)' />
          <span className='text-[13px] text-text-default-base'>Graffiti</span>
        </div>
      ),
    },
    {
      key: 'relight',
      label: (
        <div className='flex items-center gap-1'>
          <Icon name='project-image-editor-more-relight-icon' width={20} height={20} color='var(--color-icon-base)' />
          <span className='text-[13px] text-text-default-base'>Relight</span>
        </div>
      ),
    },
    {
      key: 'flip-rotate',
      label: (
        <div className='flex items-center gap-1'>
          <Icon name='imageEditor-more-flip-rotate-icon' width={16} height={16} color='var(--color-icon-base)' />
          <span className='text-[13px] text-text-default-base'>Flip & Rotate</span>
        </div>
      ),
    },
    {
      key: 'grid-slice',
      label: (
        <div className='flex items-center gap-1'>
          <Icon name='project-image-editor-more-grid-slice-icon' width={16} height={16} color='var(--color-icon-base)' />
          <span className='text-[13px] text-text-default-base'>Grid Slice</span>
        </div>
      ),
    },
  ];

  return (
    <div
      className='pointer-events-auto flex items-center gap-0 rounded-[8px] border border-border-default-base bg-background-default-base px-[6px] py-[4px] shadow-[0px_1px_4px_0px_rgba(12,12,13,0.05),0px_1px_8px_1px_rgba(12,12,13,0.05)]'
      onMouseDown={(e) => e.stopPropagation()}
    >
      {actionItems.map((item) => (
        <Tooltip key={item.icon} title={item.label} placement='top' offset={4}>
          <button
            type='button'
            className='flex h-8 shrink-0 items-center gap-1 rounded-[6px] px-[8px] text-icon-base transition-colors hover:bg-background-default-base-hover'
            onClick={() => {
              if (item.key === 'quick-edit') onQuickEdit(nodeId);
              if (item.key === 'inpaint') onInpaint(nodeId);
              if (item.key === 'enhance') onEnhance(nodeId);
              if (item.key === 'multi-angle') onMultiAngle(nodeId);
            }}
          >
            <Icon name={item.icon} width={item.width} height={item.height} color='var(--color-icon-base)' />
            <span className='whitespace-nowrap text-[14px] leading-none text-text-default-base'>{item.label}</span>
          </button>
        </Tooltip>
      ))}
      <Divider type='vertical' className='mx-[2px] h-[18px]' />
      <Dropdown
        trigger='click'
        placement='bottom-end'
        offset={6}
        items={moreItems}
        onClick={(key) => {
          if (key === 'mark') onMark(nodeId);
          if (key === 'crop') onCrop(nodeId);
          if (key === 'expand') onExpand(nodeId);
          if (key === 'adjust') onAdjust(nodeId);
          if (key === 'retext') onGraffiti(nodeId);
          if (key === 'relight') onRelight(nodeId);
          if (key === 'grid-slice') onGridSlice(nodeId);
          if (key === 'flip-rotate') onFlipRotate(nodeId);
        }}
        popupClassName='rounded-[8px] border border-border-default-base shadow-[0px_8px_24px_-8px_rgba(12,12,13,0.25)]'
        itemClassName='min-h-8 px-2 py-1.5'
      >
        <Tooltip title='More' placement='top' offset={4}>
          <button
            type='button'
            className='flex h-8 w-8 items-center justify-center rounded-[6px] text-icon-base transition-colors hover:bg-background-default-base-hover'
          >
            <Icon name='project-excalidraw-top-more-icon' width={4} height={16} color='var(--color-icon-base)' />
          </button>
        </Tooltip>
      </Dropdown>
    </div>
  );
};

export default Toolbar;
