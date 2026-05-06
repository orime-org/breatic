import { type ReactNode, useEffect, useRef, useState } from 'react';
import Tooltip from '@/components/base/tooltip';
import {
  RiArrowDropDownLine,
  RiContractUpDownLine,
  RiExchangeLine,
  RiExpandUpDownLine,
  RiPlayListAddLine,
  RiSparkling2Fill,
  RiSparkling2Line,
  RiTranslateAi,
} from 'react-icons/ri';

type QuickEntry = {
  key: string;
  label: string;
  icon: ReactNode;
  replacement: string;
};

const SELECTION_AI_QUICK_ACTIONS: QuickEntry[] = [
  { key: 'polish', label: 'Polish', icon: <RiSparkling2Line size={16} />, replacement: '[POLISH] This is fixed replacement content.' },
  { key: 'expand', label: 'Expand', icon: <RiExpandUpDownLine size={16} />, replacement: '[EXPAND] This is fixed replacement content.' },
  { key: 'summarize', label: 'Summarize', icon: <RiContractUpDownLine size={16} />, replacement: '[SUMMARIZE] This is fixed replacement content.' },
  { key: 'translate', label: 'Translate', icon: <RiTranslateAi size={16} />, replacement: '[TRANSLATE] This is fixed replacement content.' },
  { key: 'rewrite', label: 'Rewrite', icon: <RiExchangeLine size={16} />, replacement: '[REWRITE] This is fixed replacement content.' },
  { key: 'continue', label: 'Continue', icon: <RiPlayListAddLine size={16} />, replacement: '[CONTINUE] This is fixed replacement content.' },
];

const replacementByKey: Record<string, string> = Object.fromEntries(
  SELECTION_AI_QUICK_ACTIONS.map((a) => [a.key, a.replacement]),
);

export type ImproveMenuTriggerProps = {
  onQuickAction: (replacement: string) => void;
};

/** 与 `BlockTypeSelect` 相同的触发器与下拉面板样式（气泡工具栏内的 Improve）。 */
export function ImproveMenuTrigger({ onQuickAction }: ImproveMenuTriggerProps) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (wrapRef.current?.contains(e.target as Node)) return;
      setOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  const handlePickQuick = (key: string) => {
    const replacement = replacementByKey[key];
    if (replacement) onQuickAction(replacement);
    setOpen(false);
  };

  return (
    <div ref={wrapRef} className='relative'>
      <Tooltip title='Improve' placement='top' offset={4}>
        <button
          type='button'
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => setOpen((v) => !v)}
          className='flex h-8 max-w-[220px] shrink-0 cursor-pointer items-center gap-2.5 rounded-[6px] border-0 px-2.5 text-icon-base transition-colors hover:bg-background-default-base-hover'
          aria-haspopup='listbox'
          aria-expanded={open}
        >
          <span className='inline-flex shrink-0'>
            <RiSparkling2Fill size={16} />
          </span>
          <span className='min-w-0 flex-1 truncate text-left text-[14px] leading-none text-text-default-base'>Improve</span>
          <RiArrowDropDownLine
            size={16}
            className='shrink-0 text-icon-base'
            style={{
              transition: 'transform 0.15s',
              transform: open ? 'rotate(180deg)' : 'rotate(0deg)',
            }}
            aria-hidden
          />
        </button>
      </Tooltip>

      {open && (
        <div className='absolute left-0 top-full z-[91] mt-1 min-w-[200px] rounded-[8px] border border-border-default-base bg-background-default-base py-1 shadow-[0px_8px_24px_-8px_rgba(12,12,13,0.25)]'>
          {SELECTION_AI_QUICK_ACTIONS.map((item) => (
            <button
              key={item.key}
              type='button'
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => handlePickQuick(item.key)}
              className='flex min-h-8 w-full cursor-pointer items-center gap-2.5 border-0 bg-transparent px-2.5 py-1.5 text-left text-[13px] text-text-default-base transition-colors hover:bg-background-default-secondary'
            >
              <span className='inline-flex shrink-0 text-icon-base'>{item.icon}</span>
              {item.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
