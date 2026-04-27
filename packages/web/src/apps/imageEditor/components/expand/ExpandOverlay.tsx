import React, { useEffect, useRef, useState } from 'react';

export type ExpandFrame = { w: number; h: number; ox: number; oy: number };

type HandlePos = 'nw' | 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w';

type DragState =
  | { type: 'move'; startX: number; startY: number; orig: ExpandFrame }
  | { type: 'resize'; handle: HandlePos; startX: number; startY: number; orig: ExpandFrame };

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

const calcExpandEdgeResize = (
  orig: ExpandFrame,
  handle: 'n' | 's' | 'w' | 'e',
  dx: number,
  dy: number,
  cw: number,
  ch: number,
): ExpandFrame => {
  const { ox, oy, w, h } = orig;
  const right = ox + w;
  const bottom = oy + h;

  if (handle === 'n') {
    const newY = Math.min(0, oy + dy, bottom - ch);
    return { ox, oy: newY, w, h: bottom - newY };
  }
  if (handle === 's') {
    const newBottom = Math.max(ch, bottom + dy);
    return { ox, oy, w, h: newBottom - oy };
  }
  if (handle === 'w') {
    const newX = Math.min(0, ox + dx, right - cw);
    return { ox: newX, oy, w: right - newX, h };
  }
  const newRight = Math.max(cw, right + dx);
  return { ox, oy, w: newRight - ox, h };
};

const calcExpandCornerResize = (
  orig: ExpandFrame,
  handle: 'nw' | 'ne' | 'sw' | 'se',
  dx: number,
  dy: number,
  cw: number,
  ch: number,
): ExpandFrame => {
  const { ox, oy, w: w0, h: h0 } = orig;
  const right = ox + w0;
  const bottom = oy + h0;

  if (handle === 'se') {
    const rawScale = Math.min((w0 + dx) / w0, (h0 + dy) / h0);
    const minScale = Math.max((cw - ox) / w0, (ch - oy) / h0);
    const scale = Math.max(minScale, rawScale);
    return { ox, oy, w: w0 * scale, h: h0 * scale };
  }
  if (handle === 'sw') {
    const rawScale = Math.min((w0 - dx) / w0, (h0 + dy) / h0);
    const minScale = Math.max(right / w0, (ch - oy) / h0);
    const scale = Math.max(minScale, rawScale);
    const newW = w0 * scale;
    return { ox: right - newW, oy, w: newW, h: h0 * scale };
  }
  if (handle === 'ne') {
    const rawScale = Math.min((w0 + dx) / w0, (h0 - dy) / h0);
    const minScale = Math.max((cw - ox) / w0, bottom / h0);
    const scale = Math.max(minScale, rawScale);
    const newH = h0 * scale;
    return { ox, oy: bottom - newH, w: w0 * scale, h: newH };
  }
  const rawScale = Math.min((w0 - dx) / w0, (h0 - dy) / h0);
  const minScale = Math.max(right / w0, bottom / h0);
  const scale = Math.max(minScale, rawScale);
  const newW = w0 * scale;
  const newH = h0 * scale;
  return { ox: right - newW, oy: bottom - newH, w: newW, h: newH };
};

type ExpandOverlayProps = {
  containerWidth: number;
  containerHeight: number;
  outerWidth: number;
  outerHeight: number;
  originX: number;
  originY: number;
  onFrameChange: (next: ExpandFrame) => void;
  viewportScale?: number;
};

const ExpandOverlay: React.FC<ExpandOverlayProps> = ({
  containerWidth,
  containerHeight,
  outerWidth,
  outerHeight,
  originX,
  originY,
  onFrameChange,
  viewportScale,
}) => {
  const cw = Math.max(1, containerWidth);
  const ch = Math.max(1, containerHeight);
  const ow = Math.max(cw, outerWidth);
  const oh = Math.max(ch, outerHeight);

  const [isDragging, setIsDragging] = useState(false);
  const [snapX, setSnapX] = useState(false);
  const [snapY, setSnapY] = useState(false);
  const setSnapXRef = useRef(setSnapX);
  const setSnapYRef = useRef(setSnapY);
  setSnapXRef.current = setSnapX;
  setSnapYRef.current = setSnapY;

  const dragRef = useRef<DragState | null>(null);
  const frameRef = useRef<ExpandFrame>({ w: ow, h: oh, ox: originX, oy: originY });
  frameRef.current = { w: ow, h: oh, ox: originX, oy: originY };

  const onFrameChangeRef = useRef(onFrameChange);
  onFrameChangeRef.current = onFrameChange;

  const cwRef = useRef(cw);
  const chRef = useRef(ch);
  cwRef.current = cw;
  chRef.current = ch;

  const containerElRef = useRef<HTMLDivElement>(null);
  const viewportScaleRef = useRef<number | undefined>(viewportScale);
  viewportScaleRef.current = viewportScale;

  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      const drag = dragRef.current;
      if (!drag) return;

      const renderedWidth = containerElRef.current?.getBoundingClientRect().width ?? cwRef.current;
      const measuredZoom = renderedWidth / cwRef.current;
      const zoom = Math.max(0.0001, viewportScaleRef.current ?? measuredZoom);
      const dx = (e.clientX - drag.startX) / zoom;
      const dy = (e.clientY - drag.startY) / zoom;
      const { orig } = drag;
      const cwi = cwRef.current;
      const chi = chRef.current;
      const SNAP_THRESHOLD = 5;

      if (drag.type === 'move') {
        const { w, h } = orig;
        let ox = Math.min(0, Math.max(cwi - w, orig.ox + dx));
        let oy = Math.min(0, Math.max(chi - h, orig.oy + dy));
        const centerOx = (cwi - w) / 2;
        const centerOy = (chi - h) / 2;
        const nx = Math.abs(ox - centerOx) < SNAP_THRESHOLD;
        const ny = Math.abs(oy - centerOy) < SNAP_THRESHOLD;
        if (nx) ox = centerOx;
        if (ny) oy = centerOy;
        setSnapXRef.current(nx);
        setSnapYRef.current(ny);
        onFrameChangeRef.current({ w, h, ox, oy });
        return;
      }

      setSnapXRef.current(false);
      setSnapYRef.current(false);
      const { handle } = drag;
      const isEdge = handle === 'n' || handle === 's' || handle === 'w' || handle === 'e';
      const next = isEdge
        ? calcExpandEdgeResize(orig, handle, dx, dy, cwi, chi)
        : calcExpandCornerResize(orig, handle as 'nw' | 'ne' | 'sw' | 'se', dx, dy, cwi, chi);
      onFrameChangeRef.current(next);
    };

    const onUp = () => {
      dragRef.current = null;
      setIsDragging(false);
      setSnapXRef.current(false);
      setSnapYRef.current(false);
    };

    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    return () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
  }, []);

  const handleFrameMouseDown = (e: React.MouseEvent) => {
    dragRef.current = {
      type: 'move',
      startX: e.clientX,
      startY: e.clientY,
      orig: { ...frameRef.current },
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
      orig: { ...frameRef.current },
    };
    setIsDragging(true);
    e.stopPropagation();
    e.preventDefault();
  };

  const holeLeft = -originX;
  const holeTop = -originY;
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
      className='nodrag nopan pointer-events-none absolute inset-0 z-10 overflow-visible'
      style={{ width: cw, height: ch }}
    >
      <div
        className='nodrag nopan pointer-events-auto absolute cursor-move'
        style={{
          left: originX,
          top: originY,
          width: ow,
          height: oh,
          border: `${borderWidth}px solid #A5A6F6`,
          boxSizing: 'border-box',
          overflow: 'visible',
        }}
        onMouseDown={handleFrameMouseDown}
      >
        <div className='pointer-events-none absolute inset-0 overflow-hidden'>
          <div
            className='absolute'
            style={{
              left: holeLeft,
              top: holeTop,
              width: cw,
              height: ch,
              boxShadow: '0 0 0 9999px rgba(0, 0, 0, 0.4)',
            }}
          />
        </div>

        {isDragging && snapX && (
          <div
            className='pointer-events-none absolute'
            style={{ left: holeLeft + cw / 2 - borderWidth / 2, top: 0, width: borderWidth, bottom: 0, background: '#818cf8' }}
          />
        )}
        {isDragging && snapY && (
          <div
            className='pointer-events-none absolute'
            style={{ top: holeTop + ch / 2 - borderWidth / 2, left: 0, height: borderWidth, right: 0, background: '#818cf8' }}
          />
        )}

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
              onMouseDown={createHandleMouseDown(id)}
            />
          );
        })}
      </div>
    </div>
  );
};

export default ExpandOverlay;

