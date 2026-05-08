/**
 * Compact model list for text / image / video generator footers (non-audio).
 */
import React from 'react';
import { cn } from '@/utils/classnames';

export type SimpleModelPickerPanelProps = {
  title?: string;
  options: string[];
  selected: string;
  onSelect: (label: string) => void;
};

const SimpleModelPickerPanel: React.FC<SimpleModelPickerPanelProps> = ({
  title = 'Model',
  options,
  selected,
  onSelect,
}) => (
  <div className='w-[260px] rounded-[12px] border border-[var(--color-border-default-base)] bg-background-default-base p-3 shadow-[0px_8px_24px_-8px_rgba(12,12,13,0.18)]'>
    <div className='pb-2 text-[12px] font-semibold text-text-default-base'>{title}</div>
    <ul className='max-h-[200px] overflow-auto'>
      {options.map((opt) => (
        <li key={opt}>
          <button
            type='button'
            className={cn(
              'nodrag nopan w-full rounded-[8px] px-2 py-2 text-left text-[13px] transition-colors',
              selected === opt
                ? 'bg-background-default-secondary font-medium text-text-default-base'
                : 'text-text-default-base hover:bg-background-default-secondary',
            )}
            onMouseDown={(e) => e.stopPropagation()}
            onClick={() => onSelect(opt)}
          >
            {opt}
          </button>
        </li>
      ))}
    </ul>
  </div>
);

export default SimpleModelPickerPanel;
