import React, { memo, useEffect, useRef, useState } from 'react';
import { useViewport } from '@xyflow/react';

type NodeHeaderProps = {
  title: string;
  resolutionText?: string;
  editable?: boolean;
  onTitleChange?: (value: string) => void;
};

const NodeHeader: React.FC<NodeHeaderProps> = ({ title, resolutionText, editable = false, onTitleChange }) => {
  const { zoom } = useViewport();
  // Counteract React Flow canvas scaling so header text keeps stable visual size.
  const safeZoom = Math.max(0.01, zoom);
  const fontSize = 12 / safeZoom;
  const [isTitleEditable, setIsTitleEditable] = useState(false);
  const [localTitle, setLocalTitle] = useState(title);
  const titleInputRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!isTitleEditable) setLocalTitle(title);
  }, [title, isTitleEditable]);

  useEffect(() => {
    if (isTitleEditable && titleInputRef.current) {
      titleInputRef.current.textContent = localTitle;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isTitleEditable]);

  const handleTitleDoubleClick = (e: React.MouseEvent<HTMLDivElement>) => {
    if (!editable) return;
    e.stopPropagation();
    setIsTitleEditable(true);
    requestAnimationFrame(() => {
      const div = titleInputRef.current;
      if (div) {
        div.focus();
        const range = document.createRange();
        range.selectNodeContents(div);
        const selection = window.getSelection();
        selection?.removeAllRanges();
        selection?.addRange(range);
      }
    });
  };

  const handleTitleBlur = (e: React.FocusEvent<HTMLDivElement>) => {
    const value = e.currentTarget.textContent || '';
    const next = value || title;
    setLocalTitle(next);
    setIsTitleEditable(false);
    onTitleChange?.(next);
    e.currentTarget.scrollLeft = 0;
  };

  const handleTitleInput = (e: React.FormEvent<HTMLDivElement>) => {
    const value = e.currentTarget.textContent || '';
    setLocalTitle(value);
    onTitleChange?.(value);
  };

  const titleMaxWidthClass = resolutionText ? 'max-w-[72%]' : 'max-w-full';

  return (
    <div className='min-w-0 w-full max-w-full overflow-hidden text-[#7879F1]'>
      <div className='flex w-full min-w-0 max-w-full items-center justify-between gap-2 overflow-hidden'>
        {editable ? (
          <div
            ref={titleInputRef}
            contentEditable={isTitleEditable}
            suppressContentEditableWarning
            className={
              `inline-block w-fit min-w-0 ${titleMaxWidthClass} truncate overflow-hidden whitespace-nowrap bg-transparent py-[2px] text-left font-bold leading-none outline-none ` +
              (isTitleEditable
                ? 'nodrag select-text border border-transparent focus:border-border-utilities-selected rounded-[2px] selection:bg-background-success-secondary selection:text-white'
                : 'hover:cursor-grab active:cursor-grabbing select-none border-0')
            }
            style={{ fontSize }}
            onDoubleClick={handleTitleDoubleClick}
            onBlur={handleTitleBlur}
            onInput={handleTitleInput}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === 'Escape') {
                e.preventDefault();
                (e.target as HTMLDivElement).blur();
              }
            }}
          >
            {!isTitleEditable && localTitle}
          </div>
        ) : (
          <div
            className={`inline-block w-fit min-w-0 ${titleMaxWidthClass} truncate overflow-hidden whitespace-nowrap py-[2px] px-[4px] text-left font-bold leading-none select-none`}
            style={{ fontSize }}
          >
            {localTitle}
          </div>
        )}
        {resolutionText ? (
          <div
            className='max-w-[45%] shrink-0 truncate overflow-hidden whitespace-nowrap px-[2px] text-right font-semibold leading-none tabular-nums'
            style={{ fontSize }}
          >
            {resolutionText}
          </div>
        ) : null}
      </div>
    </div>
  );
};

export default memo(NodeHeader);
