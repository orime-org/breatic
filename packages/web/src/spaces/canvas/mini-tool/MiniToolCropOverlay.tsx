// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { useStore } from '@xyflow/react';
import * as React from 'react';

import {
  captureResize,
  drawRect,
  moveRect,
  resizeFromCapture,
  type CapturedResize,
  type CropHandle,
  type CropRect as DisplayRect,
  type CropSize,
} from '@web/lib/crop-math';
import { isModelTool, miniToolById } from '@breatic/shared';

import type { CanvasNodeView } from '@web/data/yjs/canvas-space';
import { asContentView } from '@web/data/yjs/node-view';
import { canvasRootOf, useCanvasContext, useCanvasSession } from '@web/spaces/canvas/canvas-context';
import { CROP_HANDLES, cropSourceSelector, intrinsicSize, isCropSource } from '@web/spaces/canvas/focus/crop-source';
import { aspectRatioOf, type CropRect } from '@web/spaces/canvas/mini-tool/mini-tool-view';

interface MiniToolCropOverlayProps {
  /** The node whose picture is cropped. */
  nodeId: string;
  /** Its flow position, a re-measure signal while it is dragged. */
  nodePosition: { x: number; y: number };
  /** The crop in source pixels; null is the whole picture. */
  rect: CropRect | null;
  /** The locked width-to-height ratio, or null when free. */
  ratio: number | null;
  /** Called with the crop in source pixels as it is drawn. */
  onChange: (rect: CropRect) => void;
}

/** An in-progress pointer gesture, in source pixels. */
type Gesture = { pointerId: number } & (
  | { type: 'draw'; anchor: { x: number; y: number } }
  | { type: 'move'; last: { x: number; y: number } }
  | { type: 'resize'; capture: CapturedResize }
);

/**
 * The crop box of the crop tools (inner#888 §7.4), drawn over the node's
 * picture outside the ReactFlow transform as the focus crop is. The box is
 * held in source pixels, so a pan or zoom only moves where it is drawn; the
 * ratio and the typed size are in the panel.
 * @param root0 - Component props.
 * @param root0.nodeId - The node whose picture is cropped.
 * @param root0.nodePosition - Its flow position.
 * @param root0.rect - The crop in source pixels.
 * @param root0.ratio - The locked ratio.
 * @param root0.onChange - Called with the new crop.
 * @returns The overlay.
 */
export function MiniToolCropOverlay({
  nodeId,
  nodePosition,
  rect,
  ratio,
  onChange,
}: MiniToolCropOverlayProps): React.JSX.Element {
  const { spaceId } = useCanvasContext();
  const transform = useStore((s) => s.transform);
  const rootRef = React.useRef<HTMLDivElement>(null);
  const [box, setBox] = React.useState<{ x: number; y: number; width: number; height: number } | null>(null);
  const [natural, setNatural] = React.useState<CropSize | null>(null);
  const gestureRef = React.useRef<Gesture | null>(null);

  const measure = React.useCallback((): void => {
    const root = rootRef.current;
    const el = canvasRootOf(spaceId).querySelector(cropSourceSelector(nodeId));
    if (root === null || !isCropSource(el)) {
      setBox(null);
      return;
    }
    const size = intrinsicSize(el);
    const rootRect = root.getBoundingClientRect();
    const elRect = el.getBoundingClientRect();
    if (size.width === 0 || elRect.width <= 0 || elRect.height <= 0) {
      setBox(null);
      return;
    }
    setNatural((prev) => (prev?.width === size.width && prev.height === size.height ? prev : size));
    setBox({ x: elRect.left - rootRect.left, y: elRect.top - rootRect.top, width: elRect.width, height: elRect.height });
  }, [nodeId, spaceId]);

  React.useLayoutEffect(() => {
    measure();
    window.addEventListener('resize', measure);
    const container = canvasRootOf(spaceId).querySelector(`.react-flow__node[data-id="${CSS.escape(nodeId)}"]`);
    const observer = container ? new MutationObserver(measure) : null;
    if (observer && container) observer.observe(container, { childList: true, subtree: true, attributes: true });
    return () => {
      window.removeEventListener('resize', measure);
      observer?.disconnect();
    };
  }, [measure, transform, nodePosition.x, nodePosition.y, nodeId, spaceId]);

  const whole: DisplayRect | null = natural === null ? null : { x: 0, y: 0, width: natural.width, height: natural.height };
  const current: DisplayRect | null =
    rect === null ? whole : { x: rect.x, y: rect.y, width: rect.w, height: rect.h };

  /**
   * The pointer in source pixels.
   * @param e - The pointer event.
   * @returns The point, clamped by the math that reads it.
   */
  const sourcePoint = (e: React.PointerEvent): { x: number; y: number } => {
    const rootRect = rootRef.current?.getBoundingClientRect();
    if (box === null || natural === null || rootRect === undefined) return { x: 0, y: 0 };
    return {
      x: ((e.clientX - rootRect.left - box.x) * natural.width) / box.width,
      y: ((e.clientY - rootRect.top - box.y) * natural.height) / box.height,
    };
  };

  /**
   * Write a crop in whole source pixels.
   * @param next - The crop as the math left it.
   */
  const commit = (next: DisplayRect): void => {
    const x = Math.round(next.x);
    const y = Math.round(next.y);
    onChange({ x, y, w: Math.max(1, Math.round(next.width)), h: Math.max(1, Math.round(next.height)) });
  };

  /**
   * Start a new box from the picture.
   * @param e - The pointer-down event.
   */
  const onLayerDown = (e: React.PointerEvent): void => {
    if (e.button !== 0 || gestureRef.current || natural === null) return;
    e.currentTarget.setPointerCapture?.(e.pointerId);
    const p = sourcePoint(e);
    gestureRef.current = { type: 'draw', anchor: p, pointerId: e.pointerId };
  };

  /**
   * Start moving the box.
   * @param e - The pointer-down event.
   */
  const onBoxDown = (e: React.PointerEvent): void => {
    if (e.button !== 0 || gestureRef.current) return;
    e.stopPropagation();
    e.currentTarget.setPointerCapture?.(e.pointerId);
    gestureRef.current = { type: 'move', last: sourcePoint(e), pointerId: e.pointerId };
  };

  /**
   * Start resizing from a handle.
   * @param handle - The handle.
   * @returns The pointer-down handler.
   */
  const onHandleDown =
    (handle: CropHandle) =>
      (e: React.PointerEvent): void => {
        if (e.button !== 0 || gestureRef.current || current === null) return;
        e.stopPropagation();
        e.currentTarget.setPointerCapture?.(e.pointerId);
        gestureRef.current = { type: 'resize', capture: captureResize(current, handle), pointerId: e.pointerId };
      };

  /**
   * Follow the pointer with the gesture it started.
   * @param e - The pointer-move event.
   */
  const onMove = (e: React.PointerEvent): void => {
    const gesture = gestureRef.current;
    if (!gesture || e.pointerId !== gesture.pointerId || natural === null) return;
    const p = sourcePoint(e);
    if (gesture.type === 'draw') {
      const drawn = drawRect(gesture.anchor, p, natural, ratio);
      if (drawn.width >= 1 && drawn.height >= 1) commit(drawn);
    } else if (gesture.type === 'move') {
      gestureRef.current = { type: 'move', last: p, pointerId: gesture.pointerId };
      if (current !== null) commit(moveRect(current, p.x - gesture.last.x, p.y - gesture.last.y, natural));
    } else {
      commit(resizeFromCapture(gesture.capture, p, natural, ratio));
    }
  };

  /**
   * End the gesture the pointer started.
   * @param e - The pointer-up or cancel event.
   */
  const onUp = (e: React.PointerEvent): void => {
    if (gestureRef.current?.pointerId === e.pointerId) gestureRef.current = null;
  };

  const shown =
    box === null || natural === null || current === null
      ? null
      : {
        left: (current.x * box.width) / natural.width,
        top: (current.y * box.height) / natural.height,
        width: (current.width * box.width) / natural.width,
        height: (current.height * box.height) / natural.height,
      };

  return (
    <div ref={rootRef} data-testid='mini-tool-crop-overlay' className='pointer-events-none absolute inset-0 z-10'>
      {box === null || shown === null ? null : (
        <div
          data-testid='mini-tool-crop-layer'
          className='pointer-events-auto absolute touch-none cursor-crosshair'
          style={{ left: box.x, top: box.y, width: box.width, height: box.height }}
          onPointerDown={onLayerDown}
          onPointerMove={onMove}
          onPointerUp={onUp}
          onPointerCancel={onUp}
        >
          <div
            data-testid='mini-tool-crop-rect'
            className='absolute cursor-move border border-background outline outline-1 outline-foreground'
            style={{ ...shown, boxShadow: '0 0 0 100000px rgb(0 0 0 / 0.4)' }}
            onPointerDown={onBoxDown}
          >
            {CROP_HANDLES.map(({ id, className }) => (
              <div
                key={id}
                data-testid={`mini-tool-crop-handle-${id}`}
                className={`absolute h-2 w-2 border border-foreground bg-background ${ratio !== null ? 'rounded-full ' : ''}${className}`}
                onPointerDown={onHandleDown(id)}
              />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

interface MiniToolCropOverlayContainerProps {
  nodes: readonly CanvasNodeView[];
}

/**
 * The crop box while a crop tool's panel is open and no pick is running.
 * @param root0 - Component props.
 * @param root0.nodes - The canvas's node views.
 * @returns The overlay, or null when no crop tool is open.
 */
export function MiniToolCropOverlayContainer({ nodes }: MiniToolCropOverlayContainerProps): React.JSX.Element | null {
  const kind = useCanvasSession((s) => s.panelKind);
  const host = useCanvasSession((s) => s.panelHostId);
  const draft = useCanvasSession((s) => s.miniTool);
  const picking = useCanvasSession((s) => s.pickSession !== null);
  const setParam = useCanvasSession((s) => s.setMiniToolParam);
  const spec = draft === null ? undefined : miniToolById(draft.toolId);
  const rectParam =
    spec === undefined || isModelTool(spec) ? undefined : spec.params.find((param) => param.kind === 'rect');
  const node = host === null ? undefined : nodes.find((n) => n.id === host);
  const key = rectParam?.key;
  const onChange = React.useCallback(
    (rect: CropRect): void => {
      if (key !== undefined) setParam(key, rect);
    },
    [key, setParam],
  );
  if (kind !== 'miniTool' || picking || draft === null || rectParam === undefined || node === undefined) return null;
  const view = asContentView(node.data);
  const size =
    view !== undefined && 'width' in view && view.width !== undefined && view.height !== undefined
      ? { width: view.width, height: view.height }
      : null;
  const aspect = rectParam.kind === 'rect' && rectParam.aspect !== undefined ? draft.params[rectParam.aspect] : undefined;
  return (
    <MiniToolCropOverlay
      nodeId={node.id}
      nodePosition={node.position}
      rect={(draft.params[rectParam.key] as CropRect | null | undefined) ?? null}
      ratio={size === null ? null : aspectRatioOf(aspect, size)}
      onChange={onChange}
    />
  );
}
