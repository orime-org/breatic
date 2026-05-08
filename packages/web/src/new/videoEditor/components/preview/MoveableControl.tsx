import { memo, forwardRef, useImperativeHandle, useRef, useLayoutEffect, useState } from 'react';
import Moveable, {
  OnDrag,
  OnDragEnd,
  OnDragGroup,
  OnDragGroupEnd,
  OnResize,
  OnResizeEnd,
  OnResizeGroup,
  OnResizeGroupEnd,
  OnScale,
  OnScaleEnd,
  OnScaleGroup,
  OnScaleGroupEnd,
  OnRotate,
  OnRotateEnd,
  OnRotateGroup,
  OnRotateGroupEnd,
} from 'react-moveable';
import { useVideoEditorStore } from '@/app/hooks/useVideoEditorStore';
import { MediaItem, TimelineClip } from '../../types';
import './MoveableControl.css';

interface MoveableControlProps {
  clips: TimelineClip[];
  mediaItems: MediaItem[];
  canvasSize: { width: number; height: number };
  zoom?: number;
  nodeId?: string;
  isSelected?: boolean;
  target: (HTMLElement | SVGElement)[];
  container?: HTMLElement | null;
}

export interface MoveableControlRef {
  getMoveable: () => Moveable | null;
}

const MoveableControl = forwardRef<MoveableControlRef, MoveableControlProps>(({
  clips,
  mediaItems: _mediaItems,
  canvasSize,
  zoom = 1,
  isSelected = false,
  target: _target,
  container,
}, ref) => {
  const MIN_TEXT_FONT_SIZE = 5;
  const MAX_TEXT_FONT_SIZE = 300;
  const moveableRef = useRef<Moveable>(null);
  const { updateClip } = useVideoEditorStore();
  const dragDeltaRef = useRef<Record<string, { x: number; y: number }>>({});
  const dragStartRef = useRef<Record<string, { x: number; y: number }>>({});
  const resizeStateRef = useRef<Record<string, { x: number; y: number; width: number; height: number }>>({});
  const resizeStartRef = useRef<Record<string, { x: number; y: number }>>({});
  const textResizeStartRef = useRef<Record<string, { fontSize: number; width: number; height: number }>>({});
  const textPreviewFontSizeRef = useRef<Record<string, number>>({});

  const getElementCanvasPosition = (element: HTMLElement) => {
    const left = Number.isFinite(element.offsetLeft) ? element.offsetLeft : 0;
    const top = Number.isFinite(element.offsetTop) ? element.offsetTop : 0;
    return { x: left, y: top };
  };

  const [targets, setTargets] = useState<HTMLElement[]>([]);

  const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));
  const getTextContentHeight = (textContent: HTMLElement, fontSize: number) => {
    const minHeight = Math.max(fontSize * 1.5, 60);
    return Math.max(Math.ceil(textContent.scrollHeight), Math.ceil(minHeight));
  };
  const getWidthScale = (startWidth: number, nextWidth: number) => Math.max(nextWidth, 1) / Math.max(startWidth, 1);

  // based on clips getcorresponding DOM 。
  // ，avoidnewly added first time DOM causing“timelineselected canvas selected ”。
  useLayoutEffect(() => {
    if (!clips || clips.length === 0) {
      setTargets([]);
      return;
    }

    const collectTargets = () => {
      const nextTargets = clips
        .map((clip) => document.getElementById(`element-${clip.id}`))
        .filter((el): el is HTMLElement => el !== null);
      setTargets(nextTargets);
    };

    collectTargets();
    const rafId = window.requestAnimationFrame(collectTargets);

    return () => {
      window.cancelAnimationFrame(rafId);
    };
  }, [clips]);

  // getMoveable component
  useImperativeHandle(ref, () => ({
    getMoveable: () => moveableRef.current,
  }), []);

  // targets ，update Moveable rect
  // use useLayoutEffect DOM update ，ensure Moveable calculate
  useLayoutEffect(() => {
    if (moveableRef.current && targets.length > 0) {
      moveableRef.current.updateRect();
    }
  }, [targets]);

  // handledrag（single select multi-select use handle ）
  const handleDrag = (e: OnDrag) => {
    const { target, beforeTranslate } = e;
    if (!target) return;
    const clipId = (target as HTMLElement).id.replace('element-', '');
    const [deltaX, deltaY] = beforeTranslate;
    if (!dragStartRef.current[clipId]) {
      dragStartRef.current[clipId] = getElementCanvasPosition(target as HTMLElement);
    }
    dragDeltaRef.current[clipId] = { x: deltaX, y: deltaY };

    // moveable-master ， update DOM， update store
    // avoid PreviewCanvas conflictcausingjitter
    const element = target as HTMLElement;
    const nextX = dragStartRef.current[clipId].x + deltaX;
    const nextY = dragStartRef.current[clipId].y + deltaY;
    element.style.left = `${nextX}px`;
    element.style.top = `${nextY}px`;
  };

  // handledragend - update store
  const handleDragEnd = (e: OnDragEnd) => {
    const { target } = e;
    if (!target) return;

    const clipId = (target as HTMLElement).id.replace('element-', '');
    const element = target as HTMLElement;
    const currentPos = getElementCanvasPosition(element);
    const dragStart = dragStartRef.current[clipId];
    const dragDelta = dragDeltaRef.current[clipId];

    delete dragDeltaRef.current[clipId];
    delete dragStartRef.current[clipId];

    if (dragStart && dragDelta) {
      updateClip(clipId, {
        x: dragStart.x + dragDelta.x,
        y: dragStart.y + dragDelta.y,
      });
      return;
    }

    updateClip(clipId, {
      x: currentPos.x,
      y: currentPos.y,
    });
  };

  // 多选拖拽走 group 事件，这里把每个子元素按单元素逻辑更新
  const handleDragGroup = (e: OnDragGroup) => {
    e.events?.forEach((dragEvent: OnDrag) => {
      handleDrag(dragEvent);
    });
  };

  const handleDragGroupEnd = (e: OnDragGroupEnd) => {
    e.events?.forEach((dragEndEvent: OnDragEnd) => {
      handleDragEnd(dragEndEvent);
    });
  };

  // handle - moveable-master
  // update DOM， update store，avoid PreviewCanvas conflictcausingjitter
  const handleResize = (e: OnResize) => {
    const { target, width, height, drag, direction } = e;
    if (!target) return;
    const clipId = (target as HTMLElement).id.replace('element-', '');
    const clip = clips.find((c) => c.id === clipId);
    if (!clip) return;
    const media = _mediaItems.find((m) => m.id === clip.mediaId);
    const isText = media?.type === 'text';
    const isCornerDirection = direction[0] !== 0 && direction[1] !== 0;
    const isHorizontalDirection = direction[0] !== 0 && direction[1] === 0;
    const isVerticalDirection = direction[0] === 0 && direction[1] !== 0;
    const [deltaX, deltaY] = drag.beforeTranslate;
    if (!resizeStartRef.current[clipId]) {
      resizeStartRef.current[clipId] = getElementCanvasPosition(target as HTMLElement);
    }
    const element = target as HTMLElement;

    const nextX = resizeStartRef.current[clipId].x + deltaX;
    const nextY = resizeStartRef.current[clipId].y + deltaY;
    element.style.left = `${nextX}px`;
    element.style.top = `${nextY}px`;

    if (isText && (isCornerDirection || isVerticalDirection)) {
      const start = textResizeStartRef.current[clipId] || {
        fontSize: clip.textStyle?.fontSize ?? 48,
        width: clip.width ?? element.offsetWidth,
        height: clip.height ?? element.offsetHeight,
      };
      textResizeStartRef.current[clipId] = start;
      const scale = isVerticalDirection
        ? clamp(getWidthScale(start.height, height), 0.2, 8)
        : clamp(getWidthScale(start.width, width), 0.2, 8);
      const nextFontSize = clamp(Math.round(start.fontSize * scale), MIN_TEXT_FONT_SIZE, MAX_TEXT_FONT_SIZE);
      textPreviewFontSizeRef.current[clipId] = nextFontSize;
      const nextWidth = isVerticalDirection ? Math.max(1, Math.round(start.width * scale)) : width;

      const textContent = element.querySelector<HTMLElement>('[data-text-content="true"]');
      if (textContent) {
        textContent.style.fontSize = `${nextFontSize}px`;
        const contentHeight = getTextContentHeight(textContent, nextFontSize);
        element.style.height = `${contentHeight}px`;
      } else {
        element.style.height = `${height}px`;
      }

      element.style.width = `${nextWidth}px`;
      resizeStateRef.current[clipId] = {
        x: deltaX,
        y: deltaY,
        width: nextWidth,
        height: element.offsetHeight,
      };
      return;
    }

    // textkeepleftright ； logic
    if (isText && isHorizontalDirection) {
      element.style.width = `${width}px`;
      const currentFontSize = clip.textStyle?.fontSize ?? 48;
      const textContent = element.querySelector<HTMLElement>('[data-text-content="true"]');
      if (textContent) {
        const contentHeight = getTextContentHeight(textContent, currentFontSize);
        element.style.height = `${contentHeight}px`;
      }
      resizeStateRef.current[clipId] = {
        x: deltaX,
        y: deltaY,
        width,
        height: element.offsetHeight,
      };
      return;
    }

    // ： update DOM
    element.style.width = `${width}px`;
    element.style.height = `${height}px`;
    resizeStateRef.current[clipId] = { x: deltaX, y: deltaY, width, height };

    // media（image/video）resize during drag should be realtime synced to store.
    // This avoids waiting until resize end before preview reflects final dimensions.
    if (!isText) {
      updateClip(clipId, {
        width,
        height,
        x: nextX,
        y: nextY,
      });
    }
  };

  // handle end - update store
  const handleResizeEnd = (e: OnResizeEnd) => {
    const { target } = e;
    if (!target) return;

    const clipId = (target as HTMLElement).id.replace('element-', '');
    const clip = clips.find((c) => c.id === clipId);
    if (!clip) return;
    const media = _mediaItems.find((m) => m.id === clip.mediaId);
    const isText = media?.type === 'text';
    const element = target as HTMLElement;
    const resizeState = resizeStateRef.current[clipId];
    const resizeStart = resizeStartRef.current[clipId];
    const textResizeStart = textResizeStartRef.current[clipId];
    const currentPos = getElementCanvasPosition(element);
    const currentSize = {
      width: element.offsetWidth,
      height: element.offsetHeight,
    };

    delete resizeStateRef.current[clipId];
    delete resizeStartRef.current[clipId];

    if (resizeState && resizeStart) {
      if (isText && textResizeStart) {
        const previewFontSize = textPreviewFontSizeRef.current[clipId];
        const scale = clamp(getWidthScale(textResizeStart.width, resizeState.width), 0.2, 8);
        const nextFontSize = previewFontSize
          ?? clamp(Math.round(textResizeStart.fontSize * scale), MIN_TEXT_FONT_SIZE, MAX_TEXT_FONT_SIZE);
        updateClip(clipId, {
          width: resizeState.width,
          height: currentSize.height,
          x: resizeStart.x + resizeState.x,
          y: resizeStart.y + resizeState.y,
          textStyle: {
            ...(clip.textStyle || {}),
            fontSize: nextFontSize,
          },
        });
        delete textResizeStartRef.current[clipId];
        delete textPreviewFontSizeRef.current[clipId];
        return;
      }
      updateClip(clipId, {
        width: resizeState.width,
        height: resizeState.height,
        x: resizeStart.x + resizeState.x,
        y: resizeStart.y + resizeState.y,
      });
      delete textResizeStartRef.current[clipId];
      delete textPreviewFontSizeRef.current[clipId];
      return;
    }

    updateClip(clipId, {
      width: currentSize.width,
      height: currentSize.height,
      x: currentPos.x,
      y: currentPos.y,
    });
    delete textResizeStartRef.current[clipId];
    delete textPreviewFontSizeRef.current[clipId];
  };

  const handleResizeGroup = (e: OnResizeGroup) => {
    e.events?.forEach((resizeEvent: OnResize) => {
      handleResize(resizeEvent);
    });
  };

  const handleResizeGroupEnd = (e: OnResizeGroupEnd) => {
    e.events?.forEach((resizeEndEvent: OnResizeEnd) => {
      handleResizeEnd(resizeEndEvent);
    });
  };

  // handlescale - moveable-master
  // update DOM， update store，avoid PreviewCanvas conflictcausingjitter
  const handleScale = (e: OnScale) => {
    const { target, drag } = e;
    if (!target) return;

    // ： update DOM
    const element = target as HTMLElement;
    element.style.transform = drag.transform;
  };

  // handlescaleend - update store
  const handleScaleEnd = (e: OnScaleEnd) => {
    const { target } = e;
    if (!target) return;

    const clipId = (target as HTMLElement).id.replace('element-', '');
    const clip = clips.find((c) => c.id === clipId);
    if (!clip) return;

    const lastScale = e.lastEvent?.scale;
    const scaleX = Array.isArray(lastScale) ? lastScale[0] : 1;
    const currentScale = Math.max(0.01, (clip.scale || 1) * scaleX);
    updateClip(clipId, {
      scale: currentScale,
    });
  };

  // 多选缩放走 group 事件
  const handleScaleGroup = (e: OnScaleGroup) => {
    e.events?.forEach((scaleEvent: OnScale) => {
      handleScale(scaleEvent);
    });
  };

  const handleScaleGroupEnd = (e: OnScaleGroupEnd) => {
    e.events?.forEach((scaleEndEvent: OnScaleEnd) => {
      handleScaleEnd(scaleEndEvent);
    });
  };

  // handlerotation - moveable-master
  // update DOM， update store，avoid PreviewCanvas conflictcausingjitter
  const handleRotate = (e: OnRotate) => {
    const { target, drag } = e;
    if (!target) return;

    // ： update DOM
    const element = target as HTMLElement;
    element.style.transform = drag.transform;
  };

  // handlerotationend - update store
  const handleRotateEnd = (e: OnRotateEnd) => {
    const { target } = e;
    if (!target) return;

    const clipId = (target as HTMLElement).id.replace('element-', '');
    const clip = clips.find((c) => c.id === clipId);
    if (!clip) return;

    const lastRotate = e.lastEvent?.rotate;
    const currentRotation = typeof lastRotate === 'number' ? lastRotate : (clip.rotation || 0);
    updateClip(clipId, {
      rotation: currentRotation,
    });
  };

  const handleRotateGroup = (e: OnRotateGroup) => {
    e.events?.forEach((rotateEvent: OnRotate) => {
      handleRotate(rotateEvent);
    });
  };

  const handleRotateGroupEnd = (e: OnRotateGroupEnd) => {
    e.events?.forEach((rotateEndEvent: OnRotateEnd) => {
      handleRotateEnd(rotateEndEvent);
    });
  };

  if (!isSelected || targets.length === 0 || !container) {
    return null;
  }

  // text
  const isTextElement = (clip: TimelineClip) => {
    const media = _mediaItems.find((m) => m.id === clip.mediaId);
    return media?.type === 'text';
  };

  // image video （need to ratioscale）
  const isMediaElement = (clip: TimelineClip) => {
    const media = _mediaItems.find((m) => m.id === clip.mediaId);
    return media?.type === 'image' || media?.type === 'video';
  };

  // get ，used for style
  const firstClip = clips[0];
  const controlClassName = firstClip && isTextElement(firstClip) ? 'moveable-control-text' : 'moveable-control-media';
  const isSingleTextSelection = clips.length === 1 && !!firstClip && isTextElement(firstClip);
  const textRenderDirections: Array<'n' | 's' | 'nw' | 'ne' | 'sw' | 'se' | 'e' | 'w'> = ['n', 's', 'nw', 'ne', 'sw', 'se', 'e', 'w'];

  // image video， ratioscale； text， ratio
  const shouldKeepRatio = firstClip ? isMediaElement(firstClip) : false;

  return (
    <Moveable
      ref={moveableRef}
      target={targets}
      container={container}
      draggable={true}
      resizable={true}
      scalable={!isSingleTextSelection}
      rotatable={true}
      warpable={false}
      pinchable={!isSingleTextSelection}
      origin={false}
      keepRatio={shouldKeepRatio}
      edge={false}
      renderDirections={isSingleTextSelection ? textRenderDirections : undefined}
      throttleDrag={0}
      throttleResize={0}
      throttleScale={0}
      throttleRotate={0}
      className={controlClassName}
      onDrag={handleDrag}
      onDragEnd={handleDragEnd}
      onDragGroup={handleDragGroup}
      onDragGroupEnd={handleDragGroupEnd}
      onResize={handleResize}
      onResizeEnd={handleResizeEnd}
      onResizeGroup={handleResizeGroup}
      onResizeGroupEnd={handleResizeGroupEnd}
      onScale={handleScale}
      onScaleEnd={handleScaleEnd}
      onScaleGroup={handleScaleGroup}
      onScaleGroupEnd={handleScaleGroupEnd}
      onRotate={handleRotate}
      onRotateEnd={handleRotateEnd}
      onRotateGroup={handleRotateGroup}
      onRotateGroupEnd={handleRotateGroupEnd}
      // comment
      bounds={{
        left: 0,
        top: 0,
        right: canvasSize.width,
        bottom: canvasSize.height,
        position: 'css',
      }}
      // zoom based oncanvasscale ，used forkeepcontrol
      zoom={zoom}
    />
  );
});

export default memo(MoveableControl);
