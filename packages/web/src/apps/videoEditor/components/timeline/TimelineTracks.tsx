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

// track height：h-7 (28px) + mb-2.5 (10px) = 38px
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
  // store get
  const { clips } = useVideoEditorStore();

  // track clips getall asset track
  const usedTrackIndexes = useMemo(() => {
    const tracksMap: { [key: number]: TimelineClip[] } = {};
    clips.forEach((clip: TimelineClip) => {
      if (!tracksMap[clip.trackIndex]) {
        tracksMap[clip.trackIndex] = [];
      }
      tracksMap[clip.trackIndex].push(clip);
    });

    // getall asset track
    return Object.keys(tracksMap)
      .map(Number)
      .filter((index) => tracksMap[index].length > 0)
      .sort((a, b) => a - b);
  }, [clips]);

  // use list track （ ）
  const virtualizer = useVirtualizer({
    count: usedTrackIndexes.length,
    getScrollElement: () => parentRef?.current || null,
    estimateSize: () => TRACK_HEIGHT,
    overscan: 5, // 5 track
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

