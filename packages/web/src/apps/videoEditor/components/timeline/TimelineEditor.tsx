import React, { useState, useRef, useMemo, useEffect, useCallback, memo } from 'react';
import { DndContext, DragEndEvent, DragStartEvent, DragMoveEvent, closestCenter, Modifier, useDroppable } from '@dnd-kit/core';
import { useTranslation } from 'react-i18next';
import Selecto from 'react-selecto';
import { useVideoEditorStore } from '@/hooks/useVideoEditorStore';
import { MediaItem, TimelineClip } from '../../types';
import TimelineScale from './TimelineScale';
import TimelineTracks from './TimelineTracks';
import PlaybackCursor from './PlaybackCursor';

interface TimelineEditorProps {
  reactflowScale?: number;
  currentTime: number;
  scale: number;
  onTimeChange: (time: number) => void;
  nodeId?: string;
}

// checkclip
const checkCollision = (
  clips: TimelineClip[],
  clipId: string,
  trackIndex: number,
  start: number,
  end: number
): boolean => {
  const tracksClips = clips.filter((c) => c.trackIndex === trackIndex && c.id !== clipId);
  for (const otherClip of tracksClips) {
    if (start < otherClip.end && end > otherClip.start) {
      return true;
    }
  }
  return false;
};

// calculate
const snapToPosition = (
  time: number,
  currentTime: number,
  clips: TimelineClip[],
  currentClipId?: string
): { time: number; snapLines: number[] } => {
  const snapThreshold = 0.1;
  const detectedSnapLines: number[] = [];
  let snappedTime = time;
  let minDistance = Infinity;

  const snapPoints: { time: number; label: string }[] = [];
  snapPoints.push({ time: currentTime, label: 'cursor' });
  clips.forEach((clip: TimelineClip) => {
    if (clip.id !== currentClipId) {
      snapPoints.push({ time: clip.start, label: 'clip-start' });
      snapPoints.push({ time: clip.end, label: 'clip-end' });
    }
  });

  snapPoints.forEach((point) => {
    const distance = Math.abs(time - point.time);
    if (distance < snapThreshold && distance < minDistance) {
      minDistance = distance;
      snappedTime = point.time;
      if (!detectedSnapLines.includes(point.time)) {
        detectedSnapLines.push(point.time);
      }
    }
  });

  return { time: snappedTime, snapLines: detectedSnapLines };
};

// top regioncomponent（used fordrag top）
interface TopDropZoneProps {
  onClick?: (e: React.MouseEvent<HTMLDivElement>) => void;
}

const TopDropZone: React.FC<TopDropZoneProps> = ({ onClick }) => {
  const { setNodeRef } = useDroppable({
    id: 'track-top',
  });

  return (
    <div
      ref={setNodeRef}
      className='w-[calc(100%-20px)] h-5 ml-5 mb-2.5'
      onClick={onClick}
    />
  );
};

const TimelineEditor: React.FC<TimelineEditorProps> = ({
  reactflowScale = 1.0,
  currentTime,
  scale,
  onTimeChange,
  nodeId,
}) => {
  const { t } = useTranslation();

  // use useVideoEditorStore hook
  const {
    clips,
    mediaItems,
    updateClip,
    setClips,
    setSelectedClipId,
    selectedClipId,
  } = useVideoEditorStore();

  const selectoRef = useRef<Selecto>(null);

  // componentinside handle
  const handleTimeChange = useCallback((time: number) => {
    onTimeChange(time);
  }, [onTimeChange]);
  const containerRef = useRef<HTMLDivElement>(null);
  const scrollbarRef = useRef<HTMLDivElement | null>(null);
  const scaleRef = useRef<HTMLDivElement>(null);
  const [snapLines, setSnapLines] = useState<number[]>([]);
  const [isDragging, setIsDragging] = useState(false);
  const [draggingClipId, setDraggingClipId] = useState<string | null>(null);
  const [scaleScrollLeft, setScaleScrollLeft] = useState(0);
  const [draggingMaxEnd, setDraggingMaxEnd] = useState<number>(0);
  const [hoverTrackIndex, setHoverTrackIndex] = useState<number | null>(null);
  const [isHoverAboveFirstTrack, setIsHoverAboveFirstTrack] = useState<boolean>(false);
  const [preserveEmptyTracks, setPreserveEmptyTracks] = useState<boolean>(false);
  const dragSourceTrackRef = useRef<number | null>(null);
  const lastSnapRef = useRef<{ time: number; isSnapped: boolean }>({
    time: 0,
    isSnapped: false,
  });

  // calculatetimelinescale
  const scaleParams = useMemo(() => {
    let timeScaleValue: number;
    let fixedScaleWidth: number;

    switch (scale) {
      case 1:
        timeScaleValue = 60;
        fixedScaleWidth = 100;
        break;
      case 2:
        timeScaleValue = 30;
        fixedScaleWidth = 100;
        break;
      case 3:
        timeScaleValue = 20;
        fixedScaleWidth = 100;
        break;
      case 4:
        timeScaleValue = 15;
        fixedScaleWidth = 100;
        break;
      case 5:
        timeScaleValue = 10;
        fixedScaleWidth = 100;
        break;
      case 6:
        timeScaleValue = 5;
        fixedScaleWidth = 100;
        break;
      case 7:
        timeScaleValue = 3;
        fixedScaleWidth = 100;
        break;
      case 8:
        timeScaleValue = 2;
        fixedScaleWidth = 100;
        break;
      case 9:
        timeScaleValue = 1;
        fixedScaleWidth = 100;
        break;
      case 10:
        timeScaleValue = 1;
        fixedScaleWidth = 150;
        break;
      default:
        timeScaleValue = 10;
        fixedScaleWidth = 100;
    }

    const pixelsPerSecond = fixedScaleWidth / timeScaleValue;
    return { timeScaleValue, pixelsPerSecond, fixedScaleWidth };
  }, [scale]);

  const { pixelsPerSecond, timeScaleValue, fixedScaleWidth } = scaleParams;

  // track handle
  const trackData = useMemo(() => {
    const tracks: { [key: number]: TimelineClip[] } = {};
    clips.forEach((clip: TimelineClip) => {
      if (!tracks[clip.trackIndex]) {
        tracks[clip.trackIndex] = [];
      }
      tracks[clip.trackIndex].push(clip);
    });

    if (preserveEmptyTracks) {
      const maxTrackIndex = Math.max(...Object.keys(tracks).map(Number), 0);
      const allTracks: { [key: number]: TimelineClip[] } = {};
      for (let i = 0; i <= maxTrackIndex; i++) {
        allTracks[i] = tracks[i] || [];
      }
      return {
        tracks: allTracks,
        trackCount: maxTrackIndex + 1,
        trackIndexMap: {},
      };
    }

    const usedTrackIndexes = Object.keys(tracks)
      .map(Number)
      .filter((index) => tracks[index].length > 0)
      .sort((a, b) => a - b);

    const trackCount = usedTrackIndexes.length;
    const trackIndexMap: { [oldIndex: number]: number } = {};
    usedTrackIndexes.forEach((oldIndex, newIndex) => {
      trackIndexMap[oldIndex] = newIndex;
    });

    const remappedTracks: { [key: number]: TimelineClip[] } = {};
    usedTrackIndexes.forEach((oldIndex, newIndex) => {
      remappedTracks[newIndex] = tracks[oldIndex];
    });

    return {
      tracks: remappedTracks,
      trackCount,
      trackIndexMap,
    };
  }, [clips, preserveEmptyTracks]);

  // listentrack
  useEffect(() => {
    if (preserveEmptyTracks) return;
    if (trackData.trackIndexMap) {
      const needsRemapping = Object.keys(trackData.trackIndexMap).some(
        (oldIndex) => Number(oldIndex) !== trackData.trackIndexMap[Number(oldIndex)]
      );
      if (needsRemapping) {
        const updatedClips = clips.map((c: TimelineClip) => ({
          ...c,
          trackIndex: trackData.trackIndexMap[c.trackIndex] ?? c.trackIndex,
        }));
        setClips(updatedClips);
      }
    }
  }, [trackData.trackIndexMap, preserveEmptyTracks, clips, setClips]);

  // comment
  const snapModifier: Modifier = ({ transform, active }) => {
    if (!isDragging || !active) return transform;

    const itemId = String(active.id);
    const clip = clips.find((c: TimelineClip) => c.id === itemId);
    if (!clip) return transform;

    const deltaTime = transform.x / pixelsPerSecond;
    const newStart = Math.max(0, clip.start + deltaTime);

    const snapResult = snapToPosition(newStart, currentTime, clips, itemId);
    const snappedStart = snapResult.time;

    const snapDistance = Math.abs(newStart - snappedStart);
    const breakAwayThreshold = 0.15;

    if (lastSnapRef.current.isSnapped) {
      const distanceFromLastSnap = Math.abs(newStart - lastSnapRef.current.time);
      if (distanceFromLastSnap < breakAwayThreshold) {
        return {
          ...transform,
          x: (lastSnapRef.current.time - clip.start) * pixelsPerSecond,
        };
      }
      lastSnapRef.current.isSnapped = false;
    }

    if (snapDistance < 0.1 && snapResult.snapLines.length > 0) {
      lastSnapRef.current = { time: snappedStart, isSnapped: true };
      const snapOffset = (snappedStart - clip.start) * pixelsPerSecond;
      return {
        ...transform,
        x: snapOffset,
      };
    }

    return transform;
  };

  const resetSnap = () => {
    lastSnapRef.current = { time: 0, isSnapped: false };
  };

  // handle
  const handleScroll = () => {
    if (scrollbarRef.current) {
      const scrollLeft = scrollbarRef.current.scrollLeft;
      setScaleScrollLeft(scrollLeft);
    }
  };

  const getScrollLeft = () => scrollbarRef.current?.scrollLeft || 0;

  // handleclip
  const handleClipResize = (clipId: string, newStart: number, newEnd: number, edge: 'left' | 'right') => {
    const clip = clips.find((c: TimelineClip) => c.id === clipId);
    if (!clip) return;

    const media = mediaItems.find((m: MediaItem) => m.id === clip.mediaId);
    const snappedStart = snapToPosition(newStart, currentTime, clips, clipId).time;
    const snappedEnd = snapToPosition(newEnd, currentTime, clips, clipId).time;

    let finalStart = snappedStart;
    let finalEnd = snappedEnd;
    let newTrimStart: number | undefined;
    let newTrimEnd: number | undefined;

    if (media) {
      const oldTrimStart = clip.trimStart || 0;
      const currentClipDuration = clip.end - clip.start;
      const clipSpeed = clip.speed || 1;
      // calculateactual asset （ ）
      const actualMediaDuration = currentClipDuration * clipSpeed;
      const oldTrimEnd = clip.trimEnd ?? (media.duration ? media.duration : oldTrimStart + actualMediaDuration);
      const originalDuration = media.duration || Math.max(oldTrimEnd, oldTrimStart + actualMediaDuration);

      if (media.type === 'video' || media.type === 'audio') {
        if (edge === 'left') {
          const startDelta = snappedStart - clip.start;
          // ：timelineup need to speed asset
          const trimStartDelta = startDelta * clipSpeed;
          const calculatedTrimStart = oldTrimStart + trimStartDelta;
          const safeOldTrimEnd = oldTrimEnd ?? 0;
          // trimStart 0， trimEnd
          newTrimStart = Math.max(0, Math.min(calculatedTrimStart, safeOldTrimEnd - 0.1));
          // based on trimStart trimEnd calculatetimelineup （need to ）
          const trimmedDuration = (safeOldTrimEnd - newTrimStart) / clipSpeed;
          finalStart = snappedStart;
          finalEnd = snappedStart + trimmedDuration;
          newTrimEnd = safeOldTrimEnd;
        } else {
          const endDelta = snappedEnd - clip.end;
          const safeOldTrimEnd = oldTrimEnd ?? 0;
          // ：timelineup need to speed asset
          const trimEndDelta = endDelta * clipSpeed;
          let calculatedTrimEnd = safeOldTrimEnd + trimEndDelta;
          calculatedTrimEnd = Math.max(oldTrimStart + 0.1, Math.min(calculatedTrimEnd, originalDuration));
          newTrimEnd = calculatedTrimEnd;
          const trimmedDuration = (newTrimEnd - oldTrimStart) / clipSpeed;
          finalStart = clip.start;
          finalEnd = clip.start + trimmedDuration;
          newTrimStart = oldTrimStart;
        }
      } else {
        finalStart = snappedStart;
        finalEnd = snappedEnd;
      }
    }

    const willCollide = checkCollision(clips, clipId, clip.trackIndex, finalStart, finalEnd);
    if (willCollide) {
      return;
    }

    const updates: Partial<TimelineClip> = { start: finalStart, end: finalEnd };
    if (newTrimStart !== undefined) {
      updates.trimStart = newTrimStart;
    }
    if (newTrimEnd !== undefined) {
      updates.trimEnd = newTrimEnd;
    }
    updateClip(clipId, updates);
    setSnapLines([]);
  };

  // handle start
  const handleDragStart = (event: DragStartEvent) => {
    setIsDragging(true);
    setDraggingMaxEnd(0);
    setHoverTrackIndex(null);
    setIsHoverAboveFirstTrack(false);
    setPreserveEmptyTracks(false);

    const itemId = String(event.active.id);
    setDraggingClipId(itemId);
    const clip = clips.find((c: TimelineClip) => c.id === itemId);
    if (clip) {
      dragSourceTrackRef.current = clip.trackIndex;
    }

    resetSnap();
  };

  // handle
  const handleDragMove = (event: DragMoveEvent) => {
    const { active, delta, over } = event;
    if (!active) return;
    const itemId = String(active.id);
    const clip = clips.find((c: TimelineClip) => c.id === itemId);
    if (!clip) return;

    const deltaTime = delta.x / pixelsPerSecond;
    const newStart = Math.max(0, clip.start + deltaTime);
    const clipDuration = clip.end - clip.start;
    const newEnd = newStart + clipDuration;

    setDraggingMaxEnd((prev) => Math.max(prev, newEnd));

    const snapResultStart = snapToPosition(newStart, currentTime, clips, itemId);
    const snapResultEnd = snapToPosition(newEnd, currentTime, clips, itemId);
    const allSnapLines = Array.from(new Set([...snapResultStart.snapLines, ...snapResultEnd.snapLines]));
    setSnapLines(allSnapLines);

    if (over && over.id) {
      const overTrackId = String(over.id);

      // handle top region
      if (overTrackId === 'track-top') {
        setIsHoverAboveFirstTrack(true);
        setHoverTrackIndex(null);
        return;
      }

      if (overTrackId.startsWith('track-')) {
        const overTrackIndex = parseInt(overTrackId.replace('track-', ''));

        // track track
        const targetTrackClips = clips.filter((c: TimelineClip) => c.trackIndex === overTrackIndex && c.id !== itemId);

        let hasOverlap = false;
        for (const targetClip of targetTrackClips) {
          if (newStart < targetClip.end && newEnd > targetClip.start) {
            hasOverlap = true;
            break;
          }
        }

        if (hasOverlap) {
          // if track
          if (overTrackIndex === dragSourceTrackRef.current) {
            // track ：check track otherasset
            const trackHasOthers = clips.some((c: TimelineClip) => c.id !== itemId && c.trackIndex === overTrackIndex);

            if (trackHasOthers) {
              setHoverTrackIndex(overTrackIndex);
              setIsHoverAboveFirstTrack(false);
            } else {
              setHoverTrackIndex(null);
              setIsHoverAboveFirstTrack(false);
            }
          } else {
            // track
            setHoverTrackIndex(overTrackIndex);
            setIsHoverAboveFirstTrack(false);
          }
        } else {
          // no ，check 0 track upexceed20px
          if (overTrackIndex === 0) {
            const trackHeight = 42;
            const sourceTrackIndex = dragSourceTrackRef.current || 0;
            const adjustedDeltaY = delta.y + sourceTrackIndex * trackHeight;
            const verticalThreshold = -20;

            if (adjustedDeltaY < verticalThreshold) {
              setIsHoverAboveFirstTrack(true);
              setHoverTrackIndex(null);
            } else {
              setHoverTrackIndex(null);
              setIsHoverAboveFirstTrack(false);
            }
            return;
          }
          // 0 track ，normal
          setHoverTrackIndex(null);
          setIsHoverAboveFirstTrack(false);
        }
      }
    } else {
      setHoverTrackIndex(null);
      setIsHoverAboveFirstTrack(false);
    }
  };

  // handle end
  const handleDragEnd = (event: DragEndEvent) => {
    const { active, over, delta } = event;

    const shouldInsertTrack = hoverTrackIndex !== null || isHoverAboveFirstTrack;
    const shouldInsertAtTop = isHoverAboveFirstTrack;
    const insertAtTrackIndex = isHoverAboveFirstTrack ? 0 : hoverTrackIndex;
    const sourceTrackIndex = dragSourceTrackRef.current;

    setSnapLines([]);
    setIsDragging(false);
    setDraggingClipId(null);
    setDraggingMaxEnd(0);
    setHoverTrackIndex(null);
    setIsHoverAboveFirstTrack(false);
    dragSourceTrackRef.current = null;

    if (!over) {
      return;
    }

    const itemId = String(active.id);
    const newRowId = String(over.id);

    const clip = clips.find((c: TimelineClip) => c.id === itemId);
    if (!clip) {
      return;
    }

    const deltaTime = delta.x / pixelsPerSecond;
    const newStart = Math.max(0, clip.start + deltaTime);
    const clipDuration = clip.end - clip.start;

    let finalStart = newStart;
    let finalEnd = newStart + clipDuration;

    if (Math.abs(deltaTime) > 0.01) {
      const snapResult = snapToPosition(newStart, currentTime, clips, itemId);
      finalStart = snapResult.time;
      finalEnd = finalStart + clipDuration;
    }

    let newTrackIndex = 0;
    if (newRowId === 'track-top') {
      newTrackIndex = 0;
    } else {
      newTrackIndex = parseInt(newRowId.replace('track-', ''));
    }

    // if track
    if (shouldInsertTrack && insertAtTrackIndex !== null && sourceTrackIndex !== null) {
      // specialhandle：newly addedtoptrack
      if (shouldInsertAtTop) {
        // set ，keep track
        setPreserveEmptyTracks(true);
        // asset track0
        newTrackIndex = 0;
        const updatedClips = clips.map((c: TimelineClip) => {
          if (c.id === itemId) {
            const updated: TimelineClip = { ...c, trackIndex: 0 };
            if (Math.abs(deltaTime) > 0.01) {
              updated.start = finalStart;
              updated.end = finalEnd;
            }
            return updated;
          }
          // allotherasset：down track
          return { ...c, trackIndex: c.trackIndex + 1 };
        });

        // batch allupdate
        setClips(updatedClips);

        // restore ， track automatically
        setPreserveEmptyTracks(false);

        return;
      }

      // normal
      // set ，keep track
      setPreserveEmptyTracks(true);

      // asset track
      newTrackIndex = insertAtTrackIndex;

      // 【key 】check track otherasset
      const sourceTrackHasOtherClips = clips.some((c: TimelineClip) => c.id !== itemId && c.trackIndex === sourceTrackIndex);

      // 【keyfix】 create allupdate clips （ asset track time）
      const updatedClips = clips.map((c: TimelineClip) => {
        // asset： track + updatetime
        if (c.id === itemId) {
          const updated: TimelineClip = { ...c, trackIndex: newTrackIndex };
          // if time ， update
          if (Math.abs(deltaTime) > 0.01) {
            updated.start = finalStart;
            updated.end = finalEnd;
          }
          return updated;
        }

        // if track otherasset：newly addedtrack
        if (sourceTrackHasOtherClips) {
          // all start asset down
          if (c.trackIndex >= insertAtTrackIndex) {
            return { ...c, trackIndex: c.trackIndex + 1 };
          }
        } else {
          // tracknootherasset： logic
          // up ：middleassetdown
          if (insertAtTrackIndex < sourceTrackIndex) {
            if (c.trackIndex >= insertAtTrackIndex && c.trackIndex < sourceTrackIndex) {
              return { ...c, trackIndex: c.trackIndex + 1 };
            }
            return c;
          }
          // down ：middleassetup
          if (insertAtTrackIndex > sourceTrackIndex) {
            if (c.trackIndex > sourceTrackIndex && c.trackIndex <= insertAtTrackIndex) {
              return { ...c, trackIndex: c.trackIndex - 1 };
            }
          }
        }

        return c;
      });

      // batch allupdate
      setClips(updatedClips);

      // restore ， track
      setPreserveEmptyTracks(false);

      // dragend
      return; // batchupdate ，
    }
    // normaldrag ：check
    const willCollide = checkCollision(clips, itemId, newTrackIndex, finalStart, finalEnd);

    if (willCollide) {
      console.warn('⚠️ 碰撞检测：无法将素材移动到此位置（与其他素材重叠）');
      return;
    }

    // update asset track time
    const updates: Partial<TimelineClip> = {};

    if (clip.trackIndex !== newTrackIndex) {
      updates.trackIndex = newTrackIndex;
    }

    if (Math.abs(deltaTime) > 0.01) {
      updates.start = finalStart;
      updates.end = finalEnd;
    }

    if (Object.keys(updates).length > 0) {
      updateClip(itemId, updates);
    }
  };

  // calculatetimetickwidth
  const { displayDuration, scaleContainerWidth } = useMemo(() => {
    const containerWidth = containerRef.current?.clientWidth || window.innerWidth - 270;
    const startLeftOffset = 20;
    const endRightOffset = 20; // right offset
    const availableWidth = containerWidth - startLeftOffset - endRightOffset;

    // calculateasset （ ）
    const maxClipEnd = clips.length > 0 ? Math.max(...clips.map((c: TimelineClip) => c.end)) : 0;
    const actualMaxEnd = Math.max(maxClipEnd, draggingMaxEnd);

    // timeline asset 5sec
    const minTimelineDuration = actualMaxEnd + 5;

    // containerwidthcorresponding
    const containerDisplayTime = availableWidth / pixelsPerSecond;

    // useasset +5sec container （ensure asset ，width containerwidth）
    const displayDuration = Math.max(minTimelineDuration, containerDisplayTime);

    const requiredWidth = displayDuration * pixelsPerSecond + startLeftOffset + endRightOffset;
    const width = Math.max(requiredWidth, containerWidth);

    return {
      displayDuration,
      scaleContainerWidth: width,
    };
  }, [clips, pixelsPerSecond, draggingMaxEnd]);

  // automatically ：keepplayback region
  useEffect(() => {
    if (!scrollbarRef.current) return;

    const playheadPosition = currentTime * pixelsPerSecond + 20;
    const scrollLeft = scrollbarRef.current.scrollLeft;
    const containerWidth = scrollbarRef.current.clientWidth;
    const visibleLeft = scrollLeft;
    const visibleRight = scrollLeft + containerWidth;

    if (playheadPosition < visibleLeft + 50) {
      scrollbarRef.current.scrollLeft = Math.max(0, playheadPosition - 100);
    } else if (playheadPosition > visibleRight - 50) {
      scrollbarRef.current.scrollLeft = playheadPosition - containerWidth + 100;
    }
  }, [currentTime, pixelsPerSecond]);

  // handlebox selectstart
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const handleSelectStart = useCallback((e: any) => {
    // if drag clip， box select
    if (isDragging) {
      e.stop();
      return;
    }
    // if clip ， box select（ drag ）
    const target = e.inputEvent?.target as HTMLElement;
    if (target && (target.id?.startsWith('timeline-clip-') || target.closest('[id^="timeline-clip-"]'))) {
      // check up
      const isResizeHandle = target.closest('.cursor-ew-resize');
      if (!isResizeHandle) {
        // ， drag clip， box select
        e.stop();
      }
    }
  }, [isDragging]);

  // handlebox select - preventother
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const handleSelectMove = useCallback((e: any) => {
    // prevent
    if (e.inputEvent) {
      e.inputEvent.stopPropagation();
    }
  }, []);

  // handlebox selectend
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const handleSelectEnd = useCallback((e: any) => {
    const { selected, inputEvent } = e;

    // if drag clip， handlebox select
    if (isDragging) {
      return;
    }

    // selected DOM clip IDs
    const selectedIds: string[] = [];
    if (selected && Array.isArray(selected)) {
      selected.forEach((el: HTMLElement) => {
        const elementId = el.id;
        if (elementId && elementId.startsWith('timeline-clip-')) {
          const clipId = elementId.replace('timeline-clip-', '');
          if (!selectedIds.includes(clipId)) {
            selectedIds.push(clipId);
          }
        }
      });
    }

    // support Shift multi-select
    if (inputEvent?.shiftKey && selectedIds.length > 0) {
      // selected
      const currentSelected = Array.isArray(selectedClipId) ? selectedClipId : Array.from(selectedClipId || []) as string[];
      const newSelected = Array.from(new Set([...currentSelected, ...selectedIds])) as string[];
      setSelectedClipId(newSelected);
    } else if (selectedIds.length > 0) {
      // selected updateselected
      setSelectedClipId(selectedIds);
    } else if (!inputEvent || (inputEvent.target as HTMLElement) === containerRef.current) {
      // region clearselected（ drag clip ）
      if (!isDragging) {
        setSelectedClipId([]);
      }
    }
  }, [isDragging, selectedClipId, setSelectedClipId]);

  // handle clearselected
  const handleContainerClick = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    // （ clip） clearselected
    const target = e.target as HTMLElement;
    const isClip = target.id?.startsWith('timeline-clip-') || target.closest('[id^="timeline-clip-"]');
    const isResizeHandle = target.closest('.cursor-ew-resize');
    if (!isClip && !isResizeHandle && target === e.currentTarget) {
      setSelectedClipId([]);
    }
  }, [setSelectedClipId]);

  // handle trackcontainer clearselected
  const handleTrackContainerClick = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    // （ clip） clearselected
    const target = e.target as HTMLElement;
    const isClip = target.id?.startsWith('timeline-clip-') || target.closest('[id^="timeline-clip-"]');
    const isResizeHandle = target.closest('.cursor-ew-resize');
    const isTrackRow = target.closest('[class*="track-"]') || target.closest('.bg-background-default-secondary');
    // if container track （ clip），clearselected
    if (!isClip && !isResizeHandle && (target === e.currentTarget || isTrackRow)) {
      setSelectedClipId([]);
    }
  }, [setSelectedClipId]);

  return (
    <div
      className='relative flex flex-col h-full bg-white nowheel nodrag nopan'
      data-nowheel='true'
      data-nodrag='true'
      data-nopan='true'
      onClick={(e) => {
        if (e.target === e.currentTarget) {
          setSelectedClipId([]);
        }
      }}
    >
      {/* top region：playback */}
      <div className='h-2.5 bg-background-default-base shrink-0 relative' />

      {/* timetick - top */}
      <div
        ref={scaleRef}
        className='sticky top-0 w-full h-8 bg-background-default-base shrink-0 cursor-pointer overflow-hidden'
        onClick={(e) => {
          e.stopPropagation();
          const scaleRect = scaleRef.current?.getBoundingClientRect();
          if (!scaleRect) return;

          const relativeX = (e.clientX - scaleRect.left) / reactflowScale;
          const clickX = relativeX + scaleScrollLeft - 20;
          const maxClipEnd = clips.length > 0 ? Math.max(...clips.map((c: TimelineClip) => c.end)) : 0;
          const playheadWidthTime = 2 / pixelsPerSecond;
          const maxClickTime = maxClipEnd - playheadWidthTime;
          const clickTime = Math.max(0, Math.min(clickX / pixelsPerSecond, maxClickTime));
          handleTimeChange(clickTime);
        }}
      >
        <div style={{ transform: `translateX(-${scaleScrollLeft}px)` }}>
          <TimelineScale
            scale={timeScaleValue}
            scaleSplitCount={5}
            scaleWidth={fixedScaleWidth}
            startLeft={20}
            width={scaleContainerWidth}
            height={32}
            displayDuration={displayDuration}
          />
        </div>
      </div>

      {/* track region */}
      <div className='bg-background-default-base flex-1 overflow-y-auto'>
        <div
          ref={scrollbarRef}
          className='flex-1 h-full overflow-auto'
          onScroll={handleScroll}
        >
          <div
            ref={containerRef}
            className='h-full'
            onClick={handleTrackContainerClick}
          >
            <DndContext
              onDragStart={handleDragStart}
              onDragEnd={handleDragEnd}
              onDragMove={handleDragMove}
              modifiers={[snapModifier]}
              collisionDetection={closestCenter}
            >
              <div
                className='relative pt-2.5 overflow-visible h-full'
                style={{ minWidth: `${scaleContainerWidth}px` }}
                onClick={handleContainerClick}
              >
                {/* top region（used for top） */}
                {trackData.trackCount > 0 && (
                  <TopDropZone onClick={handleContainerClick} />
                )}

                {/* track - display asset track */}
                {trackData.trackCount === 0 ? (
                  <div className='text-center p-10 text-gray-400 text-sm'>
                    {t('timeline.addMediaPrompt') || ' time '}
                  </div>
                ) : (
                  <>
                    <TimelineTracks
                      pixelsPerSecond={pixelsPerSecond}
                      currentTime={currentTime}
                      onClipResize={handleClipResize}
                      onShowSnapLines={setSnapLines}
                      hoverTrackIndex={hoverTrackIndex}
                      isHoverAboveFirstTrack={isHoverAboveFirstTrack}
                      draggingClipId={draggingClipId}
                      nodeId={nodeId}
                      parentRef={scrollbarRef}
                      parentScrollRef={scrollbarRef}
                    />
                  </>
                )}
              </div>
            </DndContext>
          </div>
        </div>
      </div>

      {/* line（ line） */}
      {snapLines.map((snapTime) => (
        <div
          key={`snap-${snapTime}`}
          className='absolute top-0 h-full w-0 z-[5] pointer-events-none border-l-2 border-dashed border-blue-500 opacity-80'
          style={{ left: `${snapTime * pixelsPerSecond + 20}px` }}
        />
      ))}

      {/* playback - ， */}
      {trackData.trackCount > 0 && (
        <div className='absolute top-[18px] left-0 right-0 bottom-0 pointer-events-none z-20'>
          <PlaybackCursor
            currentTime={currentTime}
            pixelsPerSecond={pixelsPerSecond}
            onTimeChange={handleTimeChange}
            onShowSnapLines={setSnapLines}
            containerRef={containerRef}
            scrollLeft={scaleScrollLeft}
            getScrollLeft={getScrollLeft}
            reactflowScale={reactflowScale}
          />
        </div>
      )}

      {/* Selecto box selectcomponent */}
      {containerRef.current && (
        <Selecto
          ref={selectoRef}
          container={containerRef.current}
          dragContainer={containerRef.current}
          rootContainer={containerRef.current}
          selectableTargets={['[id^="timeline-clip-"]', '[data-selectable="true"]']}
          hitRate={0} // selected
          selectByClick={false} // selected， box select
          selectFromInside={false} // box select
          toggleContinueSelect={['shift']} // Shift
          ratio={0} // comment
          boundContainer={containerRef.current} // region container
          checkInput={false} // check
          preventClickEventOnDrag={true} // prevent
          preventDefault={false} // preventdefault ， box select
          onDragStart={handleSelectStart}
          onDrag={handleSelectMove}
          onSelectEnd={handleSelectEnd}
        />
      )}
    </div>
  );
};

export default memo(TimelineEditor);

