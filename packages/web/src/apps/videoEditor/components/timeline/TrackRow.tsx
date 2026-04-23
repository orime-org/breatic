import React, { useMemo, memo, useRef, useEffect, useState } from 'react';
import { useDroppable } from '@dnd-kit/core';
import { useVideoEditorStore } from '@/hooks/useVideoEditorStore';
import { TimelineClip } from '../../types';
import ClipItem from './ClipItem';

interface TrackRowProps {
  trackIndex: number;
  pixelsPerSecond: number;
  onClipResize: (clipId: string, newStart: number, newEnd: number, edge: 'left' | 'right') => void;
  onShowSnapLines: (lines: number[]) => void;
  hoverTrackIndex: number | null;
  isHoverAboveFirstTrack: boolean;
  nodeId?: string;
  parentScrollRef?: React.RefObject<HTMLDivElement | null>;
}

const TrackRow: React.FC<TrackRowProps> = ({
  trackIndex,
  pixelsPerSecond,
  onClipResize,
  onShowSnapLines,
  hoverTrackIndex,
  isHoverAboveFirstTrack,
  nodeId,
  parentScrollRef,
}) => {
  const { clips, mediaItems, selectedClipId, setSelectedClipId } = useVideoEditorStore(nodeId);
  const rowRef = useRef<HTMLDivElement>(null);
  const [containerWidth, setContainerWidth] = useState(0);

  // 从 store 获取当前轨道的 clips，并按开始时间排序
  const trackClips = useMemo(
    () =>
      clips
        .filter((clip: TimelineClip) => clip.trackIndex === trackIndex)
        .sort((a, b) => a.start - b.start),
    [clips, trackIndex]
  );

  // 监听容器宽度变化
  useEffect(() => {
    if (!rowRef.current) return;
    const resizeObserver = new ResizeObserver((entries) => {
      for (const entry of entries) {
        setContainerWidth(entry.contentRect.width);
      }
    });
    resizeObserver.observe(rowRef.current);
    return () => resizeObserver.disconnect();
  }, []);

  // 监听滚动位置变化
  const [scrollLeft, setScrollLeft] = useState(0);

  useEffect(() => {
    if (!parentScrollRef?.current) return;

    const handleScroll = () => {
      setScrollLeft(parentScrollRef.current?.scrollLeft || 0);
    };

    const scrollElement = parentScrollRef.current;
    scrollElement.addEventListener('scroll', handleScroll, { passive: true });
    handleScroll(); // 初始化

    return () => {
      scrollElement.removeEventListener('scroll', handleScroll);
    };
  }, [parentScrollRef]);

  // 计算可见的素材（基于横向滚动位置）
  const visibleClips = useMemo(() => {
    if (trackClips.length === 0) return trackClips;

    const viewportWidth = containerWidth || window.innerWidth;
    const viewportStart = scrollLeft - 200; // 预加载200px
    const viewportEnd = scrollLeft + viewportWidth + 200; // 预加载200px

    return trackClips.filter((clip) => {
      const clipStart = clip.start * pixelsPerSecond;
      const clipEnd = clip.end * pixelsPerSecond;
      // 检查素材是否与视口重叠
      return clipEnd >= viewportStart && clipStart <= viewportEnd;
    });
  }, [trackClips, pixelsPerSecond, scrollLeft, containerWidth]);

  const { setNodeRef } = useDroppable({
    id: `track-${trackIndex}`,
  });

  return (
    <div
      ref={(el) => {
        setNodeRef(el);
        rowRef.current = el;
      }}
      className='w-[calc(100%-20px)] h-7 mb-2.5 ml-5 bg-background-default-secondary relative overflow-visible'
    >
      {/* 0号轨道顶部的插入指示线（当0号轨道素材与其他素材重合时显示） */}
      {trackIndex === 0 && isHoverAboveFirstTrack && (
        <div className='absolute left-0 top-0 w-full h-px bg-blue-500 z-50 pointer-events-none shadow-[0_0_8px_rgba(59,130,246,0.6)]' />
      )}
      {/* 轨道上方的插入指示线 */}
      {hoverTrackIndex === trackIndex && (
        <div className='absolute left-0 top-0 w-full h-px bg-blue-500 z-50 pointer-events-none shadow-[0_0_8px_rgba(59,130,246,0.6)]' />
      )}
      {/* 使用虚拟列表优化：只渲染可见的素材 */}
      {visibleClips.map((clip: TimelineClip) => {
        const media = mediaItems.find((item: { id: string }) => item.id === clip.mediaId);
        const isSelected = selectedClipId.includes(clip.id);
        return (
          <ClipItem
            key={clip.id}
            clip={clip}
            media={media}
            isSelected={isSelected}
            pixelsPerSecond={pixelsPerSecond}
            onResize={onClipResize}
            onShowSnapLines={onShowSnapLines}
            onSelectClip={(clipId: string) => setSelectedClipId([clipId])}
            allClips={clips}
            nodeId={nodeId}
          />
        );
      })}
    </div>
  );
};

export default memo(TrackRow);

