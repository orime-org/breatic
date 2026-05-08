import React, { useRef, useMemo, memo, useState, useEffect } from 'react';
import { flushSync } from 'react-dom';
import { useVideoEditorStore } from '@/app/hooks/useVideoEditorStore';
import { TimelineClip } from '../../types';

interface TextElementProps {
  clip: TimelineClip;
  opacity: number;
  isEditingRef: React.RefObject<Set<string>>;
  textRefs: React.RefObject<{ [key: string]: HTMLDivElement }>;
  nodeId?: string;
}

const TextElement: React.FC<TextElementProps> = ({
  clip,
  opacity,
  isEditingRef,
  textRefs,
}) => {
  const { selectedClipId: selectedClipIds, updateClip, setSelectedClipId } = useVideoEditorStore();
  const textElementRef = useRef<HTMLDivElement | null>(null);
  const isSelected = selectedClipIds.includes(clip.id);
  const [isEditMode, setIsEditMode] = useState(false);

  useEffect(() => {
    if (!isSelected) {
      setIsEditMode(false);
    }
  }, [isSelected]);

  const textStyle = useMemo(() => {
    const style = clip.textStyle || {};
    const fontSize = style.fontSize ?? 48;
    const fontFamily = style.fontFamily || 'Arial';

    const cssStyle: React.CSSProperties = {
      fontFamily: fontFamily,
      fontSize: `${fontSize}px`,
      lineHeight: 1.6,
      color: style.color || '#ffffff',
      textAlign: (style.textAlign as 'left' | 'center' | 'right' | 'justify') || 'center',
      textDecoration: style.textDecoration || 'none',
      textTransform: (style.textTransform as 'none' | 'uppercase' | 'lowercase' | 'capitalize') || 'none',
      fontStyle: (style.fontStyle as 'normal' | 'italic') || 'normal',
      opacity: opacity / 100,
    };

    if (style.strokeColor && style.strokeWidth) {
      cssStyle.WebkitTextStroke = `${style.strokeWidth}px ${style.strokeColor}`;
      (cssStyle as React.CSSProperties & { textStroke?: string }).textStroke = `${style.strokeWidth}px ${style.strokeColor}`;
    }

    if (style.shadowColor) {
      const shadowX = style.shadowOffsetX || 0;
      const shadowY = style.shadowOffsetY || 0;
      const shadowBlur = style.shadowBlur || 0;
      cssStyle.textShadow = `${shadowX}px ${shadowY}px ${shadowBlur}px ${style.shadowColor}`;
    }

    return cssStyle;
  }, [clip.textStyle, opacity]);

  const handleRef = (el: HTMLDivElement | null) => {
    if (el) {
      textRefs.current[clip.id] = el;
      textElementRef.current = el;
      if (!isEditingRef.current?.has(clip.id) && el.innerText !== clip.text) {
        el.innerText = clip.text || 'Text';
      }
    }
  };

  const handleMouseDown = (e: React.MouseEvent<HTMLDivElement>) => {
    // if selected，prevent ， Moveable handle
    if (selectedClipIds.includes(clip.id) && textElementRef.current) {
      e.stopPropagation();
    }
    // if selected， prevent ， onClick handleselected
    // prevent click ， bubbling div
  };

  const calculateHeight = (target: HTMLDivElement): number => {
    const tableCell = target.parentElement as HTMLDivElement;
    const tableDiv = tableCell?.parentElement as HTMLDivElement;
    const outerContainer = tableDiv?.parentElement as HTMLDivElement;

    if (!outerContainer) return 0;

    const originalHeight = outerContainer.style.height;
    outerContainer.style.height = 'auto';

    const fontSize = clip.textStyle?.fontSize ?? 48;
    const minHeight = Math.max(fontSize * 1.5, 60);
    const actualHeight = outerContainer.offsetHeight;
    const contentHeight = Math.max(actualHeight, minHeight);

    outerContainer.style.height = originalHeight;

    return contentHeight;
  };

  const handleInput = (e: React.FormEvent<HTMLDivElement>) => {
    const target = e.currentTarget as HTMLDivElement;
    const newHeight = calculateHeight(target);
    const newText = target.innerText || '';

    updateClip(clip.id, {
      text: newText,
      height: newHeight,
    });
  };

  const handleBlur = (e: React.FocusEvent<HTMLDivElement>) => {
    isEditingRef.current?.delete(clip.id);
    setIsEditMode(false);

    const target = e.currentTarget as HTMLDivElement;
    const newHeight = calculateHeight(target);
    const newText = target.innerText || '';

    updateClip(clip.id, {
      text: newText,
      height: newHeight,
    });
    const selection = window.getSelection();
    if (selection) {
      selection.removeAllRanges();
    }
  };

  const handleDoubleClick = (e: React.MouseEvent<HTMLDivElement>) => {
    if (selectedClipIds.includes(clip.id)) {
      e.stopPropagation();
      const target = e.currentTarget as HTMLDivElement;
      flushSync(() => {
        setIsEditMode(true);
      });
      target.focus();
      const range = document.createRange();
      range.selectNodeContents(target);
      const selection = window.getSelection();
      selection?.removeAllRanges();
      selection?.addRange(range);
    }
  };

  const handleClick = (e: React.MouseEvent<HTMLDivElement>) => {
    // handleselected， contentEditable prevent bubbling div
    e.stopPropagation(); // prevent InfiniteCanvas，avoidclearselected
    // support Shift multi-select
    if (e.shiftKey) {
      if (selectedClipIds.includes(clip.id)) {
        // if selected， selected
        const newIds = selectedClipIds.filter((id) => id !== clip.id);
        setSelectedClipId(newIds);
      } else {
        // if selected， selectedlist
        setSelectedClipId([...selectedClipIds, clip.id]);
      }
    } else {
      // single select
      setSelectedClipId([clip.id]);
    }
  };

  const handleFocus = () => {
    isEditingRef.current?.add(clip.id);
  };

  const canEdit = isSelected && isEditMode;
  const userSelect = canEdit ? 'text' : 'none';
  const cursorClass = canEdit ? 'cursor-text' : isSelected ? 'cursor-move' : 'cursor-default';

  return (
    <div className='w-full h-full table'>
      <div className='table-cell align-middle'>
        <div
          ref={handleRef}
          contentEditable={canEdit}
          data-text-content='true'
          className={`outline-none pointer-events-auto ${cursorClass} nodrag whitespace-pre-wrap break-words min-w-[50px] w-full box-border`}
          style={{
            userSelect,
            ...textStyle,
            wordWrap: 'break-word',
            overflowWrap: 'break-word',
            wordBreak: 'break-word',
          }}
          onFocus={handleFocus}
          onInput={handleInput}
          onBlur={handleBlur}
          onDoubleClick={handleDoubleClick}
          onMouseDown={handleMouseDown}
          onClick={handleClick}
        />
      </div>
    </div>
  );
};

export default memo(TextElement);

