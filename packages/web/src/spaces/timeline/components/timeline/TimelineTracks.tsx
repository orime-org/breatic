import React, { useMemo, memo } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { useVideoEditorStore } from '@/app/hooks/useVideoEditorStore';
import { TimelineClip } from '@/spaces/timeline/types';
import TrackRow from './TrackRow';

interface TimelineTracksProps {
  pixelsPerSecond: number;
  currentTime: number;
  onClipResize: (clipId: string, newStart: number, newEnd: number, edge: 'left' | 'right') => void;
  onShowSnapLines: (lines: number[]) => void;
  hoverTrackIndex: number | null;
  isHoverAboveFirstTrack: boolean;
  draggingClipId?: string | null;
  groupDraggingIds?: string[];
  groupDragOffsetX?: number;
  groupDragOffsetY?: number;
  onMultiSelectResizeStart?: (edge: 'left' | 'right', clientX: number) => void;
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
  groupDraggingIds = [],
  groupDragOffsetX = 0,
  groupDragOffsetY = 0,
  onMultiSelectResizeStart,
  nodeId,
  parentRef,
  parentScrollRef,
}) => {
  // store get
  const { clips, selectedClipId } = useVideoEditorStore();

  const draggingTrackIndexes = useMemo(() => {
    const trackIndexes = new Set<number>();
    if (draggingClipId) {
      clips.forEach((clip: TimelineClip) => {
        if (clip.id === draggingClipId) {
          trackIndexes.add(clip.trackIndex);
        }
      });
    }
    if (groupDraggingIds.length > 1) {
      const groupIdSet = new Set(groupDraggingIds);
      clips.forEach((clip: TimelineClip) => {
        if (groupIdSet.has(clip.id)) {
          trackIndexes.add(clip.trackIndex);
        }
      });
    }
    return trackIndexes;
  }, [clips, draggingClipId, groupDraggingIds]);

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

  const selectionBounds = useMemo(() => {
    if (selectedClipId.length <= 1 || usedTrackIndexes.length === 0) {
      return null;
    }

    const selectedSet = new Set(selectedClipId);
    const selectedClips = clips.filter((clip) => selectedSet.has(clip.id));
    if (selectedClips.length <= 1) {
      return null;
    }

    const trackOrderMap = new Map<number, number>();
    usedTrackIndexes.forEach((trackIndex, order) => {
      trackOrderMap.set(trackIndex, order);
    });

    const orderedTracks = selectedClips
      .map((clip) => trackOrderMap.get(clip.trackIndex))
      .filter((order): order is number => order !== undefined);

    if (orderedTracks.length === 0) {
      return null;
    }

    const minStart = Math.min(...selectedClips.map((clip) => clip.start));
    const maxEnd = Math.max(...selectedClips.map((clip) => clip.end));
    const minTrackOrder = Math.min(...orderedTracks);
    const maxTrackOrder = Math.max(...orderedTracks);

    return {
      left: minStart * pixelsPerSecond + 20 + (groupDraggingIds.length > 1 ? groupDragOffsetX : 0),
      width: Math.max((maxEnd - minStart) * pixelsPerSecond, 1),
      top: minTrackOrder * TRACK_HEIGHT + (groupDraggingIds.length > 1 ? groupDragOffsetY : 0),
      height: (maxTrackOrder - minTrackOrder) * TRACK_HEIGHT + 28,
    };
  }, [clips, selectedClipId, usedTrackIndexes, pixelsPerSecond, groupDraggingIds.length, groupDragOffsetX, groupDragOffsetY]);

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
          const isDraggingTrack = draggingTrackIndexes.has(actualTrackIndex);
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
                draggingClipId={draggingClipId}
                groupDraggingIds={groupDraggingIds}
                groupDragOffsetX={groupDragOffsetX}
                groupDragOffsetY={groupDragOffsetY}
                nodeId={nodeId}
                parentScrollRef={parentScrollRef}
              />
            </div>
          );
        })}
        {selectionBounds && (
          <div
            className='absolute pointer-events-none rounded border-2 border-blue-500 shadow-[0_0_0_2px_rgba(59,130,246,0.3)] z-[3]'
            style={{
              left: `${selectionBounds.left}px`,
              width: `${selectionBounds.width}px`,
              top: `${selectionBounds.top}px`,
              height: `${selectionBounds.height}px`,
            }}
          >
            <div
              className='absolute left-0 top-0 bottom-0 w-2.5 bg-blue-500/30 flex items-center justify-center pointer-events-auto cursor-ew-resize'
              onMouseDown={(e) => {
                e.stopPropagation();
                e.preventDefault();
                onMultiSelectResizeStart?.('left', e.clientX);
              }}
            >
              <div className='flex gap-px items-center justify-center'>
                <div className='w-px h-3.5 bg-blue-500 rounded-[0.5px]' />
                <div className='w-px h-3.5 bg-blue-500 rounded-[0.5px]' />
              </div>
            </div>
            <div
              className='absolute right-0 top-0 bottom-0 w-2.5 bg-blue-500/30 flex items-center justify-center pointer-events-auto cursor-ew-resize'
              onMouseDown={(e) => {
                e.stopPropagation();
                e.preventDefault();
                onMultiSelectResizeStart?.('right', e.clientX);
              }}
            >
              <div className='flex gap-px items-center justify-center'>
                <div className='w-px h-3.5 bg-blue-500 rounded-[0.5px]' />
                <div className='w-px h-3.5 bg-blue-500 rounded-[0.5px]' />
              </div>
            </div>
          </div>
        )}
      </div>
    </>
  );
};

export default memo(TimelineTracks);

