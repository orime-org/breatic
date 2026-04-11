import { useEffect, useRef, useState } from 'react';
import type { Editor } from '@tiptap/react';
import Tooltip from '@/components/base/tooltip';
import {
  RiH1,
  RiH2,
  RiH3,
  RiListUnordered,
  RiListOrdered,
  RiDoubleQuotesL,
  RiText,
  RiArrowDropDownLine,
} from 'react-icons/ri';

export type BlockTypeItem = {
  label: string;
  shortLabel: string;
  icon: React.ComponentType<{ size?: number }>;
  isActive: (editor: Editor) => boolean;
  command: (editor: Editor) => void;
};

const BLOCK_TYPES: BlockTypeItem[] = [
  {
    label: 'Text',
    shortLabel: 'Text',
    icon: RiText,
    isActive: (e) => e.isActive('paragraph'),
    command: (e) => e.chain().focus().setParagraph().run(),
  },
  {
    label: 'Heading 1',
    shortLabel: 'H1',
    icon: RiH1,
    isActive: (e) => e.isActive('heading', { level: 1 }),
    command: (e) => e.chain().focus().setHeading({ level: 1 }).run(),
  },
  {
    label: 'Heading 2',
    shortLabel: 'H2',
    icon: RiH2,
    isActive: (e) => e.isActive('heading', { level: 2 }),
    command: (e) => e.chain().focus().setHeading({ level: 2 }).run(),
  },
  {
    label: 'Heading 3',
    shortLabel: 'H3',
    icon: RiH3,
    isActive: (e) => e.isActive('heading', { level: 3 }),
    command: (e) => e.chain().focus().setHeading({ level: 3 }).run(),
  },
  {
    label: 'Bullet List',
    shortLabel: 'List',
    icon: RiListUnordered,
    isActive: (e) => e.isActive('bulletList'),
    command: (e) => e.chain().focus().toggleBulletList().run(),
  },
  {
    label: 'Numbered List',
    shortLabel: 'Num',
    icon: RiListOrdered,
    isActive: (e) => e.isActive('orderedList'),
    command: (e) => e.chain().focus().toggleOrderedList().run(),
  },
  {
    label: 'Quote',
    shortLabel: 'Quote',
    icon: RiDoubleQuotesL,
    isActive: (e) => e.isActive('blockquote'),
    command: (e) => e.chain().focus().toggleBlockquote().run(),
  },
];

export type BlockTypeSelectProps = {
  editor: Editor;
};

const BlockTypeSelect = ({ editor }: BlockTypeSelectProps) => {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);

  const current = BLOCK_TYPES.find((t) => t.isActive(editor)) ?? BLOCK_TYPES[0];
  const Icon = current.icon;

  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (wrapRef.current?.contains(e.target as Node)) return;
      setOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  return (
    <div ref={wrapRef} className='relative'>
      <Tooltip title='Block format' placement='top' offset={4}>
        <button
          type='button'
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => setOpen((v) => !v)}
          className='flex h-8 shrink-0 cursor-pointer items-center gap-1 rounded-[6px] border-0 px-[8px] text-icon-base transition-colors hover:bg-background-default-base-hover'
        >
          <Icon size={16} />
          <span className='whitespace-nowrap text-[14px] leading-none text-text-default-base'>{current.shortLabel}</span>
          <RiArrowDropDownLine
            size={16}
            className='text-icon-base'
            style={{
              transition: 'transform 0.15s',
              transform: open ? 'rotate(180deg)' : 'rotate(0deg)',
            }}
          />
        </button>
      </Tooltip>

      {open && (
        <div className='absolute left-0 top-full z-[9999] mt-1 min-w-[152px] rounded-[8px] border border-border-default-base bg-background-default-base py-1 shadow-[0px_8px_24px_-8px_rgba(12,12,13,0.25)]'>
          {BLOCK_TYPES.map((t) => {
            const BtIcon = t.icon;
            const isActive = t.isActive(editor);
            return (
              <button
                key={t.label}
                type='button'
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => {
                  t.command(editor);
                  setOpen(false);
                }}
                className={[
                  'flex min-h-8 w-full cursor-pointer items-center gap-1 border-0 px-2 py-1.5 text-left text-[13px] text-text-default-base transition-colors',
                  isActive
                    ? 'bg-background-default-secondary font-medium'
                    : 'bg-transparent hover:bg-background-default-secondary',
                ].join(' ')}
              >
                <span className='inline-flex shrink-0 text-icon-base'>
                  <BtIcon size={16} />
                </span>
                {t.label}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
};

export default BlockTypeSelect;
