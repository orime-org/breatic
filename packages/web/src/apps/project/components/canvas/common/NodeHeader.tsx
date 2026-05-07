import React, { useRef, useState, useEffect, memo, useMemo } from 'react';
import { useViewport } from '@xyflow/react';
import { Icon } from '@/ui/icon';
import { useCanvasActions } from '@/hooks/useCanvasActions';
import { useNodeData } from '@/hooks/useNodeData';
import nodeIconMap from '@/apps/project/constants/nodeIconMap';
import type { CanvasWorkflowNodeData } from '@/apps/project/components/canvas/types';

interface NodeHeaderProps {
  nodeId: string;
  title?: string;
  anchorRef?: React.RefObject<HTMLDivElement | null>;
  editable?: boolean;
  onTitleChange?: (value: string) => void;
}

const NodeHeader: React.FC<NodeHeaderProps> = ({ nodeId, title, anchorRef, editable = false, onTitleChange }) => {
  const internalAnchorRef = useRef<HTMLDivElement>(null);
  const { zoom } = useViewport();
  const { updateNode } = useCanvasActions();
  // Use font-size to compensate for canvas zoom, visually ~12px; min 12px, max 28px, scale up moderately when canvas shrinks but not too large
  const fontSize = Math.max(12, Math.min(12 / zoom, 44));
  const iconSize = Math.max(12, Math.min(16 / zoom, 44));
  const [isTitleEditable, setIsTitleEditable] = useState(false);
  const titleInputRef = useRef<HTMLDivElement>(null);
  const lastExternalTitleRef = useRef<string | undefined>(title);

  // Use fine-grained selector
  const currentNode = useNodeData(nodeId);

  const nodeDataName = useMemo(() => {
    const n = (currentNode?.data as CanvasWorkflowNodeData | undefined)?.name;
    return typeof n === 'string' ? n : '';
  }, [currentNode?.data]);

  const displayTitle = nodeDataName || title || '';
  const [localTitle, setLocalTitle] = useState(displayTitle);

  // Update localTitle when data.name or title prop changes (skip in edit mode to avoid disrupting user input)
  useEffect(() => {
    if (isTitleEditable) return; // Skip in edit mode to avoid disrupting user input
    const newTitle = nodeDataName || title || '';
    if (newTitle !== localTitle) {
      setLocalTitle(newTitle);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nodeDataName, title, currentNode, isTitleEditable]);

  // Write `data.name` when title prop changes and data.name is still empty (default display name)
  useEffect(() => {
    if (title && !nodeDataName && title !== lastExternalTitleRef.current) {
      lastExternalTitleRef.current = title;
      updateNode(nodeId, {
        data: { name: title },
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [title, nodeId, nodeDataName]);

  // Set div content when entering edit mode (set once on entry only, to avoid cursor reset on input)
  useEffect(() => {
    if (isTitleEditable && titleInputRef.current) {
      titleInputRef.current.textContent = localTitle;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isTitleEditable]); // Remove localTitle dep to avoid cursor position reset on input

  /**
   * Get node icon path
   * Looks up nodeIconMap using the node's type
   * Cached with useMemo
   */
  const nodeIconSrc = useMemo(() => {
    const nodeType = currentNode?.type;
    if (nodeType) {
      return nodeIconMap[nodeType] || '';
    }
    return '';
  }, [currentNode?.type]);

  // Handle title double-click event, enter edit mode
  const handleTitleDoubleClick = (e: React.MouseEvent<HTMLDivElement>) => {
    if (!editable) return;
    e.stopPropagation();
    setIsTitleEditable(true);
    requestAnimationFrame(() => {
      const div = titleInputRef.current;
      if (div) {
        div.focus();
        // Select all text
        const range = document.createRange();
        range.selectNodeContents(div);
        const selection = window.getSelection();
        selection?.removeAllRanges();
        selection?.addRange(range);
      }
    });
  };

  // Handle title blur event, exit edit mode and save content
  const handleTitleBlur = (e: React.FocusEvent<HTMLDivElement>) => {
    const value = e.currentTarget.textContent || '';
    setLocalTitle(value);
    updateNode(nodeId, {
      data: { name: value },
    });
    onTitleChange?.(value);
    setIsTitleEditable(false);
    // Scroll to start after canceling input
    e.currentTarget.scrollLeft = 0;
  };

  // Handle title keyboard events
  const handleTitleKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      (e.target as HTMLDivElement).blur();
    } else if (e.key === 'Escape') {
      (e.target as HTMLDivElement).blur();
    }
  };

  // Handle title content change event (in edit mode only update local state, not store, to avoid cursor reset)
  const handleTitleInput = (e: React.FormEvent<HTMLDivElement>) => {
    const value = e.currentTarget.textContent || '';
    setLocalTitle(value);
    // In edit mode, do not sync to store in real-time; sync only on blur to avoid cursor position reset
    onTitleChange?.(value);
  };

  return (
    <>
      {/* Title: wrapped by parent node in FlowNodeToolbar so it is not affected by canvas zoom */}
      <div className='min-h-[30px] mb-2 min-w-0 max-w-[380px] flex-1 flex items-center hover:cursor-grab active:cursor-grabbing border-border-utilities-selected'>
        {/* Icon */}
        <div className='h-full flex items-center justify-center mt-[1px] text-op-text-1 px-1'>
          {nodeIconSrc && <Icon name={nodeIconSrc} width={iconSize} height={iconSize} color='var(--color-icon-base)' />}
        </div>
        {editable ? (
          <div
            ref={titleInputRef}
            contentEditable={isTitleEditable}
            suppressContentEditableWarning
            style={{ fontSize }}
            className={
              'font-bold text-text-default-base bg-transparent outline-none py-[2px] px-[4px] inline-block max-w-full truncate w-fit text-left ' +
              (isTitleEditable
                ? 'nodrag select-text border border-transparent focus:border-border-utilities-selected rounded-[4px] whitespace-nowrap overflow-hidden selection:bg-background-success-secondary selection:text-white'
                : 'hover:cursor-grab active:cursor-grabbing select-none border-0')
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
            className='inline-block max-w-full truncate w-fit text-left font-bold text-text-default-base pl-[4px]'
            style={{ fontSize }}
          >
            {displayTitle}
          </div>
        )}
      </div>
      {!anchorRef && <div ref={internalAnchorRef} className='hidden' />}
    </>
  );
};

export default memo(NodeHeader);
