// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { useStore } from '@xyflow/react';
import * as React from 'react';

import { miniToolById } from '@breatic/shared/mini-tools';

import type { CropHandle } from '@web/lib/crop-math';
import { useCanvasSession, useCanvasSessionStore } from '@web/spaces/canvas/canvas-context';
import { miniToolOpenOn } from '@web/stores/canvas-session';
import { handleScale } from '@web/spaces/canvas/crop/crop-geometry';
import { useMediaGeometry } from '@web/spaces/canvas/crop/media-geometry';
import { CROP_HANDLES } from '@web/spaces/canvas/focus/crop-source';
import {
  isExpanded,
  moveSource,
  resizeFrame,
  type ExpandFrame,
  type ExpandRatio,
} from '@web/spaces/canvas/mini-tool/expand-frame';

interface NodeExpandLayerProps {
  /** The node this layer belongs to. */
  nodeId: string;
  /** The node's outer positioned wrapper; see `NodeCropLayer`. */
  wrapper: HTMLElement | null;
}

/** An in-progress drag, with the frame and ratio as they stood when it began. */
type Gesture = { pointerId: number; frame: ExpandFrame; ratio: ExpandRatio } & (
  | { type: 'resize'; handle: CropHandle }
  | { type: 'move'; start: { x: number; y: number } }
);

/**
 * The expand tool's frame on the node (inner#1303 §6.3). The frame stays put
 * on the canvas: its handles grow it past the picture, and once it is grown
 * the picture can be dragged inside it, shown as a copy over the frame's fill
 * so the card's clip does not cut it. A drag ends on release, on cancel, or
 * when the frame is written by anyone else (a ratio preset, a reset).
 * @param root0 - Component props.
 * @param root0.nodeId - The node.
 * @param root0.wrapper - The node's outer wrapper.
 * @returns The layer, or null when no expand tool is open on this node.
 */
export function NodeExpandLayer({ nodeId, wrapper }: NodeExpandLayerProps): React.JSX.Element | null {
  const store = useCanvasSessionStore();
  const draft = useCanvasSession(miniToolOpenOn(nodeId));
  const expand = draft !== null && miniToolById(draft.toolId)?.expand !== undefined ? draft.expand : null;
  const sourceSize = draft?.sourceSize ?? null;
  const geometry = useMediaGeometry(wrapper, expand !== null);
  const zoom = useStore((s) => s.transform[2]);
  // How far the picture has been moved since the panel opened, in shares of
  // it: the frame keeps its place on the canvas and the picture moves.
  const [shift, setShift] = React.useState({ x: 0, y: 0 });
  const gesture = React.useRef<Gesture | null>(null);
  // A frame written by anyone but this drag ends the drag.
  const ours = React.useRef<{ frame: ExpandFrame; ratio: ExpandRatio } | null>(null);
  if (gesture.current !== null && expand !== null && ours.current !== null) {
    const same =
      expand.ratio === ours.current.ratio && JSON.stringify(expand.frame) === JSON.stringify(ours.current.frame);
    if (!same) gesture.current = null;
  }
  // A new opening of the panel, or a new picture, starts over the node.
  const sourceContent = draft?.sourceContent;
  const opening = useCanvasSession((s) => s.panelSession);
  React.useEffect(() => setShift({ x: 0, y: 0 }), [sourceContent, opening]);
  // The frame as this layer last saw it. A frame written by anyone but a drag
  // here (a ratio preset, a reset) wraps the picture where the node shows it,
  // so the picture goes back there.
  const known = React.useRef<string | null>(null);
  const frameKey = expand === null ? null : JSON.stringify(expand.frame);
  React.useLayoutEffect(() => {
    if (frameKey === null) return;
    if (known.current !== null && known.current !== frameKey) setShift({ x: 0, y: 0 });
    known.current = frameKey;
  }, [frameKey]);

  // How far the frame's bottom edge reaches below the node, for the panel.
  const bottomShare = expand === null ? null : expand.frame.y + shift.y + expand.frame.height;
  const heldDrop = expand?.drop;
  React.useLayoutEffect(() => {
    if (bottomShare === null || geometry === null || wrapper === null) return;
    // In screen pixels, the unit the panel's offset takes.
    const drop = Math.max(0, geometry.at.y + bottomShare * geometry.box.height - wrapper.offsetHeight) * zoom;
    if (Math.abs(drop - (heldDrop ?? 0)) > 0.5) store.getState().setExpandDrop(drop);
  }, [bottomShare, geometry, wrapper, heldDrop, zoom, store]);

  if (expand === null || geometry === null || sourceSize === null || draft === null) return null;
  const { frame, ratio } = expand;
  const { box, at } = geometry;
  const cap = expand.cap ?? Infinity;
  const exporting = draft.exporting;

  /**
   * A screen point as shares of the picture where it is drawn now.
   * @param clientX - The pointer's x.
   * @param clientY - The pointer's y.
   * @returns The point.
   */
  const toShare = (clientX: number, clientY: number): { x: number; y: number } => {
    const shown = geometry.el.getBoundingClientRect();
    return { x: (clientX - shown.left) / shown.width - shift.x, y: (clientY - shown.top) / shown.height - shift.y };
  };

  /**
   * Write the frame and remember it as this drag's own.
   * @param next - The frame.
   */
  const write = (next: ExpandFrame): void => {
    ours.current = { frame: next, ratio };
    known.current = JSON.stringify(next);
    store.getState().setExpand({ frame: next, ratio });
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
      write(resizeFrame(held.frame, held.handle, toShare(e.clientX, e.clientY), held.ratio, sourceSize, cap));
      return;
    }
    const shown = geometry.el.getBoundingClientRect();
    const delta = { x: (e.clientX - held.start.x) / shown.width, y: (e.clientY - held.start.y) / shown.height };
    const next = moveSource(held.frame, delta);
    setShift((was) => ({ x: was.x + (frame.x - next.x), y: was.y + (frame.y - next.y) }));
    write(next);
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
    <>
      {/* The node's own picture stays put while its copy moves in the frame. */}
      <div
        data-testid='mini-tool-expand-cover'
        className='pointer-events-none absolute bg-muted'
        style={{ left: at.x, top: at.y, width: box.width, height: box.height }}
      />
      <div
        data-testid='mini-tool-expand-frame'
        className='nodrag nopan absolute touch-none border-solid border-background bg-muted outline outline-foreground'
        style={{
          left: at.x + (frame.x + shift.x) * box.width,
          top: at.y + (frame.y + shift.y) * box.height,
          width: frame.width * box.width,
          height: frame.height * box.height,
          borderWidth: scale,
          outlineWidth: scale,
        }}
        onPointerMove={onMove}
        onPointerUp={onUp}
        onPointerCancel={onUp}
      >
        {geometry.src === null ? null : (
          <img
            data-testid='mini-tool-expand-source'
            src={geometry.src}
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
    </>
  );
}
