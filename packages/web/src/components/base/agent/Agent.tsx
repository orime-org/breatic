import React, { memo, useState } from 'react';
import { cn } from '@/utils/classnames';
import { Checkbox } from '@/components/base/checkbox';
import { Icon } from '@/components/base/icon';
import { Button } from '@/components/base/button';
import CustomPopover from '@/components/base/popover';

export interface AgentItem {
  id: string;
  label: string;
  /** Row checkbox state */
  selected?: boolean;
  /** Show enabled badge; default true */
  enabled?: boolean;
}

export interface AgentProps {
  disabled?: boolean;
  title?: string;
  /** Rows; falls back to built-in list */
  items?: AgentItem[];
  onSelectionChange?: (id: string, selected: boolean) => void;
  onOpenChange?: (open: boolean) => void;
  className?: string;
}

const defaultItems: AgentItem[] = [
  { id: '1', label: 'Seeking inspiration', enabled: true },
  { id: '2', label: 'Text-to-Images', enabled: true },
  { id: '3', label: 'Images-to-Images', enabled: true },
  { id: '4', label: 'Image Editing', enabled: true },
  { id: '5', label: 'Creating a film storyboard', enabled: true },
  { id: '6', label: 'Creating Character Portraits', enabled: true },
  { id: '7', label: 'Image Fusion', enabled: true },
  { id: '8', label: 'image Upscaling', enabled: true },
  { id: '9', label: 'Custom Illustration', enabled: true },
  { id: '10', label: 'Concept Art Development', enabled: true },
  { id: '11', label: '3D Model Texturing', enabled: true },
  { id: '12', label: 'Interactive Design Prototypes', enabled: true },
  { id: '13', label: 'Virtual Environment Creation', enabled: true },
  { id: '14', label: 'Animation and Motion Graphics', enabled: true },
];

const AgentContent: React.FC<{
  title: string;
  items: AgentItem[];
  selectedIds: Set<string>;
  onCheck: (id: string, checked: boolean) => void;
  onSelectionChange?: (id: string, selected: boolean) => void;
  className?: string;
}> = ({ title, items, selectedIds, onCheck, onSelectionChange, className }) => (
  <div
    className={cn(
      'min-w-[220px] max-w-[320px] max-h-[320px] overflow-hidden flex flex-col rounded-lg border border-[var(--color-border-default-base)] bg-[var(--color-background-default-base)] shadow-lg',
      className
    )}
  >
    <div className='flex items-center gap-2 px-3 py-2.5 shrink-0'>
      <span className='text-text-default-base text-xs font-bold'>{title}</span>
    </div>
    <ul className='flex flex-col overflow-y-auto p-1'>
      {items.map((item) => {
        const checked = item.selected !== undefined ? item.selected : selectedIds.has(item.id);
        return (
          <li key={item.id}>
            <label
              className={cn(
                'flex items-center gap-2 w-full cursor-pointer rounded-md px-2 py-2 text-left',
                'hover:bg-[var(--color-background-default-secondary)]'
              )}
              onClick={() => {
                onCheck(item.id, !checked);
                onSelectionChange?.(item.id, !checked);
              }}
            >
              <span className='flex-1 min-w-0 text-text-default-base text-xs font-bold truncate'>
                {item.label}
              </span>
              <span onClick={(e) => e.stopPropagation()}>
                <Checkbox
                  checked={checked}
                  onChange={(e) => {
                    onCheck(item.id, e.target.checked);
                    onSelectionChange?.(item.id, e.target.checked);
                  }}
                  size='small'
                  type='outlined'
                  className='shrink-0 !border-[var(--color-text-default-base)]'
                />
              </span>
            </label>
          </li>
        );
      })}
    </ul>
  </div>
);

const AgentComponent: React.FC<AgentProps> = ({
  disabled = false,
  title = 'Image generation',
  items = defaultItems,
  onSelectionChange,
  onOpenChange,
  className,
}) => {
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());

  const handleCheck = (id: string, checked: boolean) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (checked) next.add(id);
      else next.delete(id);
      return next;
    });
  };

  return (
    <CustomPopover
      trigger='click'
      position='top-start'
      onOpenChange={onOpenChange}
      htmlContent={<AgentContent title={title} items={items} selectedIds={selectedIds} onCheck={handleCheck} onSelectionChange={onSelectionChange} className={className} />}
      popupClassName='p-0 min-w-0 max-w-[320px]'
      btnElement={
        <Button
          type='dark'
          shape='round'
          disabled={disabled}
          className='!h-[28px] gap-1.5'
          aria-label='Agent'
        >
          <Icon name='project-chat-skills-icon' width={17} height={16} />
          Agent
        </Button>
      }
      disabled={disabled}
    />
  );
};

export const Agent = memo(AgentComponent);
export default Agent;
