/**
 * CropOverlay — interactive rectangle the user drags to define a crop
 * region. Mounted on top of the source ImageNode's image surface while
 * the active mini-tool is `crop` and targeting this node.
 *
 * Architecture (ADR `2026-05-11-mini-tool-state-machine.md` D3):
 *   - Local drag state lives here (rect coords + which handle is held).
 *   - The committed rect is published to `MiniToolContext.specialValues`
 *     so `BottomToolbar`'s Apply can merge it into the payload that
 *     `handleMiniToolApply` forwards to `runCategoryAOp('crop', ...)`.
 *   - On unmount (tool switched / canvas torn down) we clear
 *     `specialValues` so a leftover rect from a previous session can't
 *     accidentally crop a different node.
 *
 * Rect is normalized in `[0, 1]` so the same value works whether the
 * source blob is the 4K original behind the displayed pixels or a
 * downscaled preview. Bounds checks (clamp + minimum size) live in
 * `image-ops/crop.ts::resolveSourceRect`; we only enforce the visual
 * minimum here so handles don't cross.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { useMiniTool } from '../MiniToolContext';

/** Smallest rect width/height in normalized units (≈5 % of the image). */
const MIN_REL_SIZE = 0.05;

/**
 * 9 anchor points for drag operations:
 *   - `move` — interior drag, translates the whole rect
 *   - 4 corners (nw/ne/sw/se) — resize from a corner
 *   - 4 edges (n/s/e/w)       — resize along one axis
 */
type DragAnchor = 'move' | 'nw' | 'ne' | 'sw' | 'se' | 'n' | 's' | 'e' | 'w';

interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

const DEFAULT_RECT: Rect = { x: 0.1, y: 0.1, width: 0.8, height: 0.8 };

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

interface CropOverlayProps {
  /** Id of the node this overlay is anchored to — must match `useMiniTool().active.nodeId` to render. */
  nodeId: string;
}

/**
 * Render the crop rectangle on top of the host image. Returns `null`
 * when the active mini-tool is not `crop` targeting this node, so the
 * host can mount the component unconditionally as a sibling of the
 * image without performance cost.
 */
export function CropOverlay({ nodeId }: CropOverlayProps) {
  const { active, setSpecialValues } = useMiniTool();
  const isActive = active?.toolId === 'crop' && active?.nodeId === nodeId;

  const containerRef = useRef<HTMLDivElement | null>(null);
  const [rect, setRect] = useState<Rect>(DEFAULT_RECT);

  // Track drag state in a ref — re-rendering inside mousemove would
  // re-create handler closures and cause stutter on a 60 Hz drag.
  const dragRef = useRef<{
    anchor: DragAnchor;
    startMouseX: number;
    startMouseY: number;
    startRect: Rect;
    containerWidth: number;
    containerHeight: number;
  } | null>(null);

  // Reset to the default rect each time the tool activates so a stale
  // rect from a previous Apply / Cancel cycle doesn't carry over.
  useEffect(() => {
    if (isActive) setRect(DEFAULT_RECT);
  }, [isActive]);

  // Publish the live rect to MiniToolContext on every change so Apply
  // always sees the latest position. Clearing on inactivity prevents
  // leftover values from leaking into the next tool's Apply payload.
  useEffect(() => {
    if (!isActive) return;
    setSpecialValues({
      x: rect.x,
      y: rect.y,
      width: rect.width,
      height: rect.height,
    });
  }, [isActive, rect, setSpecialValues]);

  // Clear specialValues on unmount so the next pickTool starts clean.
  useEffect(() => {
    return () => setSpecialValues(null);
  }, [setSpecialValues]);

  const handleMouseDown = useCallback(
    (anchor: DragAnchor) => (e: React.MouseEvent) => {
      const container = containerRef.current;
      if (!container) return;
      e.stopPropagation();
      e.preventDefault();
      const box = container.getBoundingClientRect();
      dragRef.current = {
        anchor,
        startMouseX: e.clientX,
        startMouseY: e.clientY,
        startRect: rect,
        containerWidth: box.width,
        containerHeight: box.height,
      };
    },
    [rect],
  );

  useEffect(() => {
    if (!isActive) return;
    const onMove = (e: MouseEvent) => {
      const drag = dragRef.current;
      if (!drag) return;
      const dx = (e.clientX - drag.startMouseX) / drag.containerWidth;
      const dy = (e.clientY - drag.startMouseY) / drag.containerHeight;
      setRect(applyDrag(drag.startRect, drag.anchor, dx, dy));
    };
    const onUp = () => {
      dragRef.current = null;
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    return () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
  }, [isActive]);

  const rectStyle = useMemo(
    () => ({
      left: `${rect.x * 100}%`,
      top: `${rect.y * 100}%`,
      width: `${rect.width * 100}%`,
      height: `${rect.height * 100}%`,
    }),
    [rect],
  );

  if (!isActive) return null;

  return (
    <div
      ref={containerRef}
      className='absolute inset-0 z-[20] pointer-events-auto nodrag'
      data-crop-overlay
      onMouseDown={(e) => e.stopPropagation()}
    >
      {/* Darken the area outside the rect to focus attention. The rect
          itself stays bright. SVG handles the cut-out cleanly. */}
      <svg
        className='absolute inset-0 h-full w-full pointer-events-none'
        preserveAspectRatio='none'
        viewBox='0 0 100 100'
      >
        <defs>
          <mask id={`crop-mask-${nodeId}`}>
            <rect x='0' y='0' width='100' height='100' fill='white' />
            <rect
              x={rect.x * 100}
              y={rect.y * 100}
              width={rect.width * 100}
              height={rect.height * 100}
              fill='black'
            />
          </mask>
        </defs>
        <rect
          x='0'
          y='0'
          width='100'
          height='100'
          fill='black'
          fillOpacity='0.45'
          mask={`url(#crop-mask-${nodeId})`}
        />
      </svg>

      {/* The draggable rect itself. Interior is the move handle; the
          eight smaller squares around it are corner / edge handles. */}
      <div
        className='absolute border-2 border-white shadow-[0_0_0_1px_rgba(0,0,0,0.5)] cursor-move'
        style={rectStyle}
        onMouseDown={handleMouseDown('move')}
      >
        {/* Corner handles — 8 px squares centered on each corner. */}
        <Handle position='nw' onMouseDown={handleMouseDown('nw')} />
        <Handle position='ne' onMouseDown={handleMouseDown('ne')} />
        <Handle position='sw' onMouseDown={handleMouseDown('sw')} />
        <Handle position='se' onMouseDown={handleMouseDown('se')} />
        {/* Edge handles — sit on the midpoint of each side. */}
        <Handle position='n' onMouseDown={handleMouseDown('n')} />
        <Handle position='s' onMouseDown={handleMouseDown('s')} />
        <Handle position='e' onMouseDown={handleMouseDown('e')} />
        <Handle position='w' onMouseDown={handleMouseDown('w')} />
      </div>
    </div>
  );
}

interface HandleProps {
  position: Exclude<DragAnchor, 'move'>;
  onMouseDown: (e: React.MouseEvent) => void;
}

const HANDLE_POSITIONS: Record<HandleProps['position'], string> = {
  nw: 'top-0 left-0 -translate-x-1/2 -translate-y-1/2 cursor-nwse-resize',
  ne: 'top-0 right-0 translate-x-1/2 -translate-y-1/2 cursor-nesw-resize',
  sw: 'bottom-0 left-0 -translate-x-1/2 translate-y-1/2 cursor-nesw-resize',
  se: 'bottom-0 right-0 translate-x-1/2 translate-y-1/2 cursor-nwse-resize',
  n: 'top-0 left-1/2 -translate-x-1/2 -translate-y-1/2 cursor-ns-resize',
  s: 'bottom-0 left-1/2 -translate-x-1/2 translate-y-1/2 cursor-ns-resize',
  e: 'right-0 top-1/2 translate-x-1/2 -translate-y-1/2 cursor-ew-resize',
  w: 'left-0 top-1/2 -translate-x-1/2 -translate-y-1/2 cursor-ew-resize',
};

function Handle({ position, onMouseDown }: HandleProps) {
  return (
    <div
      onMouseDown={onMouseDown}
      className={
        'absolute h-2.5 w-2.5 bg-white border border-black/50 rounded-sm ' +
        HANDLE_POSITIONS[position]
      }
    />
  );
}

/**
 * Compute the next rect given the anchor being dragged and the
 * normalized cursor delta. Exported for unit tests — the math is the
 * subtle part (corners adjust two edges, edge handles adjust one,
 * `move` translates without resize) and is worth verifying without
 * spinning up jsdom + mouse events.
 */
export function applyDrag(start: Rect, anchor: DragAnchor, dx: number, dy: number): Rect {
  if (anchor === 'move') {
    // Translate the whole rect, clamped so it stays inside [0, 1].
    const nx = clamp(start.x + dx, 0, 1 - start.width);
    const ny = clamp(start.y + dy, 0, 1 - start.height);
    return { x: nx, y: ny, width: start.width, height: start.height };
  }

  // For resize anchors, derive the two opposite edges. The fixed edge
  // stays put; the moving edge follows the cursor, then we clamp so:
  //   - moving edge stays inside [0, 1]
  //   - rect width / height stays >= MIN_REL_SIZE
  // and rebuild {x, y, width, height} from the resolved edge positions.
  let left = start.x;
  let right = start.x + start.width;
  let top = start.y;
  let bottom = start.y + start.height;

  if (anchor === 'w' || anchor === 'nw' || anchor === 'sw') {
    left = clamp(start.x + dx, 0, right - MIN_REL_SIZE);
  }
  if (anchor === 'e' || anchor === 'ne' || anchor === 'se') {
    right = clamp(start.x + start.width + dx, left + MIN_REL_SIZE, 1);
  }
  if (anchor === 'n' || anchor === 'nw' || anchor === 'ne') {
    top = clamp(start.y + dy, 0, bottom - MIN_REL_SIZE);
  }
  if (anchor === 's' || anchor === 'sw' || anchor === 'se') {
    bottom = clamp(start.y + start.height + dy, top + MIN_REL_SIZE, 1);
  }

  return {
    x: left,
    y: top,
    width: right - left,
    height: bottom - top,
  };
}
