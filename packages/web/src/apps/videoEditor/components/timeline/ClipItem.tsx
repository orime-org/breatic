import React, { useState, useRef, memo, useEffect } from 'react';
import { useDraggable } from '@dnd-kit/core';
import { TimelineClip } from '../../types';
import { Icon } from '@/components/base/icon';

interface ClipItemProps {
  clip: TimelineClip;
  media?: { id: string; type?: string; name?: string; thumbnail?: string; url?: string; text?: string };
  isSelected: boolean;
  pixelsPerSecond: number;
  onResize: (clipId: string, newStart: number, newEnd: number, edge: 'left' | 'right') => void;
  onShowSnapLines: (lines: number[]) => void;
  onSelectClip: (clipId: string) => void;
  allClips: TimelineClip[]; // 用于吸附计算
  nodeId?: string;
}

const ClipItem: React.FC<ClipItemProps> = ({
  clip,
  media,
  isSelected,
  pixelsPerSecond,
  onResize,
  onShowSnapLines,
  onSelectClip,
  allClips,
  nodeId: _nodeId,
}) => {
  const [isResizing, setIsResizing] = useState(false);
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const [resizeEdge, setResizeEdge] = useState<'left' | 'right' | null>(null);
  const mouseDownPos = useRef<{ x: number; y: number } | null>(null);
  const resizeStateRef = useRef<{
    startX: number;
    originalStart: number;
    originalEnd: number;
    edge: 'left' | 'right';
  } | null>(null);

  // Hook 必须在条件检查之前调用
  const { attributes, listeners, setNodeRef, transform } = useDraggable({
    id: clip.id,
    data: { clip },
    disabled: isResizing,
  });

  // 使用 useEffect 管理调整大小事件监听器
  useEffect(() => {
    if (!isResizing || !resizeStateRef.current) return;

    const { startX, originalStart, originalEnd, edge } = resizeStateRef.current;

    const handleMouseMove = (moveEvent: MouseEvent) => {
      moveEvent.preventDefault();
      const deltaX = moveEvent.clientX - startX;
      const deltaTime = deltaX / pixelsPerSecond;

      if (edge === 'left') {
        const rawStart = Math.max(0, Math.min(originalStart + deltaTime, originalEnd - 0.1));

        // 收集吸附点
        const snapPoints: number[] = [];
        allClips.forEach((otherClip: TimelineClip) => {
          if (otherClip.id !== clip.id) {
            snapPoints.push(otherClip.start);
            snapPoints.push(otherClip.end);
          }
        });
        snapPoints.push(0);

        // 吸附逻辑
        const snapThreshold = 0.1;
        let snappedStart = rawStart;
        let minDistance = Infinity;
        let snapLine: number | null = null;

        snapPoints.forEach((point) => {
          const distance = Math.abs(rawStart - point);
          if (distance < snapThreshold && distance < minDistance) {
            minDistance = distance;
            snappedStart = point;
            snapLine = point;
          }
        });

        if (snapLine !== null) {
          onShowSnapLines([snapLine]);
        } else {
          onShowSnapLines([]);
        }

        onResize(clip.id, snappedStart, originalEnd, 'left');
      } else {
        const rawEnd = Math.max(originalStart + 0.1, originalEnd + deltaTime);

        // 收集吸附点
        const snapPoints: number[] = [];
        allClips.forEach((otherClip: TimelineClip) => {
          if (otherClip.id !== clip.id) {
            snapPoints.push(otherClip.start);
            snapPoints.push(otherClip.end);
          }
        });

        // 吸附逻辑
        const snapThreshold = 0.1;
        let snappedEnd = rawEnd;
        let minDistance = Infinity;
        let snapLine: number | null = null;

        snapPoints.forEach((point) => {
          const distance = Math.abs(rawEnd - point);
          if (distance < snapThreshold && distance < minDistance) {
            minDistance = distance;
            snappedEnd = point;
            snapLine = point;
          }
        });

        if (snapLine !== null) {
          onShowSnapLines([snapLine]);
        } else {
          onShowSnapLines([]);
        }

        onResize(clip.id, originalStart, snappedEnd, 'right');
      }
    };

    const handleMouseUp = () => {
      setIsResizing(false);
      setResizeEdge(null);
      onShowSnapLines([]);
      resizeStateRef.current = null;
    };

    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', handleMouseUp);

    return () => {
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
    };
  }, [isResizing, clip.id, pixelsPerSecond, allClips, onResize, onShowSnapLines]);

  // 处理左边缘调整大小
  const handleLeftResize = (e: React.MouseEvent) => {
    e.stopPropagation();
    e.preventDefault();
    resizeStateRef.current = {
      startX: e.clientX,
      originalStart: clip.start,
      originalEnd: clip.end,
      edge: 'left',
    };
    setIsResizing(true);
    setResizeEdge('left');
  };

  // 处理右边缘调整大小
  const handleRightResize = (e: React.MouseEvent) => {
    e.stopPropagation();
    e.preventDefault();
    resizeStateRef.current = {
      startX: e.clientX,
      originalStart: clip.start,
      originalEnd: clip.end,
      edge: 'right',
    };
    setIsResizing(true);
    setResizeEdge('right');
  };

  /**
   * 获取缩略图或背景图URL
   */
  const getBackgroundUrl = (): string | null => {
    if (media?.type === 'video') {
      return media.thumbnail || null;
    }
    if (media?.type === 'image') {
      return media.url || null;
    }
    if (media?.type === 'audio') {
      // 音频类型使用背景颜色，不需要背景图片
      return null;
    }
    return null;
  };

  /**
   * 获取背景颜色
   */
  const getBackgroundColor = (backgroundUrl: string | null): string => {
    if (media?.type === 'text') {
      return '#77C562';
    }
    if (media?.type === 'audio') {
      return '#CD9541';
    }
    if (backgroundUrl) {
      return 'transparent';
    }
    return '#77C562';
  };

  /**
   * 获取背景大小
   */
  const getBackgroundSize = (): string => {
    if (media?.type === 'video' || media?.type === 'image') {
      return 'auto 100%';
    }
    if (media?.type === 'audio') {
      return 'auto 60%';
    }
    return 'auto';
  };

  /**
   * 获取动态样式
   */
  const getDynamicStyle = (): React.CSSProperties => {
    const backgroundUrl = getBackgroundUrl();
    const backgroundColor = getBackgroundColor(backgroundUrl);
    const backgroundSize = getBackgroundSize();

    return {
      left: `${clip.start * pixelsPerSecond}px`,
      width: `${(clip.end - clip.start) * pixelsPerSecond}px`,
      backgroundImage: backgroundUrl ? `url(${backgroundUrl})` : 'none',
      backgroundColor,
      backgroundSize,
      transform: transform ? `translate3d(${transform.x}px, ${transform.y}px, 0)` : undefined,
      zIndex: transform ? 100 : 10,
    };
  };

  const dynamicStyle = getDynamicStyle();

  // Tailwind 类名
  const className = `absolute h-7 top-0 bg-repeat-x bg-left-center rounded border flex items-end overflow-hidden select-none ${
    isSelected
      ? 'border-2 border-blue-500 shadow-[0_0_0_2px_rgba(59,130,246,0.3)]'
      : 'border border-white/30'
  } ${isResizing ? 'cursor-ew-resize' : 'cursor-grab'}`;

  const handleMouseDown = (e: React.MouseEvent) => {
    mouseDownPos.current = { x: e.clientX, y: e.clientY };
  };

  const handleMouseUp = (e: React.MouseEvent) => {
    if (!mouseDownPos.current) return;

    const deltaX = Math.abs(e.clientX - mouseDownPos.current.x);
    const deltaY = Math.abs(e.clientY - mouseDownPos.current.y);
    const distance = Math.sqrt(deltaX ** 2 + deltaY ** 2);

    if (distance < 5) {
      e.stopPropagation();
      onSelectClip(clip.id);
    }

    mouseDownPos.current = null;
  };

  return (
    <div
      ref={setNodeRef}
      id={`timeline-clip-${clip.id}`}
      data-selectable='true'
      className={className}
      style={dynamicStyle}
      {...listeners}
      {...attributes}
      onMouseDown={handleMouseDown}
      onMouseUp={handleMouseUp}
    >
      {/* 左侧调整手柄 */}
      {isSelected && (
        <div
          onMouseDown={handleLeftResize}
          onPointerDown={(e) => e.stopPropagation()}
          onClick={(e) => e.stopPropagation()}
          className='absolute left-0 top-0 bottom-0 w-2.5 cursor-ew-resize bg-blue-500/30 z-10 flex items-center justify-center'
        >
          <div className='flex gap-px items-center justify-center'>
            <div className='w-px h-3.5 bg-blue-500 rounded-[0.5px]' />
            <div className='w-px h-3.5 bg-blue-500 rounded-[0.5px]' />
          </div>
        </div>
      )}

      {/* 右侧调整手柄 */}
      {isSelected && (
        <div
          onMouseDown={handleRightResize}
          onPointerDown={(e) => e.stopPropagation()}
          onClick={(e) => e.stopPropagation()}
          className='absolute right-0 top-0 bottom-0 w-2.5 cursor-ew-resize bg-blue-500/30 z-10 flex items-center justify-center'
        >
          <div className='flex gap-px items-center justify-center'>
            <div className='w-px h-3.5 bg-blue-500 rounded-[0.5px]' />
            <div className='w-px h-3.5 bg-blue-500 rounded-[0.5px]' />
          </div>
        </div>
      )}

      {/* 文本或素材名称 */}
      {media?.type === 'text' || clip.type === 'text' || clip.text !== undefined ? (
        <div className='absolute top-0 left-0 flex items-center justify-start px-3 gap-1.5 w-full h-full text-white text-xs font-semibold overflow-hidden'>
          <Icon
            name='videoEditor-text-icon'
            width={16}
            height={16}
            color='#ffffff'
          />
          <span className='overflow-hidden text-ellipsis whitespace-nowrap flex-1'>
            {clip.text || 'Text'}
          </span>
        </div>
      ) : (
        <div className='bg-black/70 text-white px-1.5 py-px text-[10px] w-full relative z-[1] pointer-events-none'>
          <div className='font-medium overflow-hidden text-ellipsis whitespace-nowrap'>
            {media?.name || '未知素材'}
          </div>
        </div>
      )}
    </div>
  );
};

export default memo(ClipItem);