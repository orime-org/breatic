import React, { useEffect, useRef, useState } from 'react';

export type ExpandFrame = { w: number; h: number; ox: number; oy: number };

type HandlePos = 'nw' | 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w';

type DragState =
  | { type: 'move'; startX: number; startY: number; orig: ExpandFrame }
  | { type: 'resize'; handle: HandlePos; startX: number; startY: number; orig: ExpandFrame };

/** Handle layout and cursors consistent with CropOverlay */
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

/**
 * Edge handle resize: ensures the outer frame always contains the image (no edge can cross the image boundary).
 * n/s constrains top/bottom; w/e constrains left/right.
 */
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
    // Top edge: cannot go above the image top (newY ≤ 0), height must not be less than ch
    const newY = Math.min(0, oy + dy, bottom - ch);
    return { ox, oy: newY, w, h: bottom - newY };
  }
  if (handle === 's') {
    // Bottom edge: cannot go below the image bottom (newBottom ≥ ch)
    const newBottom = Math.max(ch, bottom + dy);
    return { ox, oy, w, h: newBottom - oy };
  }
  if (handle === 'w') {
    // Left edge: cannot go beyond the image left (newX ≤ 0), width must not be less than cw
    const newX = Math.min(0, ox + dx, right - cw);
    return { ox: newX, oy, w: right - newX, h };
  }
  // e: right edge cannot go beyond the image right (newRight ≥ cw)
  const newRight = Math.max(cw, right + dx);
  return { ox, oy, w: newRight - ox, h };
};

/**
 * Corner handle: proportional scaling; minScale is calculated precisely from the fixed point of each corner,
 * ensuring all four sides of the outer frame still contain the image after scaling (no corner can move inside the image).
 */
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
    // Fixed point: top-left (ox, oy); right ≥ cw, bottom ≥ ch
    const rawScale = Math.min((w0 + dx) / w0, (h0 + dy) / h0);
    const minScale = Math.max((cw - ox) / w0, (ch - oy) / h0);
    const scale = Math.max(minScale, rawScale);
    return { ox, oy, w: w0 * scale, h: h0 * scale };
  }
  if (handle === 'sw') {
    // Fixed point: top-right (right, oy); left ≤ 0, bottom ≥ ch
    const rawScale = Math.min((w0 - dx) / w0, (h0 + dy) / h0);
    const minScale = Math.max(right / w0, (ch - oy) / h0);
    const scale = Math.max(minScale, rawScale);
    const newW = w0 * scale;
    return { ox: right - newW, oy, w: newW, h: h0 * scale };
  }
  if (handle === 'ne') {
    // Fixed point: bottom-left (ox, bottom); right ≥ cw, top ≤ 0
    const rawScale = Math.min((w0 + dx) / w0, (h0 - dy) / h0);
    const minScale = Math.max((cw - ox) / w0, bottom / h0);
    const scale = Math.max(minScale, rawScale);
    const newH = h0 * scale;
    return { ox, oy: bottom - newH, w: w0 * scale, h: newH };
  }
  // nw: fixed point: bottom-right (right, bottom); left ≤ 0, top ≤ 0
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
};

const ExpandOverlay: React.FC<ExpandOverlayProps> = ({
  containerWidth,
  containerHeight,
  outerWidth,
  outerHeight,
  originX,
  originY,
  onFrameChange,
}) => {
  const cw = Math.max(1, containerWidth);
  const ch = Math.max(1, containerHeight);
  const ow = Math.max(cw, outerWidth);
  const oh = Math.max(ch, outerHeight);

  const [isDragging, setIsDragging] = useState(false);
  const [snapX, setSnapX] = useState(false); // Horizontal center snap (ox alignment)
  const [snapY, setSnapY] = useState(false); // Vertical center snap (oy alignment)
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

  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      const drag = dragRef.current;
      if (!drag) return;

      const renderedWidth = containerElRef.current?.getBoundingClientRect().width ?? cwRef.current;
      const zoom = renderedWidth / cwRef.current;
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

  // Image offset within the outer frame (since frame ox≤0 oy≤0, these values are ≥0)
  const holeLeft = -originX;
  const holeTop = -originY;

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
          border: '1px solid #A5A6F6',
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

        {/* Center snap lines: span the entire outer frame to indicate image center axes */}
        {isDragging && snapX && (
          <div
            className='pointer-events-none absolute'
            style={{ left: holeLeft + cw / 2 - 0.5, top: 0, width: 1, bottom: 0, background: '#818cf8' }}
          />
        )}
        {isDragging && snapY && (
          <div
            className='pointer-events-none absolute'
            style={{ top: holeTop + ch / 2 - 0.5, left: 0, height: 1, right: 0, background: '#818cf8' }}
          />
        )}

        {isDragging && (
          <div className='pointer-events-none absolute inset-0'>
            <div className='absolute bg-white/30' style={{ top: '33.33%', left: 0, right: 0, height: 1 }} />
            <div className='absolute bg-white/30' style={{ top: '66.66%', left: 0, right: 0, height: 1 }} />
            <div className='absolute bg-white/30' style={{ top: 0, bottom: 0, left: '33.33%', width: 1 }} />
            <div className='absolute bg-white/30' style={{ top: 0, bottom: 0, left: '66.66%', width: 1 }} />
          </div>
        )}

        {handles.map(({ id, cursor, style }) => {
          const isHorizontalEdge = id === 'n' || id === 's';
          const isVerticalEdge = id === 'w' || id === 'e';
          let shapeClass = 'h-2 w-2 rounded-full'; // Corner handle: circle
          if (isHorizontalEdge) shapeClass = 'h-1.5 w-4 rounded-full'; // Top/bottom: horizontal capsule
          if (isVerticalEdge) shapeClass = 'h-4 w-1.5 rounded-full'; // Left/right: vertical capsule
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

export default ExpandOverlay;
