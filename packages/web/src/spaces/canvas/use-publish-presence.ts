// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import * as React from 'react';
import type { Awareness } from 'y-protocols/awareness';

import type { ActiveNodeSources } from '@web/spaces/canvas/active-node-ids';
import type { GestureGeometry } from '@web/spaces/canvas/gesture-table';
import { deriveActiveNodeIds, sameIdList } from '@web/spaces/canvas/active-node-ids';
import { createPublishThrottle } from '@web/spaces/canvas/publish-throttle';
import { observeViewportTransform } from '@web/spaces/canvas/viewport-observer';

/**
 * The shortest gap allowed between two awareness writes, in ms.
 *
 * Awareness resends the whole state on every field write, so the fastest field
 * sets the rate for all of them. 33ms is where Excalidraw puts its cursor sync
 * (`CURSOR_SYNC_TIMEOUT = 33`) and where tldraw puts its collaborative frame
 * rate (`COLLABORATIVE_MODE_FPS = 30`).
 */
const MIN_WRITE_INTERVAL_MS = 33;

/** A point, in either screen or canvas coordinates. */
interface Point {
  /** Horizontal position. */
  x: number;
  /** Vertical position. */
  y: number;
}

/** What the publisher needs to keep this client's presence truthful. */
export interface PublishPresenceInput {
  /** This space's awareness, or null before the document is attached. */
  awareness: Awareness | null;
  /** The three local sources of the holding. */
  sources: ActiveNodeSources;
  /** Whether this document has finished syncing with the server. */
  synced: boolean;
  /**
   * The canvas container, whose pointer events say where this user is.
   *
   * A ref rather than the element: the element is null on the first render and
   * filling a ref schedules nothing, so an effect keyed on the element itself
   * would keep the null it was given and never attach a listener.
   */
  containerRef: React.RefObject<HTMLElement | null>;
  /** Turn a screen point into a canvas point. */
  toFlowPosition: (screen: Point) => Point;
}

/** The geometry a gesture is showing, keyed by node id. */
export type GestureBatch = Record<string, GestureGeometry>;

/** The shape this client writes into awareness. */
interface Presence {
  /** The nodes this client is holding, or null while it holds none. */
  activeNodeIds: readonly string[] | null;
  /** Where this client's pointer is on the canvas, or null while it is away. */
  pointer: Point | null;
  /** The geometry this client's gesture is showing, or null while it has none. */
  gesture: GestureBatch | null;
}

/** The commands a gesture drives the publisher with. */
export interface GesturePublisher {
  /** Publish this batch, folded into the write rate like the other fields. */
  publishGesture: (geometry: GestureBatch) => void;
  /**
   * Publish this batch straight away, past the rate limit and the
   * de-duplication. The final position of a fast gesture can be one the limiter
   * never got to send, and the value has to be on the wire before the document
   * write follows it (design §5.6).
   */
  publishGestureNow: (geometry: GestureBatch) => void;
  /**
   * Take the whole field back down, written on the spot rather than scheduled.
   * A withdrawal has to land (`packages/web/CLAUDE.md`), and the moment it is
   * called can be the moment the page stops getting animation frames.
   */
  clearGesture: () => void;
}

/**
 * Read back what this client last got into the awareness state.
 * @param awareness - The awareness to read.
 * @returns The three published fields.
 */
function readPublished(awareness: Awareness): Presence {
  const state = awareness.getLocalState() as Record<string, unknown> | null;
  const ids = state?.activeNodeIds;
  const pointer = state?.pointer;
  const gesture = state?.gesture;
  return {
    activeNodeIds: Array.isArray(ids) ? (ids as string[]) : null,
    pointer: (pointer as Point | undefined) ?? null,
    gesture: (gesture as GestureBatch | undefined) ?? null,
  };
}

/**
 * Compare two gesture batches by value, so a gesture that produced no movement
 * is not republished.
 * @param a - The previously published batch.
 * @param b - The freshly built batch.
 * @returns True when the two show the same nodes at the same geometry.
 */
function sameBatch(a: GestureBatch | null, b: GestureBatch | null): boolean {
  if (a === null || b === null) return a === b;
  const keys = Object.keys(a);
  if (keys.length !== Object.keys(b).length) return false;
  return keys.every((id) => {
    const one = a[id];
    const other = b[id];
    return (
      other !== undefined &&
      one !== undefined &&
      one.x === other.x &&
      one.y === other.y &&
      one.width === other.width &&
      one.height === other.height
    );
  });
}

/**
 * Compare two pointer positions.
 * @param a - The previously published position.
 * @param b - The freshly computed position.
 * @returns True when the two describe the same place.
 */
function samePoint(a: Point | null, b: Point | null): boolean {
  if (a === null || b === null) return a === b;
  return a.x === b.x && a.y === b.y;
}

/**
 * Publish what this client is doing into awareness — the single writer of
 * `activeNodeIds` and `pointer`.
 *
 * Writes are rate-limited by {@link createPublishThrottle}: the frame folds
 * together a rubber-band drag, where the holding genuinely changes on every
 * pointer move and comparing values damps nothing, and the interval caps the
 * rate. Both fields go through the same limiter and land in one write, because
 * awareness resends the whole state whatever field you touch.
 *
 * The de-duplication compares against the values read back out of awareness
 * rather than a local copy, so a state removed from the outside reads as a
 * difference and gets re-sent. Two moments need a nudge because the sources do
 * not move across them at all. A bfcache round trip needs one write: the
 * provider removes the local state on the way out and the socket registry puts
 * an empty one back on the way in, and that emptiness is itself the
 * difference. A reconnect needs the write to skip
 * de-duplication entirely: the state survived the close intact, so nothing
 * differs locally, while the peers dropped it — and neither side's clock
 * advanced while the socket was closed, so a re-send carrying the old clock
 * would be discarded as already seen.
 *
 * The pointer is stored twice over: as the canvas point that goes on the wire,
 * and as the screen point it came from. Panning and centre-anchored zooming
 * move the canvas under a pointer that fires no event of its own, so the same
 * screen point becomes a different canvas point and has to be converted again.
 * A pointer that has left the canvas keeps no screen point, which is what stops
 * a later pan from reviving the arrow at a stale spot.
 * @param input - The awareness, the sources, the sync state, and the canvas.
 * @returns The commands a gesture publishes its geometry with.
 */
export function usePublishPresence(input: PublishPresenceInput): GesturePublisher {
  const { awareness, sources, synced, containerRef, toFlowPosition } = input;
  const { selectedIds, pickSession, focusTargetId } = sources;

  // Read inside the write callback instead of closing over the values, so a
  // write scheduled just before a change still publishes the latest state.
  const latestSources = React.useRef(sources);
  latestSources.current = sources;
  const latestConvert = React.useRef(toFlowPosition);
  latestConvert.current = toFlowPosition;

  // The pointer's last screen position, or null once it left the canvas. It is
  // a ref rather than state: it changes at pointer rates and no render reads
  // it — the value that reaches the peers goes straight into awareness.
  const screenPoint = React.useRef<Point | null>(null);

  // `force` skips the de-duplication for one write; it is a ref rather than
  // state so setting it never schedules a render of its own.
  const force = React.useRef(false);

  // The gesture's own batch. A ref rather than state: it is rewritten on every
  // pointer move of a drag and no render reads it — what reaches the peers goes
  // straight into awareness.
  const gesture = React.useRef<GestureBatch | null>(null);

  const publish = React.useCallback((): void => {
    if (!awareness) return;
    const at = screenPoint.current;
    const next: Presence = {
      activeNodeIds: deriveActiveNodeIds(latestSources.current),
      pointer: at === null ? null : latestConvert.current(at),
      gesture: gesture.current,
    };
    const prev = readPublished(awareness);
    const unchanged =
      sameIdList(prev.activeNodeIds, next.activeNodeIds) &&
      samePoint(prev.pointer, next.pointer) &&
      sameBatch(prev.gesture, next.gesture);
    const skip = !force.current && unchanged;
    force.current = false;
    if (skip) return;
    // One write for both fields: awareness resends the whole state per field,
    // so two writes would double the traffic to say one thing.
    awareness.setLocalState({ ...awareness.getLocalState(), ...next });
  }, [awareness]);

  const throttle = React.useMemo(
    () => createPublishThrottle(() => publish(), MIN_WRITE_INTERVAL_MS),
    [publish],
  );

  React.useEffect(() => {
    if (!awareness) return undefined;
    throttle.schedule();
    return (): void => throttle.cancel();
  }, [awareness, throttle, selectedIds, pickSession, focusTargetId]);

  // Reconnect. This also covers the first publish being scheduled before the
  // document finished syncing, since a fresh mount starts out unsynced.
  React.useEffect(() => {
    if (!awareness || !synced) return;
    force.current = true;
    throttle.schedule();
  }, [awareness, synced, throttle]);

  // bfcache restore.
  React.useEffect(() => {
    if (!awareness) return undefined;
    /**
     * Re-send the presence after a restore from the bfcache.
     * @param event - The pageshow event; `persisted` is true only on a restore.
     */
    const onPageShow = (event: PageTransitionEvent): void => {
      if (!event.persisted) return;
      throttle.schedule();
    };
    window.addEventListener('pageshow', onPageShow);
    return (): void => window.removeEventListener('pageshow', onPageShow);
  }, [awareness, throttle]);

  // The pointer, from the canvas container and from the viewport moving under
  // a pointer that stayed put.
  React.useEffect(() => {
    const container = containerRef.current;
    if (!awareness || !container) return undefined;
    /**
     * Remember where the pointer is and publish it.
     * @param event - The move, carrying screen coordinates.
     */
    const onMove = (event: MouseEvent): void => {
      screenPoint.current = { x: event.clientX, y: event.clientY };
      throttle.schedule();
    };
    /** Forget the pointer, which also stops any later pan from reviving it. */
    const onLeave = (): void => {
      screenPoint.current = null;
      throttle.schedule();
    };
    /**
     * Forget the pointer and say so in the same turn.
     *
     * Losing focus is usually the page being hidden as well, and a hidden
     * document is given no animation frames — the throttle would park this on
     * one that never arrives, and its own guard would then swallow every later
     * attempt. A withdrawal that has to land is written the way the teardown
     * below writes its own: directly.
     */
    const onWindowBlur = (): void => {
      throttle.cancel();
      screenPoint.current = null;
      publish();
    };
    container.addEventListener('pointermove', onMove);
    container.addEventListener('pointerleave', onLeave);
    // Switching to another window leaves the pointer resting on the canvas, so
    // no `pointerleave` arrives and the peers would keep an arrow at a spot
    // nobody is looking at. The text-caret presence publishes window focus for
    // the same reason (`use-collab-caret-presence.ts`); the next real move
    // republishes on the way back.
    window.addEventListener('blur', onWindowBlur);
    // A pointer that already left has no screen point, so every recomputation
    // from here on produces null — the same null that is already published,
    // which the de-duplication drops. That is what keeps a later pan from
    // reviving the arrow at a stale spot.
    const stopWatching = observeViewportTransform(() => throttle.schedule());
    // The conversion subtracts the container's own rect, so its size and place
    // on screen are as much an input as the viewport's transform: a sidebar
    // opening moves the canvas point a resting pointer maps to.
    const resize = new ResizeObserver(() => throttle.schedule());
    resize.observe(container);
    return (): void => {
      container.removeEventListener('pointermove', onMove);
      container.removeEventListener('pointerleave', onLeave);
      window.removeEventListener('blur', onWindowBlur);
      stopWatching();
      resize.disconnect();
    };
  }, [awareness, containerRef, throttle, publish]);

  // Withdraw. Leaving the space must take the presence with it, and this runs
  // after the throttle above was cancelled, so it is the last word.
  React.useEffect(() => {
    if (!awareness) return undefined;
    return (): void => {
      screenPoint.current = null;
      gesture.current = null;
      awareness.setLocalState({
        ...awareness.getLocalState(),
        activeNodeIds: null,
        pointer: null,
        gesture: null,
      });
    };
  }, [awareness]);

  return React.useMemo(
    (): GesturePublisher => ({
      publishGesture: (geometry: GestureBatch): void => {
        gesture.current = geometry;
        throttle.schedule();
      },
      publishGestureNow: (geometry: GestureBatch): void => {
        gesture.current = geometry;
        throttle.cancel();
        force.current = true;
        publish();
      },
      clearGesture: (): void => {
        gesture.current = null;
        throttle.cancel();
        publish();
      },
    }),
    [throttle, publish],
  );
}
