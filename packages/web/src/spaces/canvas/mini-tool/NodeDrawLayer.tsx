// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { useStoreApi } from '@xyflow/react';
import * as React from 'react';

import { miniToolById } from '@breatic/shared/mini-tools';

import { useCanvasSession, useCanvasSessionStore } from '@web/spaces/canvas/canvas-context';
import { useMediaGeometry, type MediaGeometry } from '@web/spaces/canvas/crop/media-geometry';
import { paintDrawing, type DrawingKind, type PaintSize } from '@web/spaces/canvas/mini-tool/paint-drawing';
import { visibleOps, type DrawingDraft, type DrawOp } from '@web/stores/drawing-draft';

interface NodeDrawLayerProps {
  /** The node this layer belongs to. */
  nodeId: string;
  /** The node's outer positioned wrapper; see `NodeCropLayer`. */
  wrapper: HTMLElement | null;
}

/**
 * The drawing of a mask or sketch tool, laid over the node's picture while
 * that tool's panel is open on it (inner#1302 §6.2).
 * @param root0 - Component props.
 * @param root0.nodeId - The node.
 * @param root0.wrapper - The node's outer wrapper.
 * @returns The layer, or null when this node is not being drawn on.
 */
export function NodeDrawLayer({ nodeId, wrapper }: NodeDrawLayerProps): React.JSX.Element | null {
  const draft = useCanvasSession((s) =>
    s.panelKind === 'miniTool' && s.panelHostId === nodeId && s.pickSession === null ? s.miniTool : null,
  );
  const kind = draft === null ? undefined : miniToolById(draft.toolId)?.drawing?.kind;
  const drawing = kind === undefined ? null : (draft?.drawing ?? null);
  const geometry = useMediaGeometry(wrapper, drawing !== null);
  if (kind === undefined || drawing === null || geometry === null || draft === null) return null;
  return (
    <DrawSurface
      // A different picture under the same node starts a fresh layer.
      key={geometry.src ?? ''}
      kind={kind}
      drawing={drawing}
      exporting={draft.exporting}
      geometry={geometry}
    />
  );
}

interface DrawSurfaceProps {
  kind: DrawingKind;
  drawing: DrawingDraft;
  exporting: boolean;
  geometry: MediaGeometry;
}

/**
 * The colour a mask is shown in, read off the theme each time it is painted.
 * @param el - An element under the theme.
 * @param drawing - The drawing.
 * @returns The CSS colour.
 */
function maskColorOf(el: Element, drawing: DrawingDraft): string {
  return getComputedStyle(el).getPropertyValue(`--color-palette-${drawing.maskColor}`).trim();
}

/**
 * Clear a canvas and paint ops on it.
 * @param canvas - The canvas.
 * @param ops - The ops.
 * @param kind - Mask or sketch.
 * @param drawing - The drawing, for the mask colour.
 */
function repaint(canvas: HTMLCanvasElement | null, ops: readonly DrawOp[], kind: DrawingKind, drawing: DrawingDraft): void {
  const ctx = canvas?.getContext('2d') ?? null;
  if (canvas === null || ctx === null) return;
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  const size: PaintSize = { width: canvas.width, height: canvas.height };
  paintDrawing(ctx, ops, size, kind, kind === 'mask' ? maskColorOf(canvas, drawing) : '');
}

/**
 * The two canvases and the pointer handling. The lower one holds the
 * committed steps and is repainted only when they, the colour or the settled
 * zoom change; the upper one holds the stroke under way.
 * @param root0 - Component props.
 * @param root0.kind - Mask or sketch.
 * @param root0.drawing - The drawing in the draft.
 * @param root0.exporting - Whether the run is exporting.
 * @param root0.geometry - The media's place in the node.
 * @returns The layer.
 */
function DrawSurface({ kind, drawing, exporting, geometry }: DrawSurfaceProps): React.JSX.Element {
  const store = useCanvasSessionStore();
  const flow = useStoreApi();
  const settledZoom = useCanvasSession((s) => s.settledZoom);
  const [mountZoom] = React.useState(() => flow.getState().transform[2]);
  const zoom = settledZoom ?? mountZoom;
  const committed = React.useRef<HTMLCanvasElement>(null);
  const pending = React.useRef<HTMLCanvasElement>(null);
  const ring = React.useRef<HTMLDivElement>(null);
  const gesture = React.useRef<DrawOp | null>(null);
  // Where a shape's drag started; the shape is kept with its corner at the top left.
  const anchor = React.useRef<[number, number]>([0, 0]);

  const { box, natural } = geometry;
  // Pixels enough for the zoom it is seen at, never more than the picture has.
  const dpr = window.devicePixelRatio || 1;
  const scale = Math.min(dpr * zoom, natural === null ? Infinity : (dpr * natural.width) / box.width);
  const bitmap = { width: Math.max(1, Math.round(box.width * scale)), height: Math.max(1, Math.round(box.height * scale)) };
  const ops = React.useMemo(() => visibleOps(drawing.steps), [drawing.steps]);

  React.useLayoutEffect(() => {
    repaint(committed.current, ops, kind, drawing);
  }, [ops, kind, drawing, bitmap.width, bitmap.height]);

  /**
   * Paint the stroke under way; an eraser shows on the committed layer.
   * @param op - The stroke.
   */
  const paintPending = (op: DrawOp | null): void => {
    const erasing = op?.kind === 'stroke' && op.erase;
    repaint(committed.current, erasing ? [...ops, op] : ops, kind, drawing);
    repaint(pending.current, op === null || erasing ? [] : [op], kind, drawing);
  };

  /**
   * A pointer as fractions of the picture.
   * @param e - The pointer event.
   * @returns The point.
   */
  const toFraction = (e: React.PointerEvent): [number, number] => {
    const shown = geometry.el.getBoundingClientRect();
    return [(e.clientX - shown.left) / shown.width, (e.clientY - shown.top) / shown.height];
  };

  /**
   * Keep the brush ring under the pointer, in layout pixels.
   * @param e - The pointer event.
   */
  const moveRing = (e: React.PointerEvent): void => {
    const el = ring.current;
    if (el === null) return;
    const [fx, fy] = toFraction(e);
    el.style.transform = `translate(${fx * box.width}px, ${fy * box.height}px) translate(-50%, -50%)`;
    el.style.visibility = 'visible';
  };

  /**
   * Start a stroke or a shape on a left press.
   * @param e - The pointer event.
   */
  const onDown = (e: React.PointerEvent<HTMLDivElement>): void => {
    if (e.button !== 0 || gesture.current !== null) return;
    e.currentTarget.setPointerCapture?.(e.pointerId);
    const [x, y] = toFraction(e);
    anchor.current = [x, y];
    const { size, color, tool } = drawing;
    gesture.current =
      tool === 'brush' || tool === 'eraser'
        ? { kind: 'stroke', erase: tool === 'eraser', size, color, points: [[x, y]] }
        : { kind: tool, size, color, x, y, w: 0, h: 0 };
    paintPending(gesture.current);
  };

  /**
   * Move the ring, and extend the stroke or reshape the shape under way.
   * @param e - The pointer event.
   */
  const onMove = (e: React.PointerEvent<HTMLDivElement>): void => {
    moveRing(e);
    const op = gesture.current;
    if (op === null) return;
    const [x, y] = toFraction(e);
    const [ax, ay] = anchor.current;
    gesture.current =
      op.kind === 'stroke'
        ? { ...op, points: [...op.points, [x, y]] }
        : { ...op, x: Math.min(ax, x), y: Math.min(ay, y), w: Math.abs(x - ax), h: Math.abs(y - ay) };
    paintPending(gesture.current);
  };

  /** Write the stroke or shape as one step; a shape that was only clicked writes nothing. */
  const onUp = (): void => {
    const op = gesture.current;
    gesture.current = null;
    paintPending(null);
    if (op === null || (op.kind !== 'stroke' && (op.w === 0 || op.h === 0))) return;
    store.getState().addDrawingStep(op);
  };

  /** Drop the stroke under way. */
  const onCancel = (): void => {
    gesture.current = null;
    paintPending(null);
  };

  /** Hide the ring once the pointer leaves the picture. */
  const onLeave = (): void => {
    if (ring.current !== null) ring.current.style.visibility = 'hidden';
  };

  const strokes = drawing.tool === 'brush' || drawing.tool === 'eraser';
  const place = { left: geometry.at.x, top: geometry.at.y, width: box.width, height: box.height };
  const ringSize = (drawing.size / 100) * Math.min(box.width, box.height);
  return (
    <div
      data-testid='mini-tool-draw-layer'
      className={`nodrag nopan absolute touch-none ${strokes ? 'cursor-none' : 'cursor-crosshair'}${exporting ? ' pointer-events-none' : ''}`}
      style={place}
      onPointerDown={onDown}
      onPointerMove={onMove}
      onPointerUp={onUp}
      onPointerCancel={onCancel}
      onPointerLeave={onLeave}
    >
      <div className='absolute inset-0' style={kind === 'mask' ? { opacity: 0.5 } : undefined}>
        <canvas ref={committed} width={bitmap.width} height={bitmap.height} className='absolute inset-0 h-full w-full' />
        <canvas ref={pending} width={bitmap.width} height={bitmap.height} className='absolute inset-0 h-full w-full' />
      </div>
      {strokes ? (
        <div
          ref={ring}
          aria-hidden='true'
          className='pointer-events-none absolute left-0 top-0 rounded-full border border-background outline outline-foreground'
          style={{ width: ringSize, height: ringSize, visibility: 'hidden' }}
        />
      ) : null}
    </div>
  );
}
