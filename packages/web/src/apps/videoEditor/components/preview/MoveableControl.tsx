import { memo, forwardRef, useImperativeHandle, useRef, useLayoutEffect, useState } from 'react';
import Moveable, { OnDrag, OnDragEnd, OnResize, OnResizeEnd, OnScale, OnScaleEnd, OnRotate, OnRotateEnd } from 'react-moveable';
import { useVideoEditorStore } from '@/hooks/useVideoEditorStore';
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
  nodeId,
  isSelected = false,
  target: _target,
  container,
}, ref) => {
  const moveableRef = useRef<Moveable>(null);
  const { updateClip } = useVideoEditorStore(nodeId);
  const dragDeltaRef = useRef<Record<string, { x: number; y: number }>>({});
  const dragStartRef = useRef<Record<string, { x: number; y: number }>>({});
  const resizeStateRef = useRef<Record<string, { x: number; y: number; width: number; height: number }>>({});
  const resizeStartRef = useRef<Record<string, { x: number; y: number }>>({});

  const getElementCanvasPosition = (element: HTMLElement) => {
    const left = Number.isFinite(element.offsetLeft) ? element.offsetLeft : 0;
    const top = Number.isFinite(element.offsetTop) ? element.offsetTop : 0;
    return { x: left, y: top };
  };

  const [targets, setTargets] = useState<HTMLElement[]>([]);

  // 根据 clips 获取对应的 DOM 元素。
  // 这里在布局后再取一次，避免新增元素时首次渲染拿不到 DOM 导致“时间轴选中但画布无选中框”。
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

  // 暴露 getMoveable 方法给父组件
  useImperativeHandle(ref, () => ({
    getMoveable: () => moveableRef.current,
  }), []);

  // 当 targets 变化时，更新 Moveable 的 rect
  // 使用 useLayoutEffect 在 DOM 更新后同步执行，确保 Moveable 能正确计算位置
  useLayoutEffect(() => {
    if (moveableRef.current && targets.length > 0) {
      moveableRef.current.updateRect();
    }
  }, [targets]);

  // 处理拖拽（单选和多选都使用同一个处理函数）
  const handleDrag = (e: OnDrag) => {
    const { target, beforeTranslate } = e;
    if (!target) return;
    const clipId = (target as HTMLElement).id.replace('element-', '');
    const [deltaX, deltaY] = beforeTranslate;
    if (!dragStartRef.current[clipId]) {
      dragStartRef.current[clipId] = getElementCanvasPosition(target as HTMLElement);
    }
    dragDeltaRef.current[clipId] = { x: deltaX, y: deltaY };

    // 按照 moveable-master 示例，只更新 DOM，不更新 store
    // 避免与 PreviewCanvas 的渲染冲突导致抖动
    const element = target as HTMLElement;
    const nextX = dragStartRef.current[clipId].x + deltaX;
    const nextY = dragStartRef.current[clipId].y + deltaY;
    element.style.left = `${nextX}px`;
    element.style.top = `${nextY}px`;
  };

  // 处理拖拽结束 - 在这里更新 store
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

  // 处理调整大小 - 按照 moveable-master 示例实现
  // 只更新 DOM，不更新 store，避免与 PreviewCanvas 渲染冲突导致抖动
  const handleResize = (e: OnResize) => {
    const { target, width, height, drag } = e;
    if (!target) return;
    const clipId = (target as HTMLElement).id.replace('element-', '');
    const [deltaX, deltaY] = drag.beforeTranslate;
    if (!resizeStartRef.current[clipId]) {
      resizeStartRef.current[clipId] = getElementCanvasPosition(target as HTMLElement);
    }
    resizeStateRef.current[clipId] = { x: deltaX, y: deltaY, width, height };

    // 按照示例：只更新 DOM
    const element = target as HTMLElement;
    element.style.width = `${width}px`;
    element.style.height = `${height}px`;
    const nextX = resizeStartRef.current[clipId].x + deltaX;
    const nextY = resizeStartRef.current[clipId].y + deltaY;
    element.style.left = `${nextX}px`;
    element.style.top = `${nextY}px`;
  };

  // 处理调整大小结束 - 在这里更新 store
  const handleResizeEnd = (e: OnResizeEnd) => {
    const { target } = e;
    if (!target) return;

    const clipId = (target as HTMLElement).id.replace('element-', '');
    const element = target as HTMLElement;
    const resizeState = resizeStateRef.current[clipId];
    const resizeStart = resizeStartRef.current[clipId];
    const currentPos = getElementCanvasPosition(element);
    const currentSize = {
      width: element.offsetWidth,
      height: element.offsetHeight,
    };

    delete resizeStateRef.current[clipId];
    delete resizeStartRef.current[clipId];

    if (resizeState && resizeStart) {
      updateClip(clipId, {
        width: resizeState.width,
        height: resizeState.height,
        x: resizeStart.x + resizeState.x,
        y: resizeStart.y + resizeState.y,
      });
      return;
    }

    updateClip(clipId, {
      width: currentSize.width,
      height: currentSize.height,
      x: currentPos.x,
      y: currentPos.y,
    });
  };

  // 处理缩放 - 按照 moveable-master 示例实现
  // 只更新 DOM，不更新 store，避免与 PreviewCanvas 渲染冲突导致抖动
  const handleScale = (e: OnScale) => {
    const { target, drag } = e;
    if (!target) return;

    // 按照示例：只更新 DOM
    const element = target as HTMLElement;
    element.style.transform = drag.transform;
  };

  // 处理缩放结束 - 在这里更新 store
  const handleScaleEnd = (e: OnScaleEnd) => {
    const { target } = e;
    if (!target) return;

    const clipId = (target as HTMLElement).id.replace('element-', '');
    const clip = clips.find((c) => c.id === clipId);
    if (!clip) return;

    // OnScaleEnd 可能没有 scale 属性，保持当前的 scale 值
    // 因为缩放通常通过 resize 处理，scale 主要用于 transform
    const currentScale = clip.scale || 1;
    updateClip(clipId, {
      scale: currentScale,
    });
  };

  // 处理旋转 - 按照 moveable-master 示例实现
  // 只更新 DOM，不更新 store，避免与 PreviewCanvas 渲染冲突导致抖动
  const handleRotate = (e: OnRotate) => {
    const { target, drag } = e;
    if (!target) return;

    // 按照示例：只更新 DOM
    const element = target as HTMLElement;
    element.style.transform = drag.transform;
  };

  // 处理旋转结束 - 在这里更新 store
  const handleRotateEnd = (e: OnRotateEnd) => {
    const { target } = e;
    if (!target) return;

    const clipId = (target as HTMLElement).id.replace('element-', '');
    const clip = clips.find((c) => c.id === clipId);
    if (!clip) return;

    // OnRotateEnd 可能没有 rotation 属性，需要从 transform 中提取
    // 或者保持当前的 rotation 值（因为旋转已经通过 transform 应用）
    // 这里简化处理，从 clip 中获取当前 rotation
    const currentRotation = clip.rotation || 0;
    updateClip(clipId, {
      rotation: currentRotation,
    });
  };

  if (!isSelected || targets.length === 0 || !container) {
    return null;
  }

  // 判断是否为文本元素
  const isTextElement = (clip: TimelineClip) => {
    const media = _mediaItems.find((m) => m.id === clip.mediaId);
    return media?.type === 'text';
  };

  // 判断是否为图片或视频元素（需要等比例缩放）
  const isMediaElement = (clip: TimelineClip) => {
    const media = _mediaItems.find((m) => m.id === clip.mediaId);
    return media?.type === 'image' || media?.type === 'video';
  };

  // 获取第一个元素的类型，用于应用不同的样式类
  const firstClip = clips[0];
  const controlClassName = firstClip && isTextElement(firstClip) ? 'moveable-control-text' : 'moveable-control-media';

  // 对于图片和视频，启用等比例缩放；对于文本，不启用等比例
  const shouldKeepRatio = firstClip ? isMediaElement(firstClip) : false;

  return (
    <Moveable
      ref={moveableRef}
      target={targets}
      container={container}
      draggable={true}
      resizable={true}
      scalable={true}
      rotatable={true}
      warpable={false}
      pinchable={true}
      origin={false}
      keepRatio={shouldKeepRatio}
      edge={false}
      throttleDrag={0}
      throttleResize={0}
      throttleScale={0}
      throttleRotate={0}
      className={controlClassName}
      onDrag={handleDrag}
      onDragEnd={handleDragEnd}
      onResize={handleResize}
      onResizeEnd={handleResizeEnd}
      onScale={handleScale}
      onScaleEnd={handleScaleEnd}
      onRotate={handleRotate}
      onRotateEnd={handleRotateEnd}
      // 边界限制
      bounds={{
        left: 0,
        top: 0,
        right: canvasSize.width,
        bottom: canvasSize.height,
        position: 'css',
      }}
      // zoom 由外层根据画布缩放传入，用于保持控制框交互稳定
      zoom={zoom}
    />
  );
});

export default memo(MoveableControl);
