// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

import * as React from 'react';
import Moveable, { type OnDrag, type OnRotate, type OnScale, type OnScaleStart } from 'react-moveable';
import {
  clampTimelineScale, normalizeTimelineLayerTransform, sameTimelineLayerTransform, timelineLayerCss, type TimelineLayerBox, type TimelineLayerTransform,
} from '@breatic/shared';

import '@web/spaces/timeline/timeline-layer-handles.css';

/** One selected layer's handles. */
export interface TimelineLayerHandlesProps {
  /** The document canvas, in canvas pixels. */
  canvas: { width: number; height: number };
  /** The layer's base box, in canvas pixels. */
  base: TimelineLayerBox;
  /** The stored transform. */
  transform: TimelineLayerTransform;
  /** Display pixels per canvas pixel. */
  factor: number;
  /** The toolbar's snap switch. */
  snap: boolean;
  /** The live value during a gesture, in canvas pixels; null when it ends or is cancelled. */
  onOverride: (transform: TimelineLayerTransform | null) => void;
  /** The value to write on release, already clamped, normalised and rounded, and different from the stored one. */
  onCommit: (transform: TimelineLayerTransform) => void;
  /** True from a press to the end or cancel of its gesture. */
  onDraggingChange: (dragging: boolean) => void;
  /** A press inside the box that did not move, for the topmost hit test. */
  onPick: (event: MouseEvent) => void;
}

const DIRECTIONS = ['nw', 'n', 'ne', 'w', 'e', 'sw', 's', 'se'];
const SNAP_DIRECTIONS = { left: true, right: true, top: true, bottom: true, center: true, middle: true };
// Snapping to the frame's edges and centre lines within 6 display pixels (#1410 design §4.4).
const SNAP_THRESHOLD = 6;

/**
 * Move, scale, stretch and rotate one layer in the preview with `react-moveable` (#1410 design §4.3): a transparent
 * proxy on the layer's box is Moveable's target; the live value stays local until release, when one value is handed to
 * `onCommit`. Escape, a window blur and unmounting cancel the gesture and hand nothing over.
 * @param props - The layer and the callbacks.
 * @param props.canvas - The canvas size.
 * @param props.base - The layer's base box.
 * @param props.transform - The stored transform.
 * @param props.factor - Display pixels per canvas pixel.
 * @param props.snap - Whether to snap.
 * @param props.onOverride - Reports the live value.
 * @param props.onCommit - Writes the released value.
 * @param props.onDraggingChange - Reports whether a gesture is held.
 * @param props.onPick - Re-picks on a press that did not move.
 * @returns The proxy and its handles.
 * @throws {never} Never.
 */
export function TimelineLayerHandles({ canvas, base, transform, factor, snap, onOverride, onCommit, onDraggingChange, onPick }: TimelineLayerHandlesProps): React.JSX.Element {
  const [proxy, setProxy] = React.useState<HTMLDivElement | null>(null);
  const [live, setLive] = React.useState<TimelineLayerTransform | null>(null);
  const [keepRatio, setKeepRatio] = React.useState(true);
  const moveable = React.useRef<Moveable>(null);
  // Read by the gesture callbacks, which Moveable may keep across renders.
  const latest = React.useRef({ transform, factor, onOverride, onCommit, onDraggingChange, onPick });
  latest.current = { transform, factor, onOverride, onCommit, onDraggingChange, onPick };
  const gesture = React.useRef<{ value: TimelineLayerTransform | null; cancelled: boolean } | null>(null);

  const show = React.useCallback((value: TimelineLayerTransform): void => {
    if (gesture.current === null || gesture.current.cancelled) return;
    gesture.current.value = value;
    setLive(value);
    latest.current.onOverride(value);
  }, []);
  const begin = React.useCallback((): void => {
    gesture.current = { value: null, cancelled: false };
    latest.current.onDraggingChange(true);
  }, []);
  const finish = React.useCallback((): void => {
    const held = gesture.current;
    gesture.current = null;
    if (held === null || held.cancelled) return;
    setLive(null);
    latest.current.onOverride(null);
    latest.current.onDraggingChange(false);
    if (held.value === null) return;
    const next = normalizeTimelineLayerTransform(held.value);
    if (!sameTimelineLayerTransform(next, latest.current.transform)) latest.current.onCommit(next);
  }, []);
  const cancel = React.useCallback((): void => {
    const held = gesture.current;
    if (held === null || held.cancelled) return;
    held.cancelled = true;
    setLive(null);
    latest.current.onOverride(null);
    latest.current.onDraggingChange(false);
    moveable.current?.stopDrag();
  }, []);

  React.useEffect(() => {
    /**
     * Cancel the held gesture on Escape.
     * @param event - The key press.
     * @throws {never} Never.
     */
    const escape = (event: KeyboardEvent): void => { if (event.key === 'Escape') cancel(); };
    window.addEventListener('keydown', escape);
    window.addEventListener('blur', cancel);
    return () => {
      window.removeEventListener('keydown', escape);
      window.removeEventListener('blur', cancel);
      const held = gesture.current;
      gesture.current = null;
      if (held !== null && !held.cancelled) {
        latest.current.onOverride(null);
        latest.current.onDraggingChange(false);
      }
    };
  }, [cancel]);

  /**
   * The value a gesture builds on: its last live value, or the stored transform.
   * @returns The transform.
   * @throws {never} Never.
   */
  const current = (): TimelineLayerTransform => gesture.current?.value ?? latest.current.transform;
  const onDrag = React.useCallback((event: OnDrag): void => {
    const scale = latest.current.factor;
    show({ ...current(), x: event.beforeTranslate[0]! / scale, y: event.beforeTranslate[1]! / scale });
  }, [show]);
  const onScaleStart = React.useCallback((event: OnScaleStart): void => {
    begin();
    // An edge handle stretches one axis; a corner keeps the ratio.
    setKeepRatio(event.direction[0] !== 0 && event.direction[1] !== 0);
  }, [begin]);
  const onScale = React.useCallback((event: OnScale): void => {
    const scale = latest.current.factor;
    show({
      ...current(), scaleX: clampTimelineScale(event.scale[0]!), scaleY: clampTimelineScale(event.scale[1]!),
      x: event.drag.beforeTranslate[0]! / scale, y: event.drag.beforeTranslate[1]! / scale,
    });
  }, [show]);
  const onScaleEnd = React.useCallback((): void => {
    setKeepRatio(true);
    finish();
  }, [finish]);
  const onRotate = React.useCallback((event: OnRotate): void => {
    show({ ...current(), rotation: event.rotation });
  }, [show]);
  const onClick = React.useCallback((event: { inputEvent: MouseEvent }): void => {
    latest.current.onPick(event.inputEvent);
  }, []);

  const shown = live ?? transform;
  const style = React.useMemo((): React.CSSProperties => ({
    left: base.left * factor, top: base.top * factor, width: base.width * factor, height: base.height * factor,
    transform: timelineLayerCss(shown, factor), transformOrigin: 'center',
  }), [base, factor, shown]);
  // Moveable measures its target only when told: a transform written by the panel, a collaborator or undo moves the
  // proxy without a gesture, so the box is measured again whenever the proxy's place changes.
  React.useLayoutEffect(() => { moveable.current?.updateRect(); }, [style]);
  const width = canvas.width * factor;
  const height = canvas.height * factor;
  const vertical = React.useMemo(() => [0, width / 2, width], [width]);
  const horizontal = React.useMemo(() => [0, height / 2, height], [height]);
  return <>
    <div ref={setProxy} data-testid='timeline-layer-proxy' className='absolute' style={style} />
    {proxy !== null && <Moveable ref={moveable} target={proxy} className='timeline-layer-handles' origin={false} throttleRotate={0}
      draggable scalable rotatable keepRatio={keepRatio} renderDirections={DIRECTIONS}
      snappable={snap} snapThreshold={SNAP_THRESHOLD} snapDirections={SNAP_DIRECTIONS} elementSnapDirections={SNAP_DIRECTIONS}
      verticalGuidelines={vertical} horizontalGuidelines={horizontal} isDisplaySnapDigit={false}
      onDragStart={begin} onDrag={onDrag} onDragEnd={finish}
      onScaleStart={onScaleStart} onScale={onScale} onScaleEnd={onScaleEnd}
      onRotateStart={begin} onRotate={onRotate} onRotateEnd={finish} onClick={onClick} />}
  </>;
}
