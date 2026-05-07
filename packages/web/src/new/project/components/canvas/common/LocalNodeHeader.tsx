import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useReactFlow, useViewport } from '@xyflow/react';
import { Icon } from '@/components/base/icon';
import nodeIconMap from '@/new/project/constants/nodeIconMap';
import type { LocalCanvasNodeData } from '@/new/project/types';

export interface LocalNodeHeaderProps {
  /** React Flow node id — required when `editable` is true. */
  nodeId: string;
  /** React Flow node `type` (e.g. `1001` … `1004`). */
  nodeType: string;
  /** Title shown beside the type icon (fallback when `data.name` is empty). */
  title: string;
  /** Double-click to edit title and persist `data.name` via `setNodes`. */
  editable?: boolean;
}

/**
 * Node title row (icon + label) for local-only canvases — same edit UX as {@link NodeHeader}
 * (double-click → contentEditable, blur / Enter saves `data.name`).
 */
const LocalNodeHeader: React.FC<LocalNodeHeaderProps> = ({ nodeId, nodeType, title, editable = true }) => {
  const { zoom } = useViewport();
  const { setNodes } = useReactFlow();
  const fontSize = Math.max(12, Math.min(12 / zoom, 44));
  const iconSize = Math.max(12, Math.min(16 / zoom, 44));

  const [isTitleEditable, setIsTitleEditable] = useState(false);
  const titleInputRef = useRef<HTMLDivElement>(null);
  const [localTitle, setLocalTitle] = useState(title);

  useEffect(() => {
    if (isTitleEditable) return;
    if (title !== localTitle) setLocalTitle(title);
  }, [title, isTitleEditable, localTitle]);

  /** Set div content when entering edit mode only (avoid resetting cursor while typing). */
  useEffect(() => {
    if (isTitleEditable && titleInputRef.current) {
      titleInputRef.current.textContent = localTitle;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only on edit-mode entry; `localTitle` read once
  }, [isTitleEditable]);

  const nodeIconSrc = useMemo(() => nodeIconMap[nodeType] ?? '', [nodeType]);

  const persistName = useCallback(
    (value: string) => {
      setNodes((nodes) =>
        nodes.map((n) => {
          if (n.id !== nodeId) return n;
          const prev = (n.data ?? {}) as LocalCanvasNodeData;
          return { ...n, data: { ...prev, name: value } };
        }),
      );
    },
    [nodeId, setNodes],
  );

  const handleTitleDoubleClick = useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
      if (!editable) return;
      e.stopPropagation();
      setIsTitleEditable(true);
      requestAnimationFrame(() => {
        const div = titleInputRef.current;
        if (!div) return;
        div.focus();
        const range = document.createRange();
        range.selectNodeContents(div);
        const selection = window.getSelection();
        selection?.removeAllRanges();
        selection?.addRange(range);
      });
    },
    [editable],
  );

  const handleTitleBlur = useCallback(
    (e: React.FocusEvent<HTMLDivElement>) => {
      const value = e.currentTarget.textContent || '';
      setLocalTitle(value);
      persistName(value);
      setIsTitleEditable(false);
      e.currentTarget.scrollLeft = 0;
    },
    [persistName],
  );

  const handleTitleKeyDown = useCallback((e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      (e.target as HTMLDivElement).blur();
    } else if (e.key === 'Escape') {
      (e.target as HTMLDivElement).blur();
    }
  }, []);

  const handleTitleInput = useCallback((e: React.FormEvent<HTMLDivElement>) => {
    const value = e.currentTarget.textContent || '';
    setLocalTitle(value);
  }, []);

  return (
    <div className='mb-2 flex min-h-[30px] w-full min-w-0 max-w-full items-center border-border-utilities-selected hover:cursor-grab active:cursor-grabbing'>
      <div className='mt-[1px] flex h-full shrink-0 items-center justify-center px-1 text-op-text-1'>
        {nodeIconSrc ? <Icon name={nodeIconSrc} width={iconSize} height={iconSize} color='var(--color-icon-base)' /> : null}
      </div>
      {editable ? (
        <div
          ref={titleInputRef}
          contentEditable={isTitleEditable}
          suppressContentEditableWarning
          style={{ fontSize }}
          className={
            'min-w-0 flex-1 overflow-hidden py-[2px] pl-[4px] text-left font-bold text-text-default-base outline-none ' +
            (isTitleEditable
              ? 'nodrag select-text overflow-x-auto whitespace-nowrap rounded-[4px] border border-transparent selection:bg-background-success-secondary selection:text-white focus:border-border-utilities-selected'
              : 'select-none truncate border-0 hover:cursor-grab active:cursor-grabbing')
          }
          onDoubleClick={handleTitleDoubleClick}
          onBlur={handleTitleBlur}
          onKeyDown={handleTitleKeyDown}
          onInput={handleTitleInput}
        >
          {!isTitleEditable && localTitle}
        </div>
      ) : (
        <div
          className='min-w-0 flex-1 truncate pl-[4px] text-left font-bold text-text-default-base'
          style={{ fontSize }}
        >
          {localTitle}
        </div>
      )}
    </div>
  );
};

export default memo(LocalNodeHeader);
