import type { Editor } from '@tiptap/react';
import { TextSelection } from '@tiptap/pm/state';
import { RiArrowRightSFill } from 'react-icons/ri';
import { cn } from '@/utils/classnames';
import { BREATIC_SUPPRESS_FORMAT_BUBBLE_META } from '../extensions/formatBubbleSuppress';

export interface TocHeading {
  level: number;
  text: string;
  pos: number;
  id: string;
}

export interface TocNode {
  heading: TocHeading;
  children: TocNode[];
  collapsed: boolean;
}

const scrollToHeading = (editor: Editor, pos: number) => {
  try {
    const { state, view } = editor;
    const node = state.doc.nodeAt(pos);
    if (!node || node.type.name !== 'heading') return;

    const dom = view.nodeDOM(pos) as HTMLElement | null;
    const start = pos + 1;
    const end = pos + node.nodeSize - 1;
    const tr = state.tr.setSelection(TextSelection.create(state.doc, start, Math.max(start, end)));
    tr.setMeta(BREATIC_SUPPRESS_FORMAT_BUBBLE_META, true);
    view.dispatch(tr);

    if (dom) dom.scrollIntoView({ behavior: 'smooth', block: 'start' });
    view.focus();
  } catch {
    /* ignore */
  }
};

export interface TocNodeItemProps {
  node: TocNode;
  editor: Editor;
  onToggleCollapse: (id: string) => void;
  hidden?: boolean;
}

export function TocNodeItem({ node, editor, onToggleCollapse, hidden = false }: TocNodeItemProps) {
  const { heading, children, collapsed } = node;
  const hasChildren = children.length > 0;
  const indent = (heading.level - 1) * 12;

  if (hidden) return null;

  return (
    <>
      <div
        className={cn(
          'group flex items-center gap-1 rounded py-[3px] pr-2 cursor-pointer select-none',
          'hover:bg-background-default-base',
          'transition-colors duration-100',
        )}
        style={{ paddingLeft: `${indent + 8}px` }}
        onClick={() => scrollToHeading(editor, heading.pos)}
        title={heading.text}
      >
        {hasChildren ? (
          <button
            type='button'
            className={cn(
              'flex h-4 w-4 shrink-0 items-center justify-center rounded text-[#646A73] transition-opacity duration-150',
              'opacity-0 pointer-events-none group-hover:opacity-100 group-hover:pointer-events-auto',
              'group-focus-within:opacity-100 group-focus-within:pointer-events-auto',
            )}
            onClick={(e) => {
              e.stopPropagation();
              onToggleCollapse(heading.id);
            }}
            aria-label={collapsed ? 'Expand' : 'Collapse'}
          >
            <RiArrowRightSFill
              size={14}
              className='transition-transform duration-150 ease-out'
              style={{ transform: collapsed ? 'rotate(0deg)' : 'rotate(90deg)' }}
            />
          </button>
        ) : (
          <span className='h-4 w-4 shrink-0' />
        )}

        <span
          className={cn(
            'truncate text-[#646A73] transition-colors duration-100 leading-5',
            heading.level === 1 && 'text-[13px] font-bold',
            heading.level === 2 && 'text-[12px]',
            heading.level === 3 && 'text-[12px]',
          )}
        >
          {heading.text}
        </span>
      </div>

      {hasChildren &&
        children.map((child) => (
          <TocNodeItem
            key={child.heading.id}
            node={child}
            editor={editor}
            onToggleCollapse={onToggleCollapse}
            hidden={collapsed}
          />
        ))}
    </>
  );
}
