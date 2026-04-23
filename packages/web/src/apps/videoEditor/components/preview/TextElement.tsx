import React, { useRef, useMemo, memo } from 'react';
import { useVideoEditorStore } from '@/hooks/useVideoEditorStore';
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
  nodeId,
}) => {
  const { selectedClipId: selectedClipIds, updateClip, setSelectedClipId } = useVideoEditorStore(nodeId);
  const textElementRef = useRef<HTMLDivElement | null>(null);

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
    // 如果元素已经选中，阻止事件传播，让 Moveable 处理
    if (selectedClipIds.includes(clip.id) && textElementRef.current) {
      e.stopPropagation();
    }
    // 如果元素未选中，不阻止事件，让外层的 onClick 处理选中
    // 但是不要阻止 click 事件，让它可以冒泡到外层 div
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
      target.focus();
      const range = document.createRange();
      range.selectNodeContents(target);
      const selection = window.getSelection();
      selection?.removeAllRanges();
      selection?.addRange(range);
    }
  };

  const handleClick = (e: React.MouseEvent<HTMLDivElement>) => {
    // 直接在这里处理选中，因为 contentEditable 可能会阻止事件冒泡到外层 div
    e.stopPropagation(); // 阻止事件传播到 InfiniteCanvas，避免清除选中
    // 支持 Shift 多选
    if (e.shiftKey) {
      if (selectedClipIds.includes(clip.id)) {
        // 如果已选中，则取消选中
        const newIds = selectedClipIds.filter((id) => id !== clip.id);
        setSelectedClipId(newIds);
      } else {
        // 如果未选中，则添加到选中列表
        setSelectedClipId([...selectedClipIds, clip.id]);
      }
    } else {
      // 单选
      setSelectedClipId([clip.id]);
    }
  };

  const handleFocus = () => {
    isEditingRef.current?.add(clip.id);
  };

  const isEditable = selectedClipIds.includes(clip.id);
  const userSelect = isEditable ? 'text' : 'none';

  return (
    <div className='w-full h-full table'>
      <div className='table-cell align-middle'>
        <div
          ref={handleRef}
          contentEditable={isEditable}
          className='outline-none pointer-events-auto cursor-text nodrag whitespace-pre-wrap break-words min-w-[50px] w-full box-border'
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

