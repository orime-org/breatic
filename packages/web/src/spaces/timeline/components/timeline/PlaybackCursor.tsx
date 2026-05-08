import React, { memo, useState, useEffect, useRef } from 'react';
import { useVideoEditorStore } from '@/app/hooks/useVideoEditorStore';

interface PlaybackCursorProps {
  currentTime: number;
  pixelsPerSecond: number;
  onTimeChange: (time: number) => void;
  onShowSnapLines: (lines: number[]) => void;
  containerRef: React.RefObject<HTMLDivElement | null>;
  scrollLeft: number;
  getScrollLeft: () => number;
  reactflowScale?: number;
}

const PlaybackCursor: React.FC<PlaybackCursorProps> = ({
  currentTime,
  pixelsPerSecond,
  onTimeChange,
  onShowSnapLines,
  containerRef: _containerRef,
  scrollLeft,
  getScrollLeft,
  reactflowScale = 1.0,
}) => {
  // store get clips
  const { clips } = useVideoEditorStore();
  const [isDragging, setIsDragging] = useState(false);
  const dragStateRef = useRef<{
    startX: number;
    startTime: number;
    startScrollLeft: number;
  } | null>(null);

  const playheadLeft = currentTime * pixelsPerSecond + 20 - scrollLeft;

  // use useEffect drag listen
  useEffect(() => {
    if (!isDragging || !dragStateRef.current) return;

    const { startX, startTime, startScrollLeft } = dragStateRef.current;

    const handleMouseMove = (moveEvent: MouseEvent) => {
      moveEvent.preventDefault();
      const currentScrollLeft = getScrollLeft();
      const scrollDelta = currentScrollLeft - startScrollLeft;

      const deltaX = (moveEvent.clientX - startX) / reactflowScale + scrollDelta;
      const deltaTime = deltaX / pixelsPerSecond;

      const maxClipEnd = clips.length > 0 ? Math.max(...clips.map((c) => c.end)) : 0;
      const playheadWidthTime = 2 / pixelsPerSecond;
      const maxDragTime = maxClipEnd - playheadWidthTime;
      const rawTime = Math.max(0, Math.min(maxDragTime, startTime + deltaTime));

      const snapPoints: number[] = [];
      clips.forEach((clip) => {
        snapPoints.push(clip.start);
        snapPoints.push(clip.end);
      });

      const snapThreshold = 0.1;
      let snappedTime = rawTime;
      let minDistance = Infinity;

      snapPoints.forEach((point) => {
        const distance = Math.abs(rawTime - point);
        if (distance < snapThreshold && distance < minDistance) {
          minDistance = distance;
          snappedTime = point;
        }
      });

      if (minDistance < snapThreshold) {
        onShowSnapLines([snappedTime]);
      } else {
        onShowSnapLines([]);
      }

      onTimeChange(snappedTime);
    };

    const handleMouseUp = () => {
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      onShowSnapLines([]);
      setIsDragging(false);
      dragStateRef.current = null;
    };

    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', handleMouseUp);

    return () => {
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    };
  }, [isDragging, clips, pixelsPerSecond, reactflowScale, getScrollLeft, onTimeChange, onShowSnapLines]);

  const handleCursorDragStart = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    dragStateRef.current = {
      startX: e.clientX,
      startTime: currentTime,
      startScrollLeft: getScrollLeft(),
    };

    document.body.style.cursor = 'ew-resize';
    document.body.style.userSelect = 'none';
    setIsDragging(true);
  };

  return (
    <>
      <div
        className='absolute -top-2.5 h-[calc(100%+50px)] w-5 z-[1] cursor-ew-resize select-none pointer-events-auto'
        style={{ left: `${playheadLeft - 10}px` }}
        onMouseDown={handleCursorDragStart}
        onClick={(e) => {
          e.stopPropagation();
        }}
      />
      <div
        className='absolute -top-[18px] w-2.5 h-[18px] bg-[#18181B] rounded-b-[5px] shadow-[0_2px_4px_rgba(0,0,0,0.2)] z-[2] pointer-events-none'
        style={{ left: `${playheadLeft - 4}px` }}
      />
      <div
        className='absolute -top-8 h-[calc(100%+32px)] w-0.5 bg-[#848689] z-0 pointer-events-none select-none'
        style={{ left: `${playheadLeft}px` }}
      />
    </>
  );
};

export default memo(PlaybackCursor);


