// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { useQuery } from '@tanstack/react-query';
import { useInternalNode, useReactFlow, useStore, type Node } from '@xyflow/react';
import * as React from 'react';

import { catalogEntryOf, isModelTool, miniToolById } from '@breatic/shared/mini-tools';

import type { CropHandle } from '@web/lib/crop-math';
import { useCanvasSession, useCanvasSessionStore } from '@web/spaces/canvas/canvas-context';
import { modelCatalogQuery } from '@web/spaces/canvas/generate/model-catalog-query';
import { expandCapOf } from '@web/spaces/canvas/mini-tool/mini-tool-view';
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

/**
 * An in-progress drag, with the frame and ratio as they stood when it began
 * and the frame it last wrote: a frame written by anyone else ends the drag.
 */
type Gesture = { pointerId: number; frame: ExpandFrame; ratio: ExpandRatio; last: ExpandFrame } & (
  | { type: 'resize'; handle: CropHandle }
  | { type: 'move'; start: { x: number; y: number } }
);

interface ExpandFrameOverlayProps {
  /** The canvas's node menu, which a right-click on the frame opens for the host. */
  onNodeContextMenu: (event: React.MouseEvent, node: Node) => void;
}

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
 * reset). Pointers are read in canvas pixels, without the grid nodes snap to,
 * so a zoom mid-drag keeps the grabbed point under the pointer. A right-click
 * opens the host's menu, as it does on the node. Rendered inside a
 * `ViewportPortal`.
 * @param root0 - Component props.
 * @param root0.onNodeContextMenu - The canvas's node menu.
 * @returns The frame, or null when no expand tool is open.
 */
export function ExpandFrameOverlay({ onNodeContextMenu }: ExpandFrameOverlayProps): React.JSX.Element | null {
  const store = useCanvasSessionStore();
  const hostId = useCanvasSession((s) => s.panelHostId);
  const draft = useCanvasSession(miniToolOpenOn(hostId));
  const expand = draft?.expand ?? null;
  // Read only while the frame shows, so a zoom does not re-render it otherwise.
  const zoom = useStore((s) => (expand === null ? 1 : s.transform[2]));
  const node = useInternalNode(hostId ?? '');
  const { screenToFlowPosition } = useReactFlow();
  const gesture = React.useRef<Gesture | null>(null);
  const sourceSize = draft?.sourceSize ?? null;
  const view = expand?.view ?? null;
  // The handles stop at the pinned model's longest side, read off its catalog.
  const { data: catalog } = useQuery(modelCatalogQuery());
  const spec = draft === null ? undefined : miniToolById(draft.toolId);
  const entry =
    catalog !== undefined && spec !== undefined && isModelTool(spec) ? catalogEntryOf(catalog, spec.run.model) : undefined;
  const cap = entry === undefined ? null : expandCapOf(entry);
  const drawn =
    expand !== null && view !== null && sourceSize !== null && cap !== null && draft !== null && node !== undefined;
  // A frame not drawn holds no handle to release a drag on: a panel closed
  // under it, a host gone, a source reset. A new opening starts with no view
  // and no source size, so it ends a drag begun in the one before. Nor is it
  // drawn before the model's catalog gives the long-side cap the handles stop at.
  if (
    gesture.current !== null &&
    (!drawn ||
      expand.ratio !== gesture.current.ratio ||
      JSON.stringify(expand.frame) !== JSON.stringify(gesture.current.last))
  ) {
    gesture.current = null;
  }
  if (!drawn) return null;
  const { frame, ratio, shift } = expand;
  const { box } = view;
  // The picture's corner on the canvas: the node's place plus where it shows it.
  const origin = {
    x: node.internals.positionAbsolute.x + view.at.x,
    y: node.internals.positionAbsolute.y + view.at.y,
  };
  const exporting = draft.exporting;

  /**
   * A screen point on the canvas, off the grid nodes snap to.
   * @param e - The pointer event.
   * @returns The point in canvas pixels.
   */
  const onCanvas = (e: React.PointerEvent): { x: number; y: number } =>
    screenToFlowPosition({ x: e.clientX, y: e.clientY }, { snapToGrid: false });

  /**
   * A canvas point as shares of the picture where its copy is drawn now.
   * @param at - The point in canvas pixels.
   * @param at.x - Across.
   * @param at.y - Down.
   * @returns The point.
   */
  const toShare = (at: { x: number; y: number }): { x: number; y: number } => ({
    x: (at.x - origin.x) / box.width - shift.x,
    y: (at.y - origin.y) / box.height - shift.y,
  });

  /**
   * Write the frame and remember it as this drag's own.
   * @param next - The frame.
   * @param nextShift - How far the picture has moved.
   * @param nextShift.x - Across, as a share of it.
   * @param nextShift.y - Down, as a share of it.
   */
  const write = (next: ExpandFrame, nextShift: { x: number; y: number }): void => {
    if (gesture.current !== null) gesture.current.last = next;
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
    gesture.current = { pointerId: e.pointerId, frame, ratio, last: frame, ...start };
  };

  /**
   * Follow the pointer with the drag it began.
   * @param e - The pointer-move event.
   */
  const onMove = (e: React.PointerEvent): void => {
    const held = gesture.current;
    if (held === null || e.pointerId !== held.pointerId) return;
    if (held.type === 'resize') {
      write(resizeFrame(held.frame, held.handle, toShare(onCanvas(e)), held.ratio, sourceSize, cap), shift);
      return;
    }
    const at = onCanvas(e);
    const delta = { x: (at.x - held.start.x) / box.width, y: (at.y - held.start.y) / box.height };
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
      onContextMenu={(e) => {
        e.stopPropagation();
        onNodeContextMenu(e, node.internals.userNode);
      }}
    >
      {view.src === null ? null : (
        <img
          data-testid='mini-tool-expand-source'
          src={view.src}
          alt=''
          draggable={false}
          className={`absolute select-none ${grown && !exporting ? 'cursor-move' : ''}`}
          // Placed from inside the frame's border, so the border is taken off
          // to keep the copy at the picture's own place.
          style={{
            left: -frame.x * box.width - scale,
            top: -frame.y * box.height - scale,
            width: box.width,
            height: box.height,
          }}
          onPointerDown={(e) => {
            if (grown) begin(e, { type: 'move', start: onCanvas(e) });
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
