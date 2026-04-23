import React, { useRef, useEffect, memo, useCallback, forwardRef, useImperativeHandle } from 'react';
import InfiniteViewer from 'react-infinite-viewer';

interface InfiniteCanvasProps {
  children: React.ReactNode;
  minScale?: number;
  maxScale?: number;
  initialScale?: number;
  disabled?: boolean;
  canvasRatio?: string;
  canvasSize?: { width: number; height: number };
  baseCanvasSize?: { width: number; height: number };
  onTransformChange?: (transform: { scale: number; x: number; y: number }) => void;
  onClick?: () => void;
}

export interface InfiniteCanvasRef {
  centerCanvas: () => void;
}

const InfiniteCanvas = forwardRef<InfiniteCanvasRef, InfiniteCanvasProps>(({
  children,
  minScale = 0.1,
  maxScale = 5,
  initialScale: _initialScale = 1,
  disabled = false,
  canvasRatio: _canvasRatio,
  canvasSize: _canvasSize,
  baseCanvasSize,
  onTransformChange,
  onClick,
}, ref) => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const viewerRef = useRef<any>(null);

  // 居中画布的方法（同时对齐水平 + 垂直中心）
  const centerCanvas = useCallback(() => {
    if (disabled || !viewerRef.current || !baseCanvasSize) return;

    const viewer = viewerRef.current;
    const wrapper = viewer.getWrapper();
    if (!wrapper) return;

    const canvasElement = document.getElementById('preview-canvas');
    if (!canvasElement) return;

    const wrapperRect = wrapper.getBoundingClientRect();
    const canvasRect = canvasElement.getBoundingClientRect();

    const wrapperCenterX = wrapperRect.left + wrapperRect.width / 2;
    const wrapperCenterY = wrapperRect.top + wrapperRect.height / 2;
    const canvasCenterX = canvasRect.left + canvasRect.width / 2;
    const canvasCenterY = canvasRect.top + canvasRect.height / 2;

    const deltaX = canvasCenterX - wrapperCenterX;
    const deltaY = canvasCenterY - wrapperCenterY;

    const newScrollLeft = viewer.getScrollLeft() + deltaX;
    const newScrollTop = viewer.getScrollTop() + deltaY;
    viewer.scrollTo(newScrollLeft, newScrollTop);

    onTransformChange?.({
      scale: viewer.getZoom(),
      x: newScrollLeft,
      y: newScrollTop,
    });
  }, [disabled, baseCanvasSize, onTransformChange]);

  // 暴露方法给父组件
  useImperativeHandle(ref, () => ({
    centerCanvas,
  }), [centerCanvas]);

  // 处理滚动事件，更新 transform
  const handleScroll = useCallback(() => {
    if (!viewerRef.current || disabled) return;

    const viewer = viewerRef.current;
    const scrollLeft = viewer.getScrollLeft();
    const scrollTop = viewer.getScrollTop();
    const zoom = viewer.getZoom();

    onTransformChange?.({
      scale: zoom,
      x: scrollLeft,
      y: scrollTop,
    });
  }, [disabled, onTransformChange]);


  // 处理缩放事件（触摸板缩放），从画布中心开始缩放
  const handlePinch = useCallback(() => {
    if (!viewerRef.current || !baseCanvasSize) {
      handleScroll();
      return;
    }

    const viewer = viewerRef.current;
    const wrapper = viewer.getWrapper();
    if (!wrapper) {
      handleScroll();
      return;
    }

    // 获取画布元素
    const canvasElement = document.getElementById('preview-canvas');
    if (!canvasElement) {
      handleScroll();
      return;
    }

    // 获取画布中心在屏幕坐标系中的位置
    const canvasRect = canvasElement.getBoundingClientRect();
    const canvasCenterX = canvasRect.left + canvasRect.width / 2;
    const canvasCenterY = canvasRect.top + canvasRect.height / 2;

    // 获取当前缩放
    const currentZoom = viewer.getZoom();

    // 使用 setZoom 的 clientX 和 clientY 选项，以画布中心为缩放中心
    viewer.setZoom(currentZoom, {
      clientX: canvasCenterX,
      clientY: canvasCenterY,
    });

    handleScroll();
  }, [handleScroll, baseCanvasSize]);

  // 处理点击事件 - 在容器上直接监听
  useEffect(() => {
    if (disabled || !viewerRef.current || !onClick) return;

    const viewer = viewerRef.current;
    const container = viewer.getContainer();
    if (!container) return;

    const clickHandler = (e: MouseEvent) => {
      const target = e.target as HTMLElement;
      if (!target) return;

      // 检查是否是 Selecto 的选择框或相关元素（框选操作）
      const isSelectoElement =
        target.closest('.selecto-selection') ||
        target.closest('.selecto-selection-area') ||
        target.classList.contains('selecto-selection') ||
        target.classList.contains('selecto-selection-area');

      // 如果是 Selecto 的框选操作，不处理点击事件
      if (isSelectoElement) {
        return;
      }

      // 检查点击的是否是元素或控制点
      const closestElement = target.closest('[id^="element-"]');
      const isElementOrControl =
        closestElement ||
        target.closest('.moveable-control-box') ||
        target.closest('.moveable-direction') ||
        target.closest('.moveable-line') ||
        target.closest('.moveable-rotation') ||
        target.closest('.moveable-control');

      // 如果点击的不是元素或控制点，触发取消选中
      if (!isElementOrControl && !isSelectoElement) {
        onClick();
      }
    };

    container.addEventListener('click', clickHandler, { capture: true });

    return () => {
      container.removeEventListener('click', clickHandler, { capture: true });
    };
  }, [disabled, onClick]);

  // 处理 Ctrl + 滚轮缩放
  useEffect(() => {
    if (disabled || !viewerRef.current) return;

    const viewer = viewerRef.current;
    const container = viewer.getContainer();
    if (!container) return;

    const wheelHandler = (e: WheelEvent) => {
      // 检查是否按下了 Ctrl 键（WheelEvent 原生支持 ctrlKey 属性）
      if (!e.ctrlKey && !e.metaKey) {
        return;
      }

      // 阻止浏览器默认的缩放行为
      e.preventDefault();
      e.stopPropagation();

      const zoomIntensity = 0.05;
      const delta = e.deltaY > 0 ? -zoomIntensity : zoomIntensity;
      const currentZoom = viewer.getZoom();
      const newZoom = Math.min(Math.max(currentZoom * (1 + delta), minScale), maxScale);

      if (newZoom === currentZoom) return;

      // 获取画布元素
      const canvasElement = document.getElementById('preview-canvas');
      if (!canvasElement || !baseCanvasSize) {
        // 如果没有画布，使用鼠标位置作为缩放中心
        const rect = container.getBoundingClientRect();
        const mouseX = e.clientX - rect.left;
        const mouseY = e.clientY - rect.top;
        const scrollLeft = viewer.getScrollLeft();
        const scrollTop = viewer.getScrollTop();

        viewer.setZoom(newZoom);
        const zoomRatio = newZoom / currentZoom;
        const newScrollLeft = mouseX - (mouseX - scrollLeft) * zoomRatio;
        const newScrollTop = mouseY - (mouseY - scrollTop) * zoomRatio;
        viewer.scrollTo(newScrollLeft, newScrollTop);
        handleScroll();
        return;
      }

      // 获取画布中心在屏幕坐标系中的位置
      const canvasRect = canvasElement.getBoundingClientRect();
      const canvasCenterX = canvasRect.left + canvasRect.width / 2;
      const canvasCenterY = canvasRect.top + canvasRect.height / 2;

      // 使用 setZoom 的 clientX 和 clientY 选项，以画布中心为缩放中心
      viewer.setZoom(newZoom, {
        clientX: canvasCenterX,
        clientY: canvasCenterY,
      });

      // 更新 transform
      handleScroll();
    };

    // 使用捕获阶段监听，确保即使控制点阻止事件也能捕获到
    container.addEventListener('wheel', wheelHandler, { passive: false, capture: true });

    return () => {
      container.removeEventListener('wheel', wheelHandler, { capture: true });
    };
  }, [disabled, minScale, maxScale, handleScroll, baseCanvasSize]);

  if (disabled) {
    // 全屏模式：不使用 InfiniteViewer，直接渲染内容
    return (
      <div className='w-full h-full flex items-center justify-center'>
        {children}
      </div>
    );
  }

  return (
    <InfiniteViewer
      ref={viewerRef}
      className='w-full h-full'
      useWheelScroll={false}
      usePinch={true}
      useMouseDrag={false}
      useWheelPinch={false}
      zoomRange={[minScale, maxScale]}
      onScroll={handleScroll}
      onPinch={handlePinch}
    >
      <div className='infinite-viewer-viewport'>
        {children}
      </div>
    </InfiniteViewer>
  );
});

export default memo(InfiniteCanvas);

