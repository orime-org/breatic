/* eslint-disable @typescript-eslint/no-explicit-any */
import React, { useRef, useEffect, useState, memo, useCallback, forwardRef, useImperativeHandle } from 'react';
import { createPortal } from 'react-dom';
import Selecto from 'react-selecto';
import { useVideoEditorStore } from '@/app/hooks/useVideoEditorStore';
import { MediaItem, TimelineClip } from '@/spaces/timeline/types';
import VideoElement from './VideoElement';
import ImageElement from './ImageElement';
import TextElement from './TextElement';
import MoveableControl from './MoveableControl';
import InfiniteCanvas, { InfiniteCanvasRef } from './InfiniteCanvas';

export interface PreviewCanvasRef {
  centerCanvas: () => void;
}

interface PreviewCanvasProps {
  nodeId?: string;
  currentTime?: number;
  isPlaying?: boolean;
  canvasRatio?: string;
  forceUpdateTextRef?: { current: (() => void) | null };
  isFullscreen?: boolean;
}

const PreviewCanvas = forwardRef<PreviewCanvasRef, PreviewCanvasProps>(({
  nodeId,
  currentTime = 0,
  isPlaying = false,
  canvasRatio = '16:9',
  forceUpdateTextRef,
  isFullscreen = false,
}, ref) => {
  // 从 store 获取数据
  const { clips, mediaItems, selectedClipId, setSelectedClipId } = useVideoEditorStore();
  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLDivElement>(null);
  const selectoRef = useRef<Selecto>(null);
  const infiniteCanvasRef = useRef<InfiniteCanvasRef>(null);

  const moveableRef = useRef<{ getMoveable:() => any } | null>(null);
  const [containerSize, setContainerSize] = useState({ width: 0, height: 0 });
  const lastStableCanvasSizeRef = useRef({ width: 0, height: 0 });
  const isSelectingRef = useRef(false);

  // 处理框选开始 - 按照 moveable-master 案例实现
  const handleSelectStart = useCallback((e: any) => {
    const inputEvent = e.inputEvent;

    if (!inputEvent) return;

    const target = inputEvent.target as HTMLElement;
    const moveable = moveableRef.current?.getMoveable();

    // 标记开始框选
    isSelectingRef.current = true;

    const isElement = Boolean(target.closest('[id^="element-"]'));

    // 按照案例：检查是否是 MoveableControl 元素或素材元素本身
    // 如果是，则阻止 Selecto 处理
    const isMoveableElement = moveable?.isMoveableElement?.(target);

    if (isMoveableElement || isElement) {
      e.stop();
      isSelectingRef.current = false;
      return;
    }
  }, []);

  // 处理框选结束 - 按照 moveable-master 案例实现
  const handleSelectEnd = useCallback((e: any) => {
    const { isDragStart, selected, inputEvent } = e;

    // 将选中的 DOM 元素转换为 clip IDs
    const selectedIds: string[] = [];
    if (selected && Array.isArray(selected)) {
      selected.forEach((el: HTMLElement) => {
        const elementId = el.id;
        if (elementId && elementId.startsWith('element-')) {
          const clipId = elementId.replace('element-', '');
          if (!selectedIds.includes(clipId)) {
            selectedIds.push(clipId);
          }
        }
      });
    }

    const moveable = moveableRef.current?.getMoveable();

    // 按照案例：如果是拖动开始，使用 waitToChangeTarget 等待目标改变后再触发 dragStart
    if (isDragStart && inputEvent && moveable) {
      inputEvent.preventDefault();

      // 先更新选中状态
      setSelectedClipId(selectedIds);

      // 等待 Moveable 目标改变后再触发拖动
      moveable.waitToChangeTarget().then(() => {
        moveable.dragStart(inputEvent);
      });
    } else if ((inputEvent?.shiftKey || inputEvent?.metaKey || inputEvent?.ctrlKey) && selectedIds.length > 0) {
      const mergedSelected = Array.from(new Set([...selectedClipId, ...selectedIds]));
      setSelectedClipId(mergedSelected);
    } else {
      // 不是拖动开始，直接更新选中状态
      setSelectedClipId(selectedIds);
    }

    // 标记框选结束
    isSelectingRef.current = false;
  }, [selectedClipId, setSelectedClipId]);

  // 处理元素点击 - 支持 Shift 多选
  const handleElementClick = useCallback((e: React.MouseEvent, clipId: string) => {
    // 点击时，如果按住 Shift 键则多选，否则单选
    if (e.shiftKey) {
      if (selectedClipId.includes(clipId)) {
        // 如果已选中，则取消选中
        const newIds = selectedClipId.filter((id) => id !== clipId);
        setSelectedClipId(newIds);
      } else {
        // 如果未选中，则添加到选中列表
        const newIds = [...selectedClipId, clipId];
        setSelectedClipId(newIds);
      }
    } else {
      // 单选
      setSelectedClipId([clipId]);
    }
  }, [selectedClipId, setSelectedClipId]);

  const [initialCanvasSize, setInitialCanvasSize] = useState<{
    width: number;
    height: number;
  } | null>(null);
  const [isInitialCenterReady, setIsInitialCenterReady] = useState(isFullscreen);

  const videoRefs = useRef<{ [key: string]: HTMLVideoElement }>({});
  const audioRefs = useRef<{ [key: string]: HTMLAudioElement }>({});
  const textRefs = useRef<{ [key: string]: HTMLDivElement }>({});
  const isEditingRef = useRef<Set<string>>(new Set());

  // 根据画布比例获取虚拟坐标系统的基准尺寸
  const getBaseCanvasSize = (ratio: string): { width: number; height: number } => {
    switch (ratio) {
      case '16:9':
        return { width: 1920, height: 1080 };
      case '9:16':
        return { width: 1080, height: 1920 };
      case '1:1':
        return { width: 1080, height: 1080 };
      default:
        return { width: 1920, height: 1080 };
    }
  };

  const clipsRef = useRef(clips);
  useEffect(() => {
    clipsRef.current = clips;
  }, [clips]);

  useEffect(() => {
    if (forceUpdateTextRef) {
      forceUpdateTextRef.current = () => {
        isEditingRef.current.forEach((clipId) => {
          const textElement = textRefs.current[clipId];
          if (textElement && document.activeElement === textElement) {
            textElement.blur();
          }
        });
        isEditingRef.current.clear();

        clipsRef.current.forEach((clip: TimelineClip) => {
          if (clip.text !== undefined && textRefs.current[clip.id]) {
            const textElement = textRefs.current[clip.id];
            textElement.textContent = clip.text || 'Text';
          }
        });
      };
    }
  }, [forceUpdateTextRef]);

  useEffect(() => {
    if (!containerRef.current) return;

    const updateSize = () => {
      if (isFullscreen) {
        // 全屏时使用窗口尺寸
        setContainerSize({ width: window.innerWidth, height: window.innerHeight });
      } else if (containerRef.current) {
        const rect = containerRef.current.getBoundingClientRect();
        setContainerSize({ width: rect.width, height: rect.height });
      }
    };

    updateSize();

    if (isFullscreen) {
      // 全屏时监听窗口尺寸变化
      window.addEventListener('resize', updateSize);
      return () => {
        window.removeEventListener('resize', updateSize);
      };
    }

    // 非全屏时使用 ResizeObserver
    if (!containerRef.current) return;
    const resizeObserver = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const { width, height } = entry.contentRect;
        setContainerSize({ width, height });
      }
    });

    resizeObserver.observe(containerRef.current);

    return () => {
      resizeObserver.disconnect();
    };
  }, [isFullscreen]);

  const getCanvasSize = () => {
    if (!containerSize.width || !containerSize.height) {
      // ResizeObserver can briefly report 0x0 during layout recalculation.
      // Keep using the last stable size to avoid scale(0) flicker.
      if (lastStableCanvasSizeRef.current.width > 0 && lastStableCanvasSizeRef.current.height > 0) {
        return lastStableCanvasSizeRef.current;
      }
      return { width: 0, height: 0 };
    }

    let ratio: number;
    switch (canvasRatio) {
      case '16:9':
        ratio = 16 / 9;
        break;
      case '9:16':
        ratio = 9 / 16;
        break;
      case '1:1':
        ratio = 1;
        break;
      default:
        ratio = 16 / 9;
    }

    const padding = isFullscreen ? 0 : 200;
    const availableWidth = containerSize.width - padding;
    const availableHeight = containerSize.height - padding;

    const containerRatio = availableWidth / availableHeight;
    let canvasWidth, canvasHeight;

    if (containerRatio > ratio) {
      canvasHeight = availableHeight;
      canvasWidth = canvasHeight * ratio;
    } else {
      canvasWidth = availableWidth;
      canvasHeight = canvasWidth / ratio;
    }

    const calculatedSize = { width: canvasWidth, height: canvasHeight };
    lastStableCanvasSizeRef.current = calculatedSize;

    if (!isFullscreen) {
      if (!initialCanvasSize) {
        setInitialCanvasSize(calculatedSize);
      }
    } else if (initialCanvasSize) {
      setInitialCanvasSize(null);
    }

    return calculatedSize;
  };

  const canvasSize = getCanvasSize();
  const baseCanvasSize = getBaseCanvasSize(canvasRatio);

  // 居中画布的方法
  const centerCanvas = useCallback(() => {
    if (infiniteCanvasRef.current && baseCanvasSize && canvasSize.width > 0 && canvasSize.height > 0) {
      infiniteCanvasRef.current.centerCanvas();
    }
  }, [baseCanvasSize, canvasSize.width, canvasSize.height]);

  // 暴露居中方法给父组件
  useImperativeHandle(ref, () => ({
    centerCanvas,
  }), [centerCanvas]);

  // 初始化时居中画布（首次渲染后做多次短延迟重试，保证横纵方向都稳定居中）
  const hasInitializedRef = useRef(false);
  const initialCenterRetryTimerRefs = useRef<number[]>([]);
  const revealAfterCenterTimerRef = useRef<number | null>(null);
  useEffect(() => {
    if (isFullscreen) {
      setIsInitialCenterReady(true);
      return;
    }

    if (!hasInitializedRef.current && baseCanvasSize && canvasSize.width > 0 && canvasSize.height > 0) {
      hasInitializedRef.current = true;
      centerCanvas();

      initialCenterRetryTimerRefs.current.forEach((id) => window.clearTimeout(id));
      initialCenterRetryTimerRefs.current = [80, 180, 320].map((delay) =>
        window.setTimeout(() => {
          centerCanvas();
        }, delay)
      );

      if (revealAfterCenterTimerRef.current !== null) {
        window.clearTimeout(revealAfterCenterTimerRef.current);
      }
      // Keep hidden until the final centering retry is done, so users never see the canvas moving.
      revealAfterCenterTimerRef.current = window.setTimeout(() => {
        setIsInitialCenterReady(true);
      }, 360);
    }
  }, [baseCanvasSize, canvasSize.width, canvasSize.height, centerCanvas, isFullscreen]);

  useEffect(() => () => {
    initialCenterRetryTimerRefs.current.forEach((id) => window.clearTimeout(id));
    initialCenterRetryTimerRefs.current = [];
    if (revealAfterCenterTimerRef.current !== null) {
      window.clearTimeout(revealAfterCenterTimerRef.current);
      revealAfterCenterTimerRef.current = null;
    }
  }, []);

  // 控制点保持固定视觉大小，不随画布缩放而变化
  const moveableZoom = 1;

  // 处理画布变换（移动或缩放）时更新 Moveable 控制框位置
  const handleTransformChange = useCallback((_transform: { scale: number; x: number; y: number }) => {
    if (moveableRef.current) {
      const moveable = moveableRef.current.getMoveable();
      if (moveable) {
        moveable.updateRect();
      }
    }
  }, []);

  const handleInfiniteCanvasClick = useCallback(() => {
    // 如果正在框选或刚刚完成框选，不清除选中
    if (isSelectingRef.current) {
      return;
    }
    if (!isFullscreen) {
      setSelectedClipId([]);
    }
  }, [isFullscreen, setSelectedClipId]);

  const getActiveClips = () =>
    clips.filter((clip: TimelineClip) => currentTime >= clip.start && currentTime < clip.end);

  const activeClips = getActiveClips();

  useEffect(() => {
    const validClipIds = new Set(clips.map((c) => c.id));

    // 清理无效的 refs
    [videoRefs, audioRefs, textRefs].forEach((refs) => {
      Object.keys(refs.current).forEach((clipId) => {
        if (!validClipIds.has(clipId)) {
          delete refs.current[clipId];
        }
      });
    });
  }, [clips]);

  const calculateMappedTime = (time: number, clipList: TimelineClip[]) => {
    const maxClipEnd = clipList.length > 0 ? Math.max(...clipList.map((c) => c.end)) : 0;
    const playheadWidthTime = 2 / 100;
    const limitedMax = maxClipEnd - playheadWidthTime;
    const timeScale = limitedMax > 0 ? maxClipEnd / limitedMax : 1;
    return time * timeScale;
  };

  const syncVideo = (
    clip: TimelineClip,
    media: MediaItem,
    mappedCurrentTime: number,
    playing: boolean,
    fullscreen: boolean
  ) => {
    const videoElement = videoRefs.current[clip.id];
    if (!videoElement) return;

    const timelineTime = mappedCurrentTime - clip.start;
    const clipDuration = clip.end - clip.start;

    const trimStart = clip.trimStart || 0;
    const clipDurationForTrim = clip.end - clip.start;
    const trimEnd =
      clip.trimEnd || (media.duration ? media.duration : trimStart + clipDurationForTrim);

    // 视频音频：全屏时默认禁用视频元素的音频，使用独立的音频元素
    const volume = clip.volume !== undefined ? clip.volume : 100;
    videoElement.volume = Math.min(volume / 100, 1);
    videoElement.muted = fullscreen || volume === 0;

    const videoSpeed = Math.min(4, Math.max(0.25, clip.speed ?? 1));
    videoElement.playbackRate = videoSpeed;

    if (timelineTime >= 0 && timelineTime <= clipDuration) {
      const videoTime = trimStart + timelineTime * videoSpeed;
      const clampedVideoTime = Math.min(Math.max(trimStart, videoTime), trimEnd);

      if (videoElement.readyState >= 1 && Math.abs(videoElement.currentTime - clampedVideoTime) > 0.1) {
        videoElement.currentTime = clampedVideoTime;
      }
    }

    if (playing && timelineTime >= 0 && timelineTime <= clipDuration) {
      if (videoElement.readyState >= 1) {
        const playPromise = videoElement.play();
        if (playPromise !== undefined) {
          playPromise.catch(() => {});
        }
      }
    } else {
      videoElement.pause();
    }
  };

  const syncAudio = (
    clip: TimelineClip,
    media: MediaItem,
    mappedCurrentTime: number,
    playing: boolean,
    _fullscreen: boolean
  ) => {
    const audioElement = audioRefs.current[clip.id];
    if (!audioElement) return;

    const timelineTime = mappedCurrentTime - clip.start;
    const clipDuration = clip.end - clip.start;

    const trimStart = clip.trimStart || 0;
    const clipDurationForTrim = clip.end - clip.start;
    const trimEnd =
      clip.trimEnd || (media.duration ? media.duration : trimStart + clipDurationForTrim);
    const audioSpeed = clip.speed || 1;
    const audioVolume = clip.volume ?? 100;

    audioElement.playbackRate = audioSpeed;
    // 全屏时也使用同一个 audio，不要静音
    audioElement.volume = Math.min(Math.max(audioVolume / 200, 0), 1);

    if (timelineTime >= 0 && timelineTime <= clipDuration) {
      const audioTime = trimStart + timelineTime * audioSpeed;
      const clampedAudioTime = Math.min(Math.max(trimStart, audioTime), trimEnd);

      if (audioElement.readyState >= 1 && Math.abs(audioElement.currentTime - clampedAudioTime) > 0.1) {
        audioElement.currentTime = clampedAudioTime;
      }
    }

    if (playing && timelineTime >= 0 && timelineTime <= clipDuration) {
      if (audioElement.readyState >= 1) {
        const playPromise = audioElement.play();
        if (playPromise !== undefined) {
          playPromise.catch(() => {
            // 播放失败时静默处理
          });
        }
      }
    } else {
      audioElement.pause();
    }
  };

  useEffect(() => {
    const mappedCurrentTime = calculateMappedTime(currentTime, clips);

    activeClips.forEach((clip: TimelineClip) => {
      const media = mediaItems.find((item: MediaItem) => item.id === clip.mediaId);
      if (!media) return;

      if (media.type === 'video') {
        syncVideo(clip, media, mappedCurrentTime, isPlaying, isFullscreen);
      } else if (media.type === 'audio') {
        syncAudio(clip, media, mappedCurrentTime, isPlaying, isFullscreen);
      }
    });
  }, [currentTime, isPlaying, activeClips, mediaItems, clips, isFullscreen]);

  // 计算元素的位置和尺寸
  const getElementLayout = (clip: TimelineClip, media: MediaItem) => {
    const isText = media.type === 'text';

    let defaultWidth: number | 'auto' = 'auto';
    let defaultHeight: number | 'auto' = 'auto';

    if (!isText && media.width && media.height) {
      const mediaRatio = media.width / media.height;
      const maxWidth = baseCanvasSize.width * 0.8;
      const maxHeight = baseCanvasSize.height * 0.8;

      if (media.width > maxWidth || media.height > maxHeight) {
        if (mediaRatio > maxWidth / maxHeight) {
          defaultWidth = maxWidth;
          defaultHeight = maxWidth / mediaRatio;
        } else {
          defaultHeight = maxHeight;
          defaultWidth = maxHeight * mediaRatio;
        }
      } else {
        defaultWidth = media.width;
        defaultHeight = media.height;
      }
    } else if (!isText) {
      defaultWidth = baseCanvasSize.width * 0.8;
      defaultHeight = baseCanvasSize.height * 0.8;
    }

    const defaultTextWidth = 300;
    const defaultTextHeight = 80;

    const defaultX = isText
      ? baseCanvasSize.width / 2 - defaultTextWidth / 2
      : (baseCanvasSize.width - (defaultWidth as number)) / 2;
    const defaultY = isText
      ? baseCanvasSize.height / 2 - defaultTextHeight / 2
      : (baseCanvasSize.height - (defaultHeight as number)) / 2;

    const x = clip.x ?? defaultX;
    const y = clip.y ?? defaultY;
    const width =
      clip.width ??
      (typeof defaultWidth === 'number' ? defaultWidth : isText ? defaultTextWidth : 100);
    const height =
      clip.height ??
      (typeof defaultHeight === 'number' ? defaultHeight : isText ? defaultTextHeight : 40);
    const scale = clip.scale ?? 1;
    const rotation = clip.rotation ?? 0;
    const opacity = clip.opacity ?? 100;

    return { x, y, width, height, scale, rotation, opacity, isText };
  };

  // 生成外层容器样式
  const getOuterContainerStyle = (clip: TimelineClip): React.CSSProperties => {
    const mediaStyle = clip.mediaStyle || {};
    const style: React.CSSProperties = {};

    if (mediaStyle.borderRadius) {
      style.borderRadius = `${mediaStyle.borderRadius}px`;
    }

    if (mediaStyle.outlineColor && mediaStyle.outlineWidth) {
      style.outline = `${mediaStyle.outlineWidth}px solid ${mediaStyle.outlineColor}`;
    }

    if (mediaStyle.shadowColor) {
      const shadowX = mediaStyle.shadowOffsetX || 0;
      const shadowY = mediaStyle.shadowOffsetY || 0;
      const shadowBlur = mediaStyle.shadowBlur || 0;
      style.boxShadow = `${shadowX}px ${shadowY}px ${shadowBlur}px ${mediaStyle.shadowColor}`;
    }

    return style;
  };

  // 计算音频 clips 的渲染数据
  const audioClipsForRender = activeClips
    .filter((clip: TimelineClip) => {
      const media = mediaItems.find((item: MediaItem) => item.id === clip.mediaId);
      return media?.type === 'audio';
    })
    .map((clip: TimelineClip) => {
      const media = mediaItems.find((item: MediaItem) => item.id === clip.mediaId);
      if (!media) return null;

      return {
        clip,
        media,
      };
    })
    .filter(
      (item: { clip: TimelineClip; media: MediaItem } | null): item is { clip: TimelineClip; media: MediaItem } =>
        item !== null
    );

  // 渲染元素内容
  const renderElementContent = (
    media: MediaItem,
    clip: TimelineClip,
    layout: ReturnType<typeof getElementLayout>
  ) => {
    if (media.type === 'video') {
      return (
        <VideoElement
          clip={clip}
          media={media}
          width={layout.width}
          height={layout.height}
          opacity={layout.opacity}
          videoRefs={videoRefs}
        />
      );
    }
    if (media.type === 'image') {
      return (
        <ImageElement
          clip={clip}
          media={media}
          width={layout.width}
          height={layout.height}
          opacity={layout.opacity}
        />
      );
    }
    if (media.type === 'text') {
      return (
        <TextElement
          clip={clip}
          opacity={layout.opacity}
          isEditingRef={isEditingRef}
          textRefs={textRefs}
          nodeId={nodeId}
        />
      );
    }
    return null;
  };

  // 计算视频/图片/文本 clips 的渲染数据
  const visualClipsForRender = activeClips
    .sort((a: TimelineClip, b: TimelineClip) => b.trackIndex - a.trackIndex)
    .map((clip: TimelineClip) => {
      let media = mediaItems.find((item: MediaItem) => item.id === clip.mediaId);
      if (!media || !media.type) {
        media = {
          id: clip.mediaId,
          name: clip.mediaId,
          text: clip.text || 'Text',
          type: 'text',
          url: '',
        };
      }
      if (media.type === 'audio') return null;

      const layout = getElementLayout(clip, media);
      const outerStyle = getOuterContainerStyle(clip);
      // 文字元素不使用 overflow-hidden，允许自动换行；其他元素根据裁剪和圆角决定
      const needsOverflowHidden = Boolean(!layout.isText && (clip.cropArea || clip.mediaStyle?.borderRadius));

      return {
        clip,
        media,
        layout,
        outerStyle,
        needsOverflowHidden,
      };
    })
    .filter(
      (item: {
        clip: TimelineClip;
        media: MediaItem;
        layout: ReturnType<typeof getElementLayout>;
        outerStyle: React.CSSProperties;
        needsOverflowHidden: boolean;
      } | null): item is NonNullable<typeof item> => item !== null
    );

  return (
    <>
      <div
        ref={containerRef}
        className={'bg-background-default-base-hover relative w-full h-full overflow-hidden'}
        style={{
          ...(isFullscreen ? { position: 'fixed', inset: 0, zIndex: 9999 } : {}),
        }}
      >
        <InfiniteCanvas
          ref={infiniteCanvasRef}
          disabled={isFullscreen}
          minScale={0.1}
          maxScale={5}
          initialScale={1}
          canvasRatio={canvasRatio}
          canvasSize={canvasSize}
          baseCanvasSize={baseCanvasSize}
          onTransformChange={handleTransformChange}
          onClick={handleInfiniteCanvasClick}
        >
          <div
            className='relative overflow-visible min-w-[100px] min-h-[100px]'
            style={{
              width: canvasSize.width > 0 ? `${canvasSize.width}px` : '100%',
              height: canvasSize.height > 0 ? `${canvasSize.height}px` : '100%',
            }}
          >
            <div
              id='preview-canvas-bg'
              data-width={canvasSize.width}
              data-height={canvasSize.height}
              className='absolute -z-10'
              style={{
                width: `${canvasSize.width}px`,
                height: `${canvasSize.height}px`,
              }}
            />
            <div
              ref={canvasRef}
              id='preview-canvas'
              className='relative bg-[#000]'
              style={{
                width: `${canvasSize.width}px`,
                height: `${canvasSize.height}px`,
                overflow: 'hidden',
                visibility: isInitialCenterReady || isPlaying ? 'visible' : 'hidden',
              }}
            >
              <div
                className='relative bg-[#000]'
                style={{
                  width: `${baseCanvasSize.width}px`,
                  height: `${baseCanvasSize.height}px`,
                  transform: `scale(${canvasSize.width / baseCanvasSize.width})`,
                  transformOrigin: 'top left',
                }}
              >
                {audioClipsForRender.map(({ clip, media }: { clip: TimelineClip; media: MediaItem }) => (
                  <audio
                    key={clip.id}
                    ref={(el) => {
                      if (el) {
                        audioRefs.current[clip.id] = el;
                        if (clip.volume !== undefined) {
                          el.volume = Math.min(Math.max(clip.volume / 200, 0), 1);
                        }
                        if (clip.speed !== undefined) {
                          el.playbackRate = clip.speed;
                        }
                      }
                    }}
                    src={media.url}
                    className='hidden'
                  />
                ))}

                {visualClipsForRender.map(({
                  clip,
                  media,
                  layout,
                  outerStyle,
                }: {
                  clip: TimelineClip;
                  media: MediaItem;
                  layout: ReturnType<typeof getElementLayout>;
                  outerStyle: React.CSSProperties;
                }) => {
                  const elementId = `element-${clip.id}`;
                  return (
                    <div
                      key={clip.id}
                      id={elementId}
                      data-selectable='true'
                      className={`relative ${isFullscreen ? 'cursor-default' : 'cursor-move'}`}
                      style={{
                        position: 'absolute',
                        left: `${layout.x}px`,
                        top: `${layout.y}px`,
                        width: `${layout.width}px`,
                        height: typeof layout.height === 'string' && layout.height === 'auto' ? 'auto' : `${layout.height}px`,
                        transform: `rotate(${layout.rotation}deg) scale(${layout.scale})`,
                        transformOrigin: 'center center',
                        zIndex: 100 - clip.trackIndex,
                        display: 'flex',
                        flexDirection: 'column',
                        pointerEvents: 'auto',
                        overflow: 'hidden',
                        ...outerStyle,
                      }}
                      onClick={(e) => {
                        e.stopPropagation();
                        handleElementClick(e, clip.id);
                      }}
                    >
                      {/* 内容容器 */}
                      <div
                        style={{
                          position: 'absolute',
                          width: '100%',
                          height: '100%',
                          pointerEvents: 'auto',
                        }}
                      >
                        {renderElementContent(media, clip, layout)}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          </div>
        </InfiniteCanvas>
        {/* 多选时渲染 MoveableControl，将所有选中的元素传给 target */}
        {selectedClipId.length > 0 &&
          !isFullscreen &&
          containerRef.current &&
          createPortal(
            <MoveableControl
              ref={moveableRef}
              clips={selectedClipId.map((id) => clips.find((c) => c.id === id)).filter(Boolean) as TimelineClip[]}
              mediaItems={selectedClipId
                .map((id) => {
                  const clip = clips.find((c) => c.id === id);
                  if (!clip) return null;
                  return mediaItems.find((m) => m.id === clip.mediaId);
                })
                .filter(Boolean) as MediaItem[]}
              canvasSize={baseCanvasSize}
              nodeId={nodeId}
              isSelected={selectedClipId.length > 0}
              zoom={moveableZoom}
              target={[]}
              container={containerRef.current}
            />,
            containerRef.current
          )}
        {/* Selecto 框选组件 - 按照 moveable-master 案例配置 */}
        {!isFullscreen && containerRef.current && (
          <Selecto
            ref={selectoRef}
            container={containerRef.current}
            dragContainer={containerRef.current}
            rootContainer={containerRef.current}
            selectableTargets={['[id^="element-"]', '[data-selectable="true"]']}
            hitRate={0} // 允许选中部分重叠的元素
            selectByClick={false} // 点击选中走元素 onClick，避免和 Selecto 冲突
            selectFromInside={false} // 允许从外部框选
            toggleContinueSelect={['shift']} // Shift 键继续选择
            ratio={0} // 不限制选择框的宽高比
            boundContainer={containerRef.current} // 限制选择区域在容器内
            checkInput={false} // 不检查输入元素
            preventClickEventOnDrag={true} // 拖拽框选时阻止 click，避免误触单选
            preventDefault={false} // 不阻止默认事件，让框选正常工作
            onDragStart={handleSelectStart}
            onSelectEnd={handleSelectEnd}
          />
        )}
      </div>
    </>
  );
});

export default memo(PreviewCanvas);