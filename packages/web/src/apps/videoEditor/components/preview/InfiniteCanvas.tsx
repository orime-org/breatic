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

  // canvas （ alignment + ）
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

  // component
  useImperativeHandle(ref, () => ({
    centerCanvas,
  }), [centerCanvas]);

  // handle ，update transform
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


  // handlescale （ scale）， canvas startscale
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

    // getcanvas
    const canvasElement = document.getElementById('preview-canvas');
    if (!canvasElement) {
      handleScroll();
      return;
    }

    // getcanvas coordinate
    const canvasRect = canvasElement.getBoundingClientRect();
    const canvasCenterX = canvasRect.left + canvasRect.width / 2;
    const canvasCenterY = canvasRect.top + canvasRect.height / 2;

    // get scale
    const currentZoom = viewer.getZoom();

    // use setZoom clientX clientY ， canvas scale
    viewer.setZoom(currentZoom, {
      clientX: canvasCenterX,
      clientY: canvasCenterY,
    });

    handleScroll();
  }, [handleScroll, baseCanvasSize]);

  // handle - containerup listen
  useEffect(() => {
    if (disabled || !viewerRef.current || !onClick) return;

    const viewer = viewerRef.current;
    const container = viewer.getContainer();
    if (!container) return;

    const clickHandler = (e: MouseEvent) => {
      const target = e.target as HTMLElement;
      if (!target) return;

      // check Selecto （box select ）
      const isSelectoElement =
        target.closest('.selecto-selection') ||
        target.closest('.selecto-selection-area') ||
        target.classList.contains('selecto-selection') ||
        target.classList.contains('selecto-selection-area');

      // if Selecto box select ， handle
      if (isSelectoElement) {
        return;
      }

      // check control
      const closestElement = target.closest('[id^="element-"]');
      const isElementOrControl =
        closestElement ||
        target.closest('.moveable-control-box') ||
        target.closest('.moveable-direction') ||
        target.closest('.moveable-line') ||
        target.closest('.moveable-rotation') ||
        target.closest('.moveable-control');

      // if control ， selected
      if (!isElementOrControl && !isSelectoElement) {
        onClick();
      }
    };

    container.addEventListener('click', clickHandler, { capture: true });

    return () => {
      container.removeEventListener('click', clickHandler, { capture: true });
    };
  }, [disabled, onClick]);

  // handle Ctrl + scale
  useEffect(() => {
    if (disabled || !viewerRef.current) return;

    const viewer = viewerRef.current;
    const container = viewer.getContainer();
    if (!container) return;

    const wheelHandler = (e: WheelEvent) => {
      // check down Ctrl （WheelEvent support ctrlKey ）
      if (!e.ctrlKey && !e.metaKey) {
        return;
      }

      // prevent default scale
      e.preventDefault();
      e.stopPropagation();

      const zoomIntensity = 0.05;
      const delta = e.deltaY > 0 ? -zoomIntensity : zoomIntensity;
      const currentZoom = viewer.getZoom();
      const newZoom = Math.min(Math.max(currentZoom * (1 + delta), minScale), maxScale);

      if (newZoom === currentZoom) return;

      // getcanvas
      const canvasElement = document.getElementById('preview-canvas');
      if (!canvasElement || !baseCanvasSize) {
        // ifnocanvas，use scale
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

      // getcanvas coordinate
      const canvasRect = canvasElement.getBoundingClientRect();
      const canvasCenterX = canvasRect.left + canvasRect.width / 2;
      const canvasCenterY = canvasRect.top + canvasRect.height / 2;

      // use setZoom clientX clientY ， canvas scale
      viewer.setZoom(newZoom, {
        clientX: canvasCenterX,
        clientY: canvasCenterY,
      });

      // update transform
      handleScroll();
    };

    // use listen，ensure control prevent
    container.addEventListener('wheel', wheelHandler, { passive: false, capture: true });

    return () => {
      container.removeEventListener('wheel', wheelHandler, { capture: true });
    };
  }, [disabled, minScale, maxScale, handleScroll, baseCanvasSize]);

  if (disabled) {
    // fullscreen ： use InfiniteViewer，
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

