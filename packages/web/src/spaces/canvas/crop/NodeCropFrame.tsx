// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import * as React from 'react';

import {
  captureResize,
  drawRect,
  isCropUsable,
  moveRect,
  resizeFromCapture,
  type CapturedResize,
  type CropHandle,
  type CropRect,
  type CropSize,
} from '@web/lib/crop-math';
import { handleScale, type BoxSize } from '@web/spaces/canvas/crop/crop-geometry';
import { CROP_HANDLES } from '@web/spaces/canvas/focus/crop-source';

/** An in-progress pointer gesture, in box pixels. */
type Gesture = { pointerId: number } & (
  | { type: 'draw'; anchor: { x: number; y: number } }
  | { type: 'move'; last: { x: number; y: number } }
  | { type: 'resize'; capture: CapturedResize }
);

interface NodeCropFrameProps {
  /** Prefix of every test id, one per crop kind. */
  testIdPrefix: string;
  /** Where the shown media sits inside the node's outer wrapper. */
  at: { x: number; y: number };
  /** The shown media's size in the node's layout pixels. */
  box: BoxSize;
  /** The marquee in box pixels, or null when there is none. */
  rect: CropRect | null;
  /** The width-to-height ratio a gesture holds to, or null when free. */
  ratio: number | null;
  /** The material's own size, for the gauge a released gesture must pass. */
  natural: CropSize | null;
  /** The canvas zoom, which the handles cancel. */
  zoom: number;
  /**
   * A pointer position in box pixels.
   * @param clientX - The pointer's viewport x.
   * @param clientY - The pointer's viewport y.
   */
  toBoxPoint: (clientX: number, clientY: number) => { x: number; y: number };
  /** Called with the marquee as a gesture shapes it, null to drop it. */
  onChange: (rect: CropRect | null) => void;
}

/** How far apart two box-pixel values may be and still be the same write. */
const SAME_WRITE = 1e-6;

/**
 * Whether two marquees are the same within the round-trip through fractions.
 * @param a - One marquee.
 * @param b - The other.
 * @returns True when they describe the same rect.
 */
function sameRect(a: CropRect | null, b: CropRect | null): boolean {
  if (a === null || b === null) return a === b;
  return (
    Math.abs(a.x - b.x) < SAME_WRITE &&
    Math.abs(a.y - b.y) < SAME_WRITE &&
    Math.abs(a.width - b.width) < SAME_WRITE &&
    Math.abs(a.height - b.height) < SAME_WRITE
  );
}

/**
 * The crop box drawn inside a node over its picture (inner#888 §7.4.1),
 * shared by the focus crop and the mini-tool crop. It lives in the node's
 * layout pixels, so a pan or zoom moves it with the node; the handles cancel
 * the zoom so they stay draggable. A gesture ends on release, on cancel, when
 * the marquee is written by anyone else (Esc, Cancel, a ratio item, a reset),
 * or when this box goes away mid-drag — and a gesture that ends any of those
 * ways on its own leaves no marquee Confirm could not accept.
 * @param root0 - Component props.
 * @param root0.testIdPrefix - Prefix of every test id.
 * @param root0.at - Where the media sits inside the wrapper.
 * @param root0.box - The media's layout size.
 * @param root0.rect - The marquee in box pixels.
 * @param root0.ratio - The ratio a gesture holds to.
 * @param root0.natural - The material's own size.
 * @param root0.zoom - The canvas zoom.
 * @param root0.toBoxPoint - Maps a pointer into box pixels.
 * @param root0.onChange - Receives the marquee a gesture shapes.
 * @returns The box.
 */
export function NodeCropFrame({
  testIdPrefix,
  at,
  box,
  rect,
  ratio,
  natural,
  zoom,
  toBoxPoint,
  onChange,
}: NodeCropFrameProps): React.JSX.Element {
  const gestureRef = React.useRef<Gesture | null>(null);
  // What this box last wrote. A marquee arriving that differs from it was
  // written by someone else, which ends the gesture: without that, the next
  // move of a still-held pointer redraws a marquee Esc or Cancel just cleared.
  const wroteRef = React.useRef<CropRect | null>(rect);
  if (!sameRect(rect, wroteRef.current)) {
    gestureRef.current = null;
    wroteRef.current = rect;
  }
  const rectRef = React.useRef(rect);
  rectRef.current = rect;
  const gaugeRef = React.useRef({ box, natural, onChange });
  gaugeRef.current = { box, natural, onChange };

  /**
   * Write a marquee and remember it as this box's own.
   * @param next - The marquee, or null.
   */
  const write = (next: CropRect | null): void => {
    wroteRef.current = next;
    onChange(next);
  };

  // A gesture cut off by this box going away (the node scrolled out of view
  // and was culled mid-drag) gets the same gauge a release does.
  React.useEffect(
    () => () => {
      if (gestureRef.current === null) return;
      gestureRef.current = null;
      const held = rectRef.current;
      const gauge = gaugeRef.current;
      if (held !== null && !isCropUsable(held, gauge.box, gauge.natural)) gauge.onChange(null);
    },
    [],
  );

  /**
   * Start a new marquee from the bare picture.
   * @param e - The pointer-down event.
   */
  const onLayerDown = (e: React.PointerEvent): void => {
    if (e.button !== 0 || gestureRef.current !== null) return;
    e.currentTarget.setPointerCapture?.(e.pointerId);
    const p = toBoxPoint(e.clientX, e.clientY);
    gestureRef.current = { type: 'draw', anchor: p, pointerId: e.pointerId };
    write(drawRect(p, p, box, ratio));
  };

  /**
   * Start moving the marquee.
   * @param e - The pointer-down event.
   */
  const onRectDown = (e: React.PointerEvent): void => {
    if (e.button !== 0 || gestureRef.current !== null) return;
    e.stopPropagation();
    e.currentTarget.setPointerCapture?.(e.pointerId);
    gestureRef.current = { type: 'move', last: toBoxPoint(e.clientX, e.clientY), pointerId: e.pointerId };
  };

  /**
   * Start resizing from a handle. The anchor is frozen now: re-deriving it
   * from the changing marquee on every move loses it once the pointer crosses.
   * @param handle - The handle.
   * @returns The pointer-down handler.
   */
  const onHandleDown =
    (handle: CropHandle) =>
      (e: React.PointerEvent): void => {
        if (e.button !== 0 || gestureRef.current !== null || rect === null) return;
        e.stopPropagation();
        e.currentTarget.setPointerCapture?.(e.pointerId);
        gestureRef.current = { type: 'resize', capture: captureResize(rect, handle), pointerId: e.pointerId };
      };

  /**
   * Follow the pointer with the gesture it started.
   * @param e - The pointer-move event.
   */
  const onMove = (e: React.PointerEvent): void => {
    const gesture = gestureRef.current;
    if (gesture === null || e.pointerId !== gesture.pointerId) return;
    const p = toBoxPoint(e.clientX, e.clientY);
    if (gesture.type === 'draw') {
      write(drawRect(gesture.anchor, p, box, ratio));
    } else if (gesture.type === 'move') {
      gestureRef.current = { type: 'move', last: p, pointerId: gesture.pointerId };
      if (rect !== null) write(moveRect(rect, p.x - gesture.last.x, p.y - gesture.last.y, box));
    } else {
      write(resizeFromCapture(gesture.capture, p, box, ratio));
    }
  };

  /**
   * End the gesture its own pointer started; no gesture ends on a marquee
   * Confirm would refuse.
   * @param e - The pointer-up or cancel event.
   */
  const onUp = (e: React.PointerEvent): void => {
    const gesture = gestureRef.current;
    if (gesture !== null && e.pointerId !== gesture.pointerId) return;
    gestureRef.current = null;
    if (gesture !== null && rect !== null && !isCropUsable(rect, box, natural)) write(null);
  };

  const scale = handleScale(zoom);
  const place = { left: at.x, top: at.y, width: box.width, height: box.height };
  return (
    <>
      {/* The dimming stays on the picture; the frame and its handles below are not clipped. */}
      <div
        aria-hidden='true'
        className='pointer-events-none absolute overflow-hidden'
        style={place}
      >
        {rect === null ? null : (
          <div
            className='absolute'
            style={{
              left: rect.x,
              top: rect.y,
              width: rect.width,
              height: rect.height,
              boxShadow: '0 0 0 100000px rgb(0 0 0 / 0.4)',
            }}
          />
        )}
      </div>
      <div
        data-testid={`${testIdPrefix}-layer`}
        className='nodrag nopan absolute cursor-crosshair touch-none'
        style={place}
        onPointerDown={onLayerDown}
        onPointerMove={onMove}
        onPointerUp={onUp}
        onPointerCancel={onUp}
      >
        {rect === null ? null : (
          <div
            data-testid={`${testIdPrefix}-rect`}
            className='absolute cursor-move border-solid border-background outline outline-foreground'
            style={{
              left: rect.x,
              top: rect.y,
              width: rect.width,
              height: rect.height,
              borderWidth: scale,
              outlineWidth: scale,
            }}
            onPointerDown={onRectDown}
          >
            {CROP_HANDLES.map(({ id, className }) => (
              <div
                key={id}
                data-testid={`${testIdPrefix}-handle-${id}`}
                // Round while the marquee is free, square while a ratio holds
                // it (user 2026-10-07): the handle is the control that changes
                // the shape, so the signal sits on it.
                className={`absolute h-2 w-2 border border-foreground bg-background ${ratio === null ? 'rounded-full ' : ''}${className}`}
                style={{ scale: String(scale) }}
                onPointerDown={onHandleDown(id)}
              />
            ))}
          </div>
        )}
      </div>
    </>
  );
}
