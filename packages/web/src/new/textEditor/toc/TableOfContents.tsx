import { useCallback, useEffect, useRef, useState } from 'react';
import type { Editor } from '@tiptap/react';
import { RiMenuFoldLine, RiMenuUnfoldLine } from 'react-icons/ri';
import Tooltip from '@/components/base/tooltip';
import { TocNodeItem } from '@/apps/project/components/textEditor/toc/TocNodeItem';
import type { TocHeading, TocNode } from '@/apps/project/components/textEditor/types';

const extractHeadings = (editor: Editor): TocHeading[] => {
  const headings: TocHeading[] = [];
  editor.state.doc.forEach((node, offset) => {
    if (node.type.name === 'heading') {
      const level = node.attrs.level as number;
      if (level <= 3) {
        headings.push({
          level,
          text: node.textContent || `Heading ${level}`,
          pos: offset,
          id: `toc-${offset}`,
        });
      }
    }
  });
  return headings;
};

const buildTree = (headings: TocHeading[], collapsedSet: Set<string>): TocNode[] => {
  const roots: TocNode[] = [];
  const stack: TocNode[] = [];

  for (const heading of headings) {
    const node: TocNode = { heading, children: [], collapsed: collapsedSet.has(heading.id) };

    while (stack.length > 0 && stack[stack.length - 1].heading.level >= heading.level) {
      stack.pop();
    }

    if (stack.length === 0) {
      roots.push(node);
    } else {
      stack[stack.length - 1].children.push(node);
    }

    stack.push(node);
  }

  return roots;
};

interface TableOfContentsProps {
  editor: Editor;
}

const TableOfContents = ({ editor }: TableOfContentsProps) => {
  const [headings, setHeadings] = useState<TocHeading[]>([]);
  const [collapsedSet, setCollapsedSet] = useState<Set<string>>(new Set());
  const [panelCollapsed, setPanelCollapsed] = useState(false);
  const rafRef = useRef<number>(0);

  const refreshHeadings = useCallback(() => {
    if (rafRef.current) cancelAnimationFrame(rafRef.current);
    rafRef.current = requestAnimationFrame(() => {
      if (!editor.isDestroyed) {
        setHeadings(extractHeadings(editor));
      }
    });
  }, [editor]);

  useEffect(() => {
    refreshHeadings();
    editor.on('update', refreshHeadings);
    return () => {
      editor.off('update', refreshHeadings);
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
    };
  }, [editor, refreshHeadings]);

  const toggleCollapse = useCallback((id: string) => {
    setCollapsedSet((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const tree = buildTree(headings, collapsedSet);

  if (tree.length === 0) {
    return null;
  }

  if (panelCollapsed) {
    return (
      <div className='flex h-full w-14 shrink-0 flex-col items-stretch bg-background-default-secondary pt-12'>
        <div className='flex justify-start px-3 py-2'>
          <Tooltip title='展开目录' placement='right' offset={4}>
            <button
              type='button'
              className='flex size-8 shrink-0 items-center justify-center rounded text-text-default-tertiary transition-colors hover:bg-background-default-base hover:text-text-default-base'
              onClick={() => setPanelCollapsed(false)}
            >
              <RiMenuUnfoldLine size={15} className='shrink-0' />
            </button>
          </Tooltip>
        </div>
      </div>
    );
  }

  return (
    <div className='breatic-toc-panel flex h-full w-[200px] shrink-0 flex-col overflow-hidden bg-background-default-secondary pt-12'>
      <div className='flex items-center justify-start px-3 py-2'>
        <Tooltip title='收起目录' placement='top' offset={4}>
          <button
            type='button'
            className='flex size-8 shrink-0 items-center justify-center rounded text-text-default-tertiary transition-colors hover:bg-background-default-base hover:text-text-default-base'
            onClick={() => setPanelCollapsed(true)}
          >
            <RiMenuFoldLine size={14} className='shrink-0' />
          </button>
        </Tooltip>
      </div>

      <div className='flex-1 overflow-y-auto py-2'>
        {tree.map((node) => (
          <TocNodeItem
            key={node.heading.id}
            node={node}
            editor={editor}
            onToggleCollapse={toggleCollapse}
          />
        ))}
      </div>
    </div>
  );
};

export default TableOfContents;
