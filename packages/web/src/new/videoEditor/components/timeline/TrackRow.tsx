import React, { useMemo, memo, useRef, useEffect, useState } from 'react';
import { useDroppable } from '@dnd-kit/core';
import { useVideoEditorStore } from '@/hooks/useVideoEditorStore';
import { TimelineClip } from '../../types';
import ClipItem from './ClipItem';

interface TrackRowProps {
  trackIndex: number;
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
  nodeId?: string;
  parentScrollRef?: React.RefObject<HTMLDivElement | null>;
}

const TrackRow: React.FC<TrackRowProps> = ({
  trackIndex,
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
  nodeId,
  parentScrollRef,
}) => {
  const { clips, mediaItems, selectedClipId, setSelectedClipId } = useVideoEditorStore();
  const isMultiSelected = selectedClipId.length > 1;
  const rowRef = useRef<HTMLDivElement>(null);
  const [containerWidth, setContainerWidth] = useState(0);

  // store get track clips， starttime
  const trackClips = useMemo(
    () =>
      clips
        .filter((clip: TimelineClip) => clip.trackIndex === trackIndex)
        .sort((a, b) => a.start - b.start),
    [clips, trackIndex]
  );

  // listencontainerwidth
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

  // listen
  const [scrollLeft, setScrollLeft] = useState(0);

  useEffect(() => {
    if (!parentScrollRef?.current) return;

    const handleScroll = () => {
      setScrollLeft(parentScrollRef.current?.scrollLeft || 0);
    };

    const scrollElement = parentScrollRef.current;
    scrollElement.addEventListener('scroll', handleScroll, { passive: true });
    handleScroll(); // initialize

    return () => {
      scrollElement.removeEventListener('scroll', handleScroll);
    };
  }, [parentScrollRef]);

  // calculate asset（ ）
  const visibleClips = useMemo(() => {
    if (trackClips.length === 0) return trackClips;

    const viewportWidth = containerWidth || window.innerWidth;
    const viewportStart = scrollLeft - 200; // load200px
    const viewportEnd = scrollLeft + viewportWidth + 200; // load200px

    return trackClips.filter((clip) => {
      const clipStart = clip.start * pixelsPerSecond;
      const clipEnd = clip.end * pixelsPerSecond;
      // checkasset
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
      {/* 0 tracktop line（ 0 trackasset otherassetoverlap display） */}
      {trackIndex === 0 && isHoverAboveFirstTrack && (
        <div className='absolute left-0 top-0 w-full h-px bg-blue-500 z-50 pointer-events-none shadow-[0_0_8px_rgba(59,130,246,0.6)]' />
      )}
      {/* trackup line */}
      {hoverTrackIndex === trackIndex && (
        <div className='absolute left-0 top-0 w-full h-px bg-blue-500 z-50 pointer-events-none shadow-[0_0_8px_rgba(59,130,246,0.6)]' />
      )}
      {/* use list ： asset */}
      {visibleClips.map((clip: TimelineClip) => {
        const media = mediaItems.find((item: { id: string }) => item.id === clip.mediaId);
        const isSelected = selectedClipId.includes(clip.id);
        return (
          <ClipItem
            key={clip.id}
            clip={clip}
            media={media}
            isSelected={isSelected}
            showSelectedOutline={!isMultiSelected}
            groupDragOffsetX={
              groupDraggingIds.includes(clip.id) && clip.id !== draggingClipId
                ? groupDragOffsetX
                : 0
            }
            groupDragOffsetY={
              groupDraggingIds.includes(clip.id) && clip.id !== draggingClipId
                ? groupDragOffsetY
                : 0
            }
            pixelsPerSecond={pixelsPerSecond}
            currentTime={currentTime}
            onResize={onClipResize}
            onShowSnapLines={onShowSnapLines}
            onSelectClip={(clipId: string, options) => {
              const currentSelected = Array.isArray(selectedClipId) ? selectedClipId : [];
              const isAlreadySelected = currentSelected.includes(clipId);

              if (options?.toggle) {
                if (isAlreadySelected) {
                  setSelectedClipId(currentSelected.filter((id) => id !== clipId));
                } else {
                  setSelectedClipId([...currentSelected, clipId]);
                }
                return;
              }

              if (options?.append) {
                if (!isAlreadySelected) {
                  setSelectedClipId([...currentSelected, clipId]);
                }
                return;
              }

              setSelectedClipId([clipId]);
            }}
            allClips={clips}
            nodeId={nodeId}
          />
        );
      })}
    </div>
  );
};

export default memo(TrackRow);

