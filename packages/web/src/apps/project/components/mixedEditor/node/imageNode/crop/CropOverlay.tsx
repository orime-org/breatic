import React, { useEffect, useRef, useState } from 'react';

export type CropRect = { x: number; y: number; w: number; h: number };

type HandlePos = 'nw' | 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w';

type DragState =
  | { type: 'move'; startX: number; startY: number; origRect: CropRect }
  | { type: 'resize'; handle: HandlePos; startX: number; startY: number; origRect: CropRect };

const minSize = 20;

const calcMove = (origRect: CropRect, dx: number, dy: number, cw: number, ch: number): CropRect => {
  const newX = Math.max(0, Math.min(origRect.x + dx, cw - origRect.w));
  const newY = Math.max(0, Math.min(origRect.y + dy, ch - origRect.h));
  return { ...origRect, x: newX, y: newY };
};

const calcEdgeResize = (
  origRect: CropRect,
  handle: 'n' | 's' | 'w' | 'e',
  dx: number,
  dy: number,
  cw: number,
  ch: number,
): CropRect => {
  const right = origRect.x + origRect.w;
  const bottom = origRect.y + origRect.h;

  if (handle === 'n') {
    const newY = Math.max(0, Math.min(origRect.y + dy, bottom - minSize));
    return { ...origRect, y: newY, h: bottom - newY };
  }
  if (handle === 's') {
    const newBottom = Math.max(origRect.y + minSize, Math.min(bottom + dy, ch));
    return { ...origRect, h: newBottom - origRect.y };
  }
  if (handle === 'w') {
    const newX = Math.max(0, Math.min(origRect.x + dx, right - minSize));
    return { ...origRect, x: newX, w: right - newX };
  }
  // e
  const newRight = Math.max(origRect.x + minSize, Math.min(right + dx, cw));
  return { ...origRect, w: newRight - origRect.x };
};

const calcCornerResize = (
  origRect: CropRect,
  handle: 'nw' | 'ne' | 'sw' | 'se',
  dx: number,
  dy: number,
  cw: number,
  ch: number,
): CropRect => {
  const right = origRect.x + origRect.w;
  const bottom = origRect.y + origRect.h;
  const minScale = minSize / Math.min(origRect.w, origRect.h);

  if (handle === 'se') {
    // Fixed point: top-left
    const maxScale = Math.min((cw - origRect.x) / origRect.w, (ch - origRect.y) / origRect.h);
    const rawScale = Math.min((origRect.w + dx) / origRect.w, (origRect.h + dy) / origRect.h);
    const scale = Math.max(minScale, Math.min(rawScale, maxScale));
    return { x: origRect.x, y: origRect.y, w: origRect.w * scale, h: origRect.h * scale };
  }
  if (handle === 'sw') {
    // Fixed point: top-right
    const maxScale = Math.min(right / origRect.w, (ch - origRect.y) / origRect.h);
    const rawScale = Math.min((origRect.w - dx) / origRect.w, (origRect.h + dy) / origRect.h);
    const scale = Math.max(minScale, Math.min(rawScale, maxScale));
    const newW = origRect.w * scale;
    return { x: right - newW, y: origRect.y, w: newW, h: origRect.h * scale };
  }
  if (handle === 'ne') {
    // Fixed point: bottom-left
    const maxScale = Math.min((cw - origRect.x) / origRect.w, bottom / origRect.h);
    const rawScale = Math.min((origRect.w + dx) / origRect.w, (origRect.h - dy) / origRect.h);
    const scale = Math.max(minScale, Math.min(rawScale, maxScale));
    const newH = origRect.h * scale;
    return { x: origRect.x, y: bottom - newH, w: origRect.w * scale, h: newH };
  }
  // nw: fixed point: bottom-right
  const maxScale = Math.min(right / origRect.w, bottom / origRect.h);
  const rawScale = Math.min((origRect.w - dx) / origRect.w, (origRect.h - dy) / origRect.h);
  const scale = Math.max(minScale, Math.min(rawScale, maxScale));
  const newW = origRect.w * scale;
  const newH = origRect.h * scale;
  return { x: right - newW, y: bottom - newH, w: newW, h: newH };
};

const handles: { id: HandlePos; cursor: string; style: React.CSSProperties }[] = [
  { id: 'nw', cursor: 'nw-resize', style: { top: -4, left: -4 } },
  { id: 'n', cursor: 'n-resize', style: { top: -4, left: '50%', transform: 'translateX(-50%)' } },
  { id: 'ne', cursor: 'ne-resize', style: { top: -4, right: -4 } },
  { id: 'e', cursor: 'e-resize', style: { top: '50%', right: -4, transform: 'translateY(-50%)' } },
  { id: 'se', cursor: 'se-resize', style: { bottom: -4, right: -4 } },
  { id: 's', cursor: 's-resize', style: { bottom: -4, left: '50%', transform: 'translateX(-50%)' } },
  { id: 'sw', cursor: 'sw-resize', style: { bottom: -4, left: -4 } },
  { id: 'w', cursor: 'w-resize', style: { top: '50%', left: -4, transform: 'translateY(-50%)' } },
];

type CropOverlayProps = {
  containerWidth: number;
  containerHeight: number;
  value: CropRect;
  onChange: (rect: CropRect) => void;
};

const CropOverlay: React.FC<CropOverlayProps> = ({ containerWidth, containerHeight, value, onChange }) => {
  const [isDragging, setIsDragging] = useState(false);
  const dragRef = useRef<DragState | null>(null);
  const valueRef = useRef(value);
  valueRef.current = value;

  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  const containerWidthRef = useRef(containerWidth);
  containerWidthRef.current = containerWidth;
  const containerHeightRef = useRef(containerHeight);
  containerHeightRef.current = containerHeight;

  // Used to read the container's actual rendered size to calculate the ReactFlow viewport zoom ratio
  const containerElRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      const drag = dragRef.current;
      if (!drag) return;

      // Convert screen pixel offset to node logical coordinate system.
      // containerEl clientWidth is the actual rendered width; containerWidth is the logical width; their ratio is the viewport zoom.
      const renderedWidth = containerElRef.current?.getBoundingClientRect().width ?? containerWidthRef.current;
      const zoom = renderedWidth / containerWidthRef.current;

      const dx = (e.clientX - drag.startX) / zoom;
      const dy = (e.clientY - drag.startY) / zoom;
      const { origRect } = drag;
      const cw = containerWidthRef.current;
      const ch = containerHeightRef.current;

      if (drag.type === 'move') {
        onChangeRef.current(calcMove(origRect, dx, dy, cw, ch));
        return;
      }

      const { handle } = drag;
      const isEdge = handle === 'n' || handle === 's' || handle === 'w' || handle === 'e';
      const result = isEdge
        ? calcEdgeResize(origRect, handle, dx, dy, cw, ch)
        : calcCornerResize(origRect, handle as 'nw' | 'ne' | 'sw' | 'se', dx, dy, cw, ch);

      onChangeRef.current(result);
    };

    const onUp = () => {
      dragRef.current = null;
      setIsDragging(false);
    };

    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    return () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
  }, []);

  const { x, y, w, h } = value;

  const handleCropBoxMouseDown = (e: React.MouseEvent) => {
    dragRef.current = {
      type: 'move',
      startX: e.clientX,
      startY: e.clientY,
      origRect: valueRef.current,
    };
    setIsDragging(true);
    e.stopPropagation();
    e.preventDefault();
  };

  const createHandleMouseDown = (id: HandlePos) => (e: React.MouseEvent) => {
    dragRef.current = {
      type: 'resize',
      handle: id,
      startX: e.clientX,
      startY: e.clientY,
      origRect: valueRef.current,
    };
    setIsDragging(true);
    e.stopPropagation();
    e.preventDefault();
  };

  return (
    <div
      ref={containerElRef}
      className='nodrag nopan pointer-events-none absolute inset-0'
      style={{ width: containerWidth, height: containerHeight, zIndex: 10, overflow: 'visible' }}
    >
      {/* Dimmed area: single box-shadow cutout; clip to container */}
      <div className='pointer-events-none absolute inset-0 overflow-hidden'>
        <div
          className='absolute'
          style={{
            left: x,
            top: y,
            width: w,
            height: h,
            boxShadow: '0 0 0 9999px rgba(0, 0, 0, 0.5)',
          }}
        />
      </div>

      {/* Crop box */}
      <div
        className='nodrag nopan pointer-events-auto absolute cursor-move'
        style={{
          top: y,
          left: x,
          width: w,
          height: h,
          border: '1px solid #A5A6F6',
          boxSizing: 'border-box',
          overflow: 'visible',
        }}
        onMouseDown={handleCropBoxMouseDown}
      >
        {/* Rule-of-thirds grid */}
        {isDragging && (
          <div className='pointer-events-none absolute inset-0'>
            <div className='absolute bg-white/30' style={{ top: '33.33%', left: 0, right: 0, height: 1 }} />
            <div className='absolute bg-white/30' style={{ top: '66.66%', left: 0, right: 0, height: 1 }} />
            <div className='absolute bg-white/30' style={{ top: 0, bottom: 0, left: '33.33%', width: 1 }} />
            <div className='absolute bg-white/30' style={{ top: 0, bottom: 0, left: '66.66%', width: 1 }} />
          </div>
        )}

        {/* Corner & edge resize handles */}
        {handles.map(({ id, cursor, style }) => {
          const isHorizontalEdge = id === 'n' || id === 's';
          const isVerticalEdge = id === 'w' || id === 'e';
          let shapeClass = 'h-2 w-2 rounded-full';
          if (isHorizontalEdge) shapeClass = 'h-1.5 w-4 rounded-full';
          if (isVerticalEdge) shapeClass = 'h-4 w-1.5 rounded-full';
          return (
            <div
              key={id}
              className={`nodrag nopan pointer-events-auto absolute border border-[#A5A6F6] bg-white shadow ${shapeClass}`}
              style={{ ...style, cursor }}
              onMouseDown={createHandleMouseDown(id)}
            />
          );
        })}
      </div>
    </div>
  );
};

export default CropOverlay;
