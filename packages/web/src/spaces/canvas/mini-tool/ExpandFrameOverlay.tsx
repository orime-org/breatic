// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { useInternalNode, useReactFlow, useStore } from '@xyflow/react';
import * as React from 'react';

import { miniToolById } from '@breatic/shared/mini-tools';

import type { CropHandle } from '@web/lib/crop-math';
import { useCanvasSession, useCanvasSessionStore } from '@web/spaces/canvas/canvas-context';
import { miniToolOpenOn } from '@web/stores/canvas-session';
import { handleScale } from '@web/spaces/canvas/crop/crop-geometry';
import { CROP_HANDLES } from '@web/spaces/canvas/focus/crop-source';
import { TOOL_LAYER_CLASS, stopNodeClick } from '@web/spaces/canvas/mini-tool/tool-layer-input';
import {
  isExpanded,
  moveSource,
  resizeFrame,
  type ExpandFrame,
  type ExpandRatio,
} from '@web/spaces/canvas/mini-tool/expand-frame';

/** An in-progress drag, with the frame and ratio as they stood when it began. */
type Gesture = { pointerId: number; frame: ExpandFrame; ratio: ExpandRatio } & (
  | { type: 'resize'; handle: CropHandle }
  | { type: 'move'; start: { x: number; y: number } }
);

/**
 * The expand tool's frame (inner#1303 §6.3), drawn in the canvas's viewport
 * rather than in the node: the frame reaches well past the node, and the
 * canvas unmounts a node whose own box is off screen, so a frame drawn in it
 * would vanish while its visible part is still on screen. It is placed from
 * the node's position and where the node last showed the picture.
 *
 * The frame stays put on the canvas: its handles grow it past the picture, and
 * once it is grown the picture can be dragged inside it, shown as a copy over
 * the frame's fill so the card's clip does not cut it. A drag ends on release,
 * on cancel, or when the frame is written by anyone else (a ratio preset, a
 * reset). Rendered inside a `ViewportPortal`.
 * @returns The frame, or null when no expand tool is open.
 */
export function ExpandFrameOverlay(): React.JSX.Element | null {
  const store = useCanvasSessionStore();
  const hostId = useCanvasSession((s) => s.panelHostId);
  const draft = useCanvasSession(miniToolOpenOn(hostId));
  const expand = draft !== null && miniToolById(draft.toolId)?.expand !== undefined ? draft.expand : null;
  // Read only while the frame shows, so a zoom does not re-render it otherwise.
  const zoom = useStore((s) => (expand === null ? 1 : s.transform[2]));
  const node = useInternalNode(hostId ?? '');
  const { screenToFlowPosition } = useReactFlow();
  const gesture = React.useRef<Gesture | null>(null);
  // A frame written by anyone but this drag ends the drag.
  const ours = React.useRef<{ frame: ExpandFrame; ratio: ExpandRatio } | null>(null);
  if (gesture.current !== null && expand !== null && ours.current !== null) {
    const same =
      expand.ratio === ours.current.ratio && JSON.stringify(expand.frame) === JSON.stringify(ours.current.frame);
    if (!same) gesture.current = null;
  }

  const sourceSize = draft?.sourceSize ?? null;
  const view = expand?.view ?? null;
  if (expand === null || view === null || sourceSize === null || draft === null || node === undefined) return null;
  const { frame, ratio, shift } = expand;
  const { box } = view;
  // The picture's corner on the canvas: the node's place plus where it shows it.
  const origin = {
    x: node.internals.positionAbsolute.x + view.at.x,
    y: node.internals.positionAbsolute.y + view.at.y,
  };
  const cap = expand.cap ?? Infinity;
  const exporting = draft.exporting;

  /**
   * A screen point as shares of the picture where its copy is drawn now.
   * @param clientX - The pointer's x.
   * @param clientY - The pointer's y.
   * @returns The point.
   */
  const toShare = (clientX: number, clientY: number): { x: number; y: number } => {
    const at = screenToFlowPosition({ x: clientX, y: clientY });
    return { x: (at.x - origin.x) / box.width - shift.x, y: (at.y - origin.y) / box.height - shift.y };
  };

  /**
   * Write the frame and remember it as this drag's own.
   * @param next - The frame.
   * @param nextShift - How far the picture has moved.
   * @param nextShift.x - Across, as a share of it.
   * @param nextShift.y - Down, as a share of it.
   */
  const write = (next: ExpandFrame, nextShift: { x: number; y: number }): void => {
    ours.current = { frame: next, ratio };
    store.getState().setExpand({ frame: next, ratio, shift: nextShift });
  };

  /**
   * Begin a drag.
   * @param e - The pointer-down event.
   * @param start - What the drag does.
   */
  const begin = (
    e: React.PointerEvent,
    start: { type: 'resize'; handle: CropHandle } | { type: 'move'; start: { x: number; y: number } },
  ): void => {
    if (e.button !== 0 || gesture.current !== null || exporting) return;
    e.stopPropagation();
    e.currentTarget.setPointerCapture?.(e.pointerId);
    ours.current = { frame, ratio };
    gesture.current = { pointerId: e.pointerId, frame, ratio, ...start };
  };

  /**
   * Follow the pointer with the drag it began.
   * @param e - The pointer-move event.
   */
  const onMove = (e: React.PointerEvent): void => {
    const held = gesture.current;
    if (held === null || e.pointerId !== held.pointerId) return;
    if (held.type === 'resize') {
      write(resizeFrame(held.frame, held.handle, toShare(e.clientX, e.clientY), held.ratio, sourceSize, cap), shift);
      return;
    }
    const delta = {
      x: (e.clientX - held.start.x) / (box.width * zoom),
      y: (e.clientY - held.start.y) / (box.height * zoom),
    };
    const next = moveSource(held.frame, delta);
    write(next, { x: shift.x + (frame.x - next.x), y: shift.y + (frame.y - next.y) });
  };

  /**
   * End the drag its own pointer began.
   * @param e - The pointer-up or cancel event.
   */
  const onUp = (e: React.PointerEvent): void => {
    if (gesture.current !== null && e.pointerId === gesture.current.pointerId) gesture.current = null;
  };

  const scale = handleScale(zoom);
  const grown = isExpanded(frame, sourceSize);
  return (
    // eslint-disable-next-line jsx-a11y/click-events-have-key-events, jsx-a11y/no-static-element-interactions -- the click is only kept from the canvas
    <div
      data-testid='mini-tool-expand-frame'
      // `pointer-events-auto` because the viewport hands pointer events back per node only.
      className={`${TOOL_LAYER_CLASS} pointer-events-auto absolute touch-none border-solid border-background bg-muted outline outline-foreground`}
      onClick={stopNodeClick}
      style={{
        left: origin.x + (frame.x + shift.x) * box.width,
        top: origin.y + (frame.y + shift.y) * box.height,
        width: frame.width * box.width,
        height: frame.height * box.height,
        borderWidth: scale,
        outlineWidth: scale,
      }}
      onPointerMove={onMove}
      onPointerUp={onUp}
      onPointerCancel={onUp}
    >
      {view.src === null ? null : (
        <img
          data-testid='mini-tool-expand-source'
          src={view.src}
          alt=''
          draggable={false}
          className={`absolute select-none ${grown && !exporting ? 'cursor-move' : ''}`}
          style={{ left: -frame.x * box.width, top: -frame.y * box.height, width: box.width, height: box.height }}
          onPointerDown={(e) => {
            if (grown) begin(e, { type: 'move', start: { x: e.clientX, y: e.clientY } });
          }}
        />
      )}
      {CROP_HANDLES.map(({ id, className }) => (
        <div
          key={id}
          data-testid={`mini-tool-expand-handle-${id}`}
          // Round while the frame is free, square while a ratio holds it.
          className={`absolute h-2 w-2 border border-foreground bg-background ${ratio === 'free' ? 'rounded-full ' : ''}${className}`}
          style={{ scale: String(scale) }}
          onPointerDown={(e) => begin(e, { type: 'resize', handle: id })}
        />
      ))}
    </div>
  );
}
