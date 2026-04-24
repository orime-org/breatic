import React, { useMemo, memo } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { useVideoEditorStore } from '@/hooks/useVideoEditorStore';
import { TimelineClip } from '../../types';
import TrackRow from './TrackRow';

interface TimelineTracksProps {
  pixelsPerSecond: number;
  currentTime: number;
  onClipResize: (clipId: string, newStart: number, newEnd: number, edge: 'left' | 'right') => void;
  onShowSnapLines: (lines: number[]) => void;
  hoverTrackIndex: number | null;
  isHoverAboveFirstTrack: boolean;
  draggingClipId?: string | null;
  nodeId?: string;
  parentRef?: React.RefObject<HTMLDivElement | null>;
  parentScrollRef?: React.RefObject<HTMLDivElement | null>;
}

// 每个轨道的高度：h-7 (28px) + mb-2.5 (10px) = 38px
const TRACK_HEIGHT = 38;

const TimelineTracks: React.FC<TimelineTracksProps> = ({
  pixelsPerSecond,
  currentTime,
  onClipResize,
  onShowSnapLines,
  hoverTrackIndex,
  isHoverAboveFirstTrack,
  draggingClipId,
  nodeId,
  parentRef,
  parentScrollRef,
}) => {
  // 从 store 获取状态
  const { clips } = useVideoEditorStore();

  // 按轨道索引分组 clips 并获取所有有素材的轨道索引
  const usedTrackIndexes = useMemo(() => {
    const tracksMap: { [key: number]: TimelineClip[] } = {};
    clips.forEach((clip: TimelineClip) => {
      if (!tracksMap[clip.trackIndex]) {
        tracksMap[clip.trackIndex] = [];
      }
      tracksMap[clip.trackIndex].push(clip);
    });

    // 获取所有有素材的轨道索引并排序
    return Object.keys(tracksMap)
      .map(Number)
      .filter((index) => tracksMap[index].length > 0)
      .sort((a, b) => a - b);
  }, [clips]);

  // 使用虚拟列表优化轨道渲染（纵向）
  const virtualizer = useVirtualizer({
    count: usedTrackIndexes.length,
    getScrollElement: () => parentRef?.current || null,
    estimateSize: () => TRACK_HEIGHT,
    overscan: 5, // 预渲染5个轨道
  });

  return (
    <>
      <div
        style={{
          height: `${virtualizer.getTotalSize()}px`,
          width: '100%',
          position: 'relative',
        }}
      >
        {virtualizer.getVirtualItems().map((virtualRow) => {
          const actualTrackIndex = usedTrackIndexes[virtualRow.index];
          const isDraggingTrack =
            !!draggingClipId &&
            clips.some((clip: TimelineClip) => clip.id === draggingClipId && clip.trackIndex === actualTrackIndex);
          return (
            <div
              key={virtualRow.key}
              style={{
                position: 'absolute',
                top: 0,
                left: 0,
                width: '100%',
                height: `${virtualRow.size}px`,
                transform: `translateY(${virtualRow.start}px)`,
                // Keep dragged track above sibling track backgrounds,
                // but still below snap lines (z-5) and playhead (z-20).
                zIndex: isDraggingTrack ? 2 : 0,
              }}
            >
              <TrackRow
                trackIndex={actualTrackIndex}
                pixelsPerSecond={pixelsPerSecond}
                currentTime={currentTime}
                onClipResize={onClipResize}
                onShowSnapLines={onShowSnapLines}
                hoverTrackIndex={hoverTrackIndex}
                isHoverAboveFirstTrack={isHoverAboveFirstTrack}
                nodeId={nodeId}
                parentScrollRef={parentScrollRef}
              />
            </div>
          );
        })}
      </div>
    </>
  );
};

export default memo(TimelineTracks);

