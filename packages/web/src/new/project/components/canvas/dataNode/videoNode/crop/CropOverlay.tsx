import React, { useEffect, useRef, useState } from 'react';

export type CropRect = { x: number; y: number; w: number; h: number };
type HandlePos = 'nw' | 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w';
type DragState =
  | { type: 'move'; startX: number; startY: number; origRect: CropRect }
  | { type: 'resize'; handle: HandlePos; startX: number; startY: number; origRect: CropRect };

const minSize = 20;
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
  viewportScale?: number;
};

const CropOverlay: React.FC<CropOverlayProps> = ({ containerWidth, containerHeight, value, onChange, viewportScale }) => {
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
  const containerElRef = useRef<HTMLDivElement>(null);
  const viewportScaleRef = useRef<number | undefined>(viewportScale);
  viewportScaleRef.current = viewportScale;

  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      const drag = dragRef.current;
      if (!drag) return;

      const renderedWidth = containerElRef.current?.getBoundingClientRect().width ?? containerWidthRef.current;
      const measuredZoom = renderedWidth / containerWidthRef.current;
      const zoom = Math.max(0.0001, viewportScaleRef.current ?? measuredZoom);

      const dx = (e.clientX - drag.startX) / zoom;
      const dy = (e.clientY - drag.startY) / zoom;
      const r = drag.origRect;
      const right = r.x + r.w;
      const bottom = r.y + r.h;
      const cw = containerWidthRef.current;
      const ch = containerHeightRef.current;
      if (drag.type === 'move') {
        onChangeRef.current({
          ...r,
          x: Math.max(0, Math.min(r.x + dx, cw - r.w)),
          y: Math.max(0, Math.min(r.y + dy, ch - r.h)),
        });
        return;
      }
      const handle = drag.handle;
      const next = { ...r };
      if (handle.includes('w')) {
        const nx = Math.max(0, Math.min(r.x + dx, right - minSize));
        next.x = nx;
        next.w = right - nx;
      }
      if (handle.includes('e')) {
        const nr = Math.max(r.x + minSize, Math.min(right + dx, cw));
        next.w = nr - r.x;
      }
      if (handle.includes('n')) {
        const ny = Math.max(0, Math.min(r.y + dy, bottom - minSize));
        next.y = ny;
        next.h = bottom - ny;
      }
      if (handle.includes('s')) {
        const nb = Math.max(r.y + minSize, Math.min(bottom + dy, ch));
        next.h = nb - r.y;
      }
      onChangeRef.current(next);
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
  const renderZoom = Math.max(0.0001, viewportScale ?? 1);
  const uiScale = 1 / renderZoom;
  const borderWidth = Math.max(1 / renderZoom, 0.5);
  const handleOffset = 4 * uiScale;
  const cornerSize = 8 * uiScale;
  const horizontalHandleWidth = 16 * uiScale;
  const horizontalHandleHeight = 6 * uiScale;
  const verticalHandleWidth = 6 * uiScale;
  const verticalHandleHeight = 16 * uiScale;
  const handleBorderWidth = Math.max(1 * uiScale, 0.5);

  return (
    <div
      ref={containerElRef}
      className='nodrag nopan pointer-events-none absolute inset-0 z-[60]'
      style={{ width: containerWidth, height: containerHeight, overflow: 'visible' }}
    >
      <div className='pointer-events-none absolute inset-0 overflow-hidden'>
        <div className='absolute' style={{ left: x, top: y, width: w, height: h, boxShadow: '0 0 0 9999px rgba(0, 0, 0, 0.5)' }} />
      </div>
      <div
        className='nodrag nopan pointer-events-auto absolute cursor-move'
        style={{
          top: y,
          left: x,
          width: w,
          height: h,
          border: `${borderWidth}px solid #A5A6F6`,
          boxSizing: 'border-box',
          overflow: 'visible',
        }}
        onMouseDown={(e) => {
          dragRef.current = { type: 'move', startX: e.clientX, startY: e.clientY, origRect: valueRef.current };
          setIsDragging(true);
          e.stopPropagation();
          e.preventDefault();
        }}
      >
        {isDragging && (
          <div className='pointer-events-none absolute inset-0'>
            <div className='absolute bg-white/30' style={{ top: '33.33%', left: 0, right: 0, height: borderWidth }} />
            <div className='absolute bg-white/30' style={{ top: '66.66%', left: 0, right: 0, height: borderWidth }} />
            <div className='absolute bg-white/30' style={{ top: 0, bottom: 0, left: '33.33%', width: borderWidth }} />
            <div className='absolute bg-white/30' style={{ top: 0, bottom: 0, left: '66.66%', width: borderWidth }} />
          </div>
        )}
        {handles.map(({ id, cursor }) => {
          const isHorizontalEdge = id === 'n' || id === 's';
          const isVerticalEdge = id === 'w' || id === 'e';
          const baseStyle: React.CSSProperties = {};
          if (id.includes('n')) baseStyle.top = -handleOffset;
          if (id.includes('s')) baseStyle.bottom = -handleOffset;
          if (id.includes('w')) baseStyle.left = -handleOffset;
          if (id.includes('e')) baseStyle.right = -handleOffset;
          if (id === 'n' || id === 's') {
            baseStyle.left = '50%';
            baseStyle.transform = 'translateX(-50%)';
          }
          if (id === 'w' || id === 'e') {
            baseStyle.top = '50%';
            baseStyle.transform = 'translateY(-50%)';
          }
          if (id === 'nw' || id === 'ne' || id === 'sw' || id === 'se') {
            baseStyle.width = cornerSize;
            baseStyle.height = cornerSize;
            baseStyle.borderRadius = '9999px';
          } else if (isHorizontalEdge) {
            baseStyle.width = horizontalHandleWidth;
            baseStyle.height = horizontalHandleHeight;
            baseStyle.borderRadius = 9999 * uiScale;
          } else if (isVerticalEdge) {
            baseStyle.width = verticalHandleWidth;
            baseStyle.height = verticalHandleHeight;
            baseStyle.borderRadius = 9999 * uiScale;
          }
          return (
            <div
              key={id}
              className='nodrag nopan pointer-events-auto absolute bg-white shadow'
              style={{ ...baseStyle, cursor, border: `${handleBorderWidth}px solid #A5A6F6` }}
              onMouseDown={(e) => {
                dragRef.current = { type: 'resize', handle: id, startX: e.clientX, startY: e.clientY, origRect: valueRef.current };
                setIsDragging(true);
                e.stopPropagation();
                e.preventDefault();
              }}
            />
          );
        })}
      </div>
    </div>
  );
};

export default CropOverlay;
