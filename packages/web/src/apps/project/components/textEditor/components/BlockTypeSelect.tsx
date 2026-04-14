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
  RiCodeBoxLine,
} from 'react-icons/ri';
import { BlockHighlightIcon, BlockTaskListIcon } from './TextEditorIcons';

type BlockTypeKey =
  | 'paragraph'
  | 'h1'
  | 'h2'
  | 'h3'
  | 'bulletList'
  | 'orderedList'
  | 'taskList'
  | 'codeBlock'
  | 'blockquote'
  | 'highlight';

type BlockIcon = React.ComponentType<{ size?: number; className?: string }>;

export type BlockTypeItem = {
  key: BlockTypeKey;
  label: string;
  icon: BlockIcon;
  isActive: (editor: Editor) => boolean;
  command: (editor: Editor) => void;
};

const BLOCK_TYPES: BlockTypeItem[] = [
  {
    key: 'paragraph',
    label: 'Paragraph',
    icon: RiText,
    isActive: (e) => e.isActive('paragraph'),
    command: (e) => e.chain().focus().setParagraph().run(),
  },
  {
    key: 'h1',
    label: 'Heading 1',
    icon: RiH1,
    isActive: (e) => e.isActive('heading', { level: 1 }),
    command: (e) => e.chain().focus().setHeading({ level: 1 }).run(),
  },
  {
    key: 'h2',
    label: 'Heading 2',
    icon: RiH2,
    isActive: (e) => e.isActive('heading', { level: 2 }),
    command: (e) => e.chain().focus().setHeading({ level: 2 }).run(),
  },
  {
    key: 'h3',
    label: 'Heading 3',
    icon: RiH3,
    isActive: (e) => e.isActive('heading', { level: 3 }),
    command: (e) => e.chain().focus().setHeading({ level: 3 }).run(),
  },
  {
    key: 'bulletList',
    label: 'Bullet list',
    icon: RiListUnordered,
    isActive: (e) => e.isActive('bulletList'),
    command: (e) => e.chain().focus().toggleBulletList().run(),
  },
  {
    key: 'orderedList',
    label: 'Numbered list',
    icon: RiListOrdered,
    isActive: (e) => e.isActive('orderedList'),
    command: (e) => e.chain().focus().toggleOrderedList().run(),
  },
  {
    key: 'taskList',
    label: 'Task list',
    icon: BlockTaskListIcon,
    isActive: (e) => e.isActive('taskList'),
    command: (e) => e.chain().focus().toggleTaskList().run(),
  },
  {
    key: 'codeBlock',
    label: 'Code block',
    icon: RiCodeBoxLine,
    isActive: (e) => e.isActive('codeBlock'),
    command: (e) => e.chain().focus().toggleCodeBlock().run(),
  },
  {
    key: 'blockquote',
    label: 'Quote',
    icon: RiDoubleQuotesL,
    isActive: (e) => e.isActive('blockquote'),
    command: (e) => e.chain().focus().toggleBlockquote().run(),
  },
  {
    key: 'highlight',
    label: 'Highlight block',
    icon: BlockHighlightIcon,
    isActive: (e) => e.isActive('highlight'),
    command: (e) =>
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (e.chain().focus() as any).toggleHighlight().run(),
  },
];

/** First match wins: structural / list types before plain paragraph vs highlight-only. */
const RESOLUTION_ORDER: BlockTypeKey[] = [
  'codeBlock',
  'blockquote',
  'taskList',
  'bulletList',
  'orderedList',
  'h1',
  'h2',
  'h3',
  'highlight',
  'paragraph',
];

const byKey = new Map(BLOCK_TYPES.map((t) => [t.key, t]));

function resolveCurrentBlock(editor: Editor): BlockTypeItem {
  for (const key of RESOLUTION_ORDER) {
    const t = byKey.get(key);
    if (t?.isActive(editor)) return t;
  }
  return BLOCK_TYPES[0];
}

export type BlockTypeSelectProps = {
  editor: Editor;
};

const BlockTypeSelect = ({ editor }: BlockTypeSelectProps) => {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);

  const current = resolveCurrentBlock(editor);
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
          className='flex h-8 max-w-[220px] shrink-0 cursor-pointer items-center gap-2.5 rounded-[6px] border-0 px-2.5 text-icon-base transition-colors hover:bg-background-default-base-hover'
        >
          <span className='inline-flex shrink-0'>
            <Icon size={16} />
          </span>
          <span className='min-w-0 flex-1 truncate text-left text-[14px] leading-none text-text-default-base'>
            {current.label}
          </span>
          <RiArrowDropDownLine
            size={16}
            className='shrink-0 text-icon-base'
            style={{
              transition: 'transform 0.15s',
              transform: open ? 'rotate(180deg)' : 'rotate(0deg)',
            }}
          />
        </button>
      </Tooltip>

      {open && (
        <div className='absolute left-0 top-full z-[91] mt-1 min-w-[200px] rounded-[8px] border border-border-default-base bg-background-default-base py-1 shadow-[0px_8px_24px_-8px_rgba(12,12,13,0.25)]'>
          {BLOCK_TYPES.map((t) => {
            const BtIcon = t.icon;
            const isActive = t.isActive(editor);
            return (
              <button
                key={t.key}
                type='button'
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => {
                  t.command(editor);
                  setOpen(false);
                }}
                className={[
                  'flex min-h-8 w-full cursor-pointer items-center gap-2.5 border-0 px-2.5 py-1.5 text-left text-[13px] text-text-default-base transition-colors',
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
