import React, { useMemo, useState } from 'react';
import Dropdown, { type MenuItemType } from '@/ui/dropdown';
import { Icon } from '@/ui/icon';
import { cn } from '@/utils/classnames';

export type RecognizedPickOption = {
  key: string;
  label: string;
};

type RecognizedPickDropdownProps = {
  currentLabel?: string;
  options: RecognizedPickOption[];
  onSelect: (key: string) => void;
};

const RecognizedPickDropdown: React.FC<RecognizedPickDropdownProps> = ({ currentLabel, options, onSelect }) => {
  const [open, setOpen] = useState(false);
  const menuItems = useMemo<MenuItemType[]>(
    () =>
      options.map((item) => ({
        key: item.key,
        label: item.label?.trim() || '识别结果',
      })),
    [options],
  );

  const currentLabelTrimmed = currentLabel?.trim() ?? '';
  const matchedOption = options.find((item) => item.label === currentLabelTrimmed);
  const fallbackOption = options[0];
  const selectedKey = matchedOption?.key ?? fallbackOption?.key;
  const selectedLabel = matchedOption?.label ?? fallbackOption?.label ?? '识别结果';

  return (
    <div
      className='pointer-events-auto'
      onMouseDown={(e) => {
        e.preventDefault();
        e.stopPropagation();
      }}
      onClick={(e) => {
        e.preventDefault();
        e.stopPropagation();
      }}
    >
      <Dropdown
        trigger='click'
        open={open}
        onOpenChange={setOpen}
        placement='bottom-start'
        items={menuItems}
        selectedKeys={selectedKey ? [selectedKey] : []}
        onClick={(key) => onSelect(key)}
        popupClassName='!rounded-[12px] !bg-[var(--color-background-default-base)] !border !border-[var(--color-border-default-base)] !p-1 min-w-[132px]'
        itemClassName='!text-text-default-base !text-[12px] !leading-[18px] !px-3 !py-1.5 !rounded-[8px] hover:!bg-background-default-secondary'
        offset={6}
      >
        <button
          type='button'
          className='pointer-events-auto inline-flex max-w-[126px] min-w-0 items-center gap-1 rounded-full border border-[var(--color-border-default-base)] bg-[var(--color-background-default-secondary)] px-2 py-0.5 text-xs font-medium text-[var(--color-text-default-base)]'
        >
          <Icon
            name='project-excalidraw-top-quick-edit-icon'
            width={12}
            height={12}
            className='shrink-0 text-[var(--color-icon-base)]'
            color='currentColor'
          />
          <span className='truncate'>{selectedLabel}</span>
          <Icon
            name='base-chevron-down-icon'
            width={8}
            height={8}
            className={cn(
              'text-[var(--color-icon-base)] transition-transform duration-150',
              open ? 'rotate-0' : 'rotate-180',
            )}
            color='currentColor'
          />
        </button>
      </Dropdown>
    </div>
  );
};

export default RecognizedPickDropdown;
