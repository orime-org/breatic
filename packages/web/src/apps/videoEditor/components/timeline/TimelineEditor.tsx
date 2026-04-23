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

// 检查片段碰撞
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

// 智能吸附位置计算
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

// 顶部空白区域组件（用于拖拽到顶部）
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

  // 使用 useVideoEditorStore hook
  const {
    clips,
    mediaItems,
    updateClip,
    setClips,
    setSelectedClipId,
    selectedClipId,
  } = useVideoEditorStore(nodeId);

  const selectoRef = useRef<Selecto>(null);

  // 组件内部的处理函数
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

  // 计算时间轴缩放参数
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

  // 轨道数据处理
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

  // 监听轨道映射变化
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

  // 吸附修饰器
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

  // 处理滚动事件
  const handleScroll = () => {
    if (scrollbarRef.current) {
      const scrollLeft = scrollbarRef.current.scrollLeft;
      setScaleScrollLeft(scrollLeft);
    }
  };

  const getScrollLeft = () => scrollbarRef.current?.scrollLeft || 0;

  // 处理片段调整大小
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
      // 计算实际的素材时长（考虑倍速）
      const actualMediaDuration = currentClipDuration * clipSpeed;
      const oldTrimEnd = clip.trimEnd ?? (media.duration ? media.duration : oldTrimStart + actualMediaDuration);
      const originalDuration = media.duration || Math.max(oldTrimEnd, oldTrimStart + actualMediaDuration);

      if (media.type === 'video' || media.type === 'audio') {
        if (edge === 'left') {
          const startDelta = snappedStart - clip.start;
          // 考虑倍速：时间轴上的变化需要乘以 speed 才是素材时长的变化
          const trimStartDelta = startDelta * clipSpeed;
          const calculatedTrimStart = oldTrimStart + trimStartDelta;
          const safeOldTrimEnd = oldTrimEnd ?? 0;
          // 限制 trimStart 不能小于 0，且不能超过 trimEnd
          newTrimStart = Math.max(0, Math.min(calculatedTrimStart, safeOldTrimEnd - 0.1));
          // 根据新的 trimStart 和 trimEnd 计算时间轴上的时长（需要考虑倍速）
          const trimmedDuration = (safeOldTrimEnd - newTrimStart) / clipSpeed;
          finalStart = snappedStart;
          finalEnd = snappedStart + trimmedDuration;
          newTrimEnd = safeOldTrimEnd;
        } else {
          const endDelta = snappedEnd - clip.end;
          const safeOldTrimEnd = oldTrimEnd ?? 0;
          // 考虑倍速：时间轴上的变化需要乘以 speed 才是素材时长的变化
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

  // 处理拖动开始
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

  // 处理拖动过程
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

      // 处理拖动到顶部空白区域
      if (overTrackId === 'track-top') {
        setIsHoverAboveFirstTrack(true);
        setHoverTrackIndex(null);
        return;
      }

      if (overTrackId.startsWith('track-')) {
        const overTrackIndex = parseInt(overTrackId.replace('track-', ''));

        // 检测同一轨道或不同轨道的重叠
        const targetTrackClips = clips.filter((c: TimelineClip) => c.trackIndex === overTrackIndex && c.id !== itemId);

        let hasOverlap = false;
        for (const targetClip of targetTrackClips) {
          if (newStart < targetClip.end && newEnd > targetClip.start) {
            hasOverlap = true;
            break;
          }
        }

        if (hasOverlap) {
          // 如果是同一轨道
          if (overTrackIndex === dragSourceTrackRef.current) {
            // 同一轨道内的重叠：检查该轨道是否还有其他素材
            const trackHasOthers = clips.some((c: TimelineClip) => c.id !== itemId && c.trackIndex === overTrackIndex);

            if (trackHasOthers) {
              setHoverTrackIndex(overTrackIndex);
              setIsHoverAboveFirstTrack(false);
            } else {
              setHoverTrackIndex(null);
              setIsHoverAboveFirstTrack(false);
            }
          } else {
            // 不同轨道的重叠
            setHoverTrackIndex(overTrackIndex);
            setIsHoverAboveFirstTrack(false);
          }
        } else {
          // 没有重叠，检查是否是0号轨道且向上超出20px
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
          // 非0号轨道且无重叠，普通移动
          setHoverTrackIndex(null);
          setIsHoverAboveFirstTrack(false);
        }
      }
    } else {
      setHoverTrackIndex(null);
      setIsHoverAboveFirstTrack(false);
    }
  };

  // 处理拖动结束
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

    // 如果是轨道插入模式
    if (shouldInsertTrack && insertAtTrackIndex !== null && sourceTrackIndex !== null) {
      // 特殊处理：新增顶部轨道
      if (shouldInsertAtTop) {
        // 设置标志，保留空轨道
        setPreserveEmptyTracks(true);
        // 将拖动素材移动到轨道0
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
          // 所有其他素材：下移一个轨道
          return { ...c, trackIndex: c.trackIndex + 1 };
        });

        // 批量应用所有更新
        setClips(updatedClips);

        // 立即恢复正常模式，空轨道将被自动清理
        setPreserveEmptyTracks(false);

        return;
      }

      // 普通插入模式
      // 设置标志，保留空轨道
      setPreserveEmptyTracks(true);

      // 将拖动素材移动到目标轨道
      newTrackIndex = insertAtTrackIndex;

      // 【关键判断】检查源轨道是否还有其他素材
      const sourceTrackHasOtherClips = clips.some((c: TimelineClip) => c.id !== itemId && c.trackIndex === sourceTrackIndex);

      // 【关键修复】一次性创建包含所有更新的clips数组（包括拖动素材的轨道和时间）
      const updatedClips = clips.map((c: TimelineClip) => {
        // 拖动素材：移到目标轨道 + 更新时间
        if (c.id === itemId) {
          const updated: TimelineClip = { ...c, trackIndex: newTrackIndex };
          // 如果有时间变化，也一起更新
          if (Math.abs(deltaTime) > 0.01) {
            updated.start = finalStart;
            updated.end = finalEnd;
          }
          return updated;
        }

        // 如果源轨道还有其他素材：新增轨道模式
        if (sourceTrackHasOtherClips) {
          // 所有从插入位置开始的素材都下移
          if (c.trackIndex >= insertAtTrackIndex) {
            return { ...c, trackIndex: c.trackIndex + 1 };
          }
        } else {
          // 源轨道没有其他素材：原有逻辑
          // 往上拖动：中间素材下移
          if (insertAtTrackIndex < sourceTrackIndex) {
            if (c.trackIndex >= insertAtTrackIndex && c.trackIndex < sourceTrackIndex) {
              return { ...c, trackIndex: c.trackIndex + 1 };
            }
            return c;
          }
          // 往下拖动：中间素材上移
          if (insertAtTrackIndex > sourceTrackIndex) {
            if (c.trackIndex > sourceTrackIndex && c.trackIndex <= insertAtTrackIndex) {
              return { ...c, trackIndex: c.trackIndex - 1 };
            }
          }
        }

        return c;
      });

      // 批量应用所有更新
      setClips(updatedClips);

      // 立即恢复正常模式，清理空轨道
      setPreserveEmptyTracks(false);

      // 调用拖拽结束回调
      return; // 已经批量更新完成，直接返回
    }
    // 普通拖拽模式：检查碰撞
    const willCollide = checkCollision(clips, itemId, newTrackIndex, finalStart, finalEnd);

    if (willCollide) {
      console.warn('⚠️ 碰撞检测：无法将素材移动到此位置（与其他素材重叠）');
      return;
    }

    // 更新拖动素材的轨道和时间
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

  // 计算时间刻度宽度
  const { displayDuration, scaleContainerWidth } = useMemo(() => {
    const containerWidth = containerRef.current?.clientWidth || window.innerWidth - 270;
    const startLeftOffset = 20;
    const endRightOffset = 20; // 右侧安全距离
    const availableWidth = containerWidth - startLeftOffset - endRightOffset;

    // 计算素材的最远位置（考虑拖动中的位置）
    const maxClipEnd = clips.length > 0 ? Math.max(...clips.map((c: TimelineClip) => c.end)) : 0;
    const actualMaxEnd = Math.max(maxClipEnd, draggingMaxEnd);

    // 时间轴长度比最大素材长5秒
    const minTimelineDuration = actualMaxEnd + 5;

    // 容器宽度对应的时长
    const containerDisplayTime = availableWidth / pixelsPerSecond;

    // 使用素材时长+5秒和容器时长的最大值（确保即使素材减少，宽度也不会小于容器宽度）
    const displayDuration = Math.max(minTimelineDuration, containerDisplayTime);

    const requiredWidth = displayDuration * pixelsPerSecond + startLeftOffset + endRightOffset;
    const width = Math.max(requiredWidth, containerWidth);

    return {
      displayDuration,
      scaleContainerWidth: width,
    };
  }, [clips, pixelsPerSecond, draggingMaxEnd]);

  // 自动滚动：保持播放头在可见区域内
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

  // 处理框选开始
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const handleSelectStart = useCallback((e: any) => {
    // 如果正在拖拽 clip，不启动框选
    if (isDragging) {
      e.stop();
      return;
    }
    // 如果点击的是 clip 元素本身，不启动框选（让拖拽优先）
    const target = e.inputEvent?.target as HTMLElement;
    if (target && (target.id?.startsWith('timeline-clip-') || target.closest('[id^="timeline-clip-"]'))) {
      // 检查是否点击在调整大小的手柄上
      const isResizeHandle = target.closest('.cursor-ew-resize');
      if (!isResizeHandle) {
        // 不是调整大小手柄，可能是要拖拽 clip，停止框选
        e.stop();
      }
    }
  }, [isDragging]);

  // 处理框选移动 - 阻止其他事件
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const handleSelectMove = useCallback((e: any) => {
    // 阻止事件传播
    if (e.inputEvent) {
      e.inputEvent.stopPropagation();
    }
  }, []);

  // 处理框选结束
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const handleSelectEnd = useCallback((e: any) => {
    const { selected, inputEvent } = e;

    // 如果正在拖拽 clip，不处理框选
    if (isDragging) {
      return;
    }

    // 将选中的 DOM 元素转换为 clip IDs
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

    // 支持 Shift 键多选
    if (inputEvent?.shiftKey && selectedIds.length > 0) {
      // 合并选中项
      const currentSelected = Array.isArray(selectedClipId) ? selectedClipId : Array.from(selectedClipId || []) as string[];
      const newSelected = Array.from(new Set([...currentSelected, ...selectedIds])) as string[];
      setSelectedClipId(newSelected);
    } else if (selectedIds.length > 0) {
      // 有选中元素时更新选中状态
      setSelectedClipId(selectedIds);
    } else if (!inputEvent || (inputEvent.target as HTMLElement) === containerRef.current) {
      // 点击空白区域时清除选中（但不在拖拽 clip 时）
      if (!isDragging) {
        setSelectedClipId([]);
      }
    }
  }, [isDragging, selectedClipId, setSelectedClipId]);

  // 处理点击空白处清除选中
  const handleContainerClick = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    // 点击空白处（不是 clip）时清除选中
    const target = e.target as HTMLElement;
    const isClip = target.id?.startsWith('timeline-clip-') || target.closest('[id^="timeline-clip-"]');
    const isResizeHandle = target.closest('.cursor-ew-resize');
    if (!isClip && !isResizeHandle && target === e.currentTarget) {
      setSelectedClipId([]);
    }
  }, [setSelectedClipId]);

  // 处理点击轨道容器空白处清除选中
  const handleTrackContainerClick = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    // 点击空白处（不是 clip）时清除选中
    const target = e.target as HTMLElement;
    const isClip = target.id?.startsWith('timeline-clip-') || target.closest('[id^="timeline-clip-"]');
    const isResizeHandle = target.closest('.cursor-ew-resize');
    const isTrackRow = target.closest('[class*="track-"]') || target.closest('.bg-background-default-secondary');
    // 如果点击的是容器本身或轨道行（但不是 clip），清除选中
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
      {/* 顶部固定区域：播放头图标空间 */}
      <div className='h-2.5 bg-background-default-base shrink-0 relative' />

      {/* 时间刻度 - 固定在顶部 */}
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
            nodeId={nodeId}
            displayDuration={displayDuration}
          />
        </div>
      </div>

      {/* 轨道滚动区域 */}
      <div className='bg-background-default-base flex-1 overflow-y-auto'>
        <div ref={scrollbarRef} className='flex-1 h-full overflow-auto' onScroll={handleScroll}>
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
                {/* 顶部空白区域（用于插入到顶部） */}
                {trackData.trackCount > 0 && (
                  <TopDropZone onClick={handleContainerClick} />
                )}

                {/* 轨道 - 只显示有素材的轨道 */}
                {trackData.trackCount === 0 ? (
                  <div className='text-center p-10 text-gray-400 text-sm'>
                    {t('timeline.addMediaPrompt') || '添加素材到时间轴'}
                  </div>
                ) : (
                  <>
                    <TimelineTracks
                      pixelsPerSecond={pixelsPerSecond}
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

      {/* 吸附辅助线（虚线） */}
      {snapLines.map((snapTime) => (
        <div
          key={`snap-${snapTime}`}
          className='absolute top-0 h-full w-0 z-[5] pointer-events-none border-l-2 border-dashed border-blue-500 opacity-80'
          style={{ left: `${snapTime * pixelsPerSecond + 20}px` }}
        />
      ))}

      {/* 播放头游标 - 固定不滚动，跟随横向滚动 */}
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
            nodeId={nodeId}
          />
        </div>
      )}

      {/* Selecto 框选组件 */}
      {containerRef.current && (
        <Selecto
          ref={selectoRef}
          container={containerRef.current}
          dragContainer={containerRef.current}
          rootContainer={containerRef.current}
          selectableTargets={['[id^="timeline-clip-"]', '[data-selectable="true"]']}
          hitRate={0} // 允许选中部分重叠的元素
          selectByClick={false} // 禁用点击选中，只允许框选
          selectFromInside={false} // 允许从外部框选
          toggleContinueSelect={['shift']} // Shift 键继续选择
          ratio={0} // 不限制选择框的宽高比
          boundContainer={containerRef.current} // 限制选择区域在容器内
          checkInput={false} // 不检查输入元素
          preventClickEventOnDrag={true} // 拖动时阻止点击事件
          preventDefault={false} // 不阻止默认事件，让框选正常工作
          onDragStart={handleSelectStart}
          onDrag={handleSelectMove}
          onSelectEnd={handleSelectEnd}
        />
      )}
    </div>
  );
};

export default memo(TimelineEditor);

