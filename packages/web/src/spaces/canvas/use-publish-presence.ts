// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import * as React from 'react';
import type { Awareness } from 'y-protocols/awareness';

import type { ActiveNodeSources } from '@web/spaces/canvas/active-node-ids';
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
  /** Whether the document's connection is currently synced. */
  connected: boolean;
  /** The canvas container, whose pointer events say where this user is. */
  container: HTMLElement | null;
  /** Turn a screen point into a canvas point. */
  toFlowPosition: (screen: Point) => Point;
}

/** The shape this client writes into awareness. */
interface Presence {
  /** The nodes this client is holding, or null while it holds none. */
  activeNodeIds: readonly string[] | null;
  /** Where this client's pointer is on the canvas, or null while it is away. */
  pointer: Point | null;
}

/**
 * Read back what this client last got into the awareness state.
 * @param awareness - The awareness to read.
 * @returns The two published fields.
 */
function readPublished(awareness: Awareness): Presence {
  const state = awareness.getLocalState() as Record<string, unknown> | null;
  const ids = state?.activeNodeIds;
  const pointer = state?.pointer;
  return {
    activeNodeIds: Array.isArray(ids) ? (ids as string[]) : null,
    pointer: (pointer as Point | undefined) ?? null,
  };
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
 * provider drops the local state on the way in and restores an empty one, and
 * that emptiness is itself the difference. A reconnect needs the write to skip
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
 * @param input - The awareness, the sources, the connection, and the canvas.
 */
export function usePublishPresence(input: PublishPresenceInput): void {
  const { awareness, sources, connected, container, toFlowPosition } = input;
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

  const publish = React.useCallback((): void => {
    if (!awareness) return;
    const at = screenPoint.current;
    const next: Presence = {
      activeNodeIds: deriveActiveNodeIds(latestSources.current),
      pointer: at === null ? null : latestConvert.current(at),
    };
    const prev = readPublished(awareness);
    const unchanged =
      sameIdList(prev.activeNodeIds, next.activeNodeIds) && samePoint(prev.pointer, next.pointer);
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

  // Reconnect. `connected` starts true on a healthy mount, so this also covers
  // the first publish being scheduled before the document finished syncing.
  React.useEffect(() => {
    if (!awareness || !connected) return;
    force.current = true;
    throttle.schedule();
  }, [awareness, connected, throttle]);

  // bfcache restore.
  React.useEffect(() => {
    if (!awareness) return undefined;
    /**
     * Re-send the presence after a restore from the bfcache.
     * @param event - The pageshow event; only a restore carries `persisted`.
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
    container.addEventListener('pointermove', onMove);
    container.addEventListener('pointerleave', onLeave);
    // A pointer that already left has no screen point, so every recomputation
    // from here on produces null — the same null that is already published,
    // which the de-duplication drops. That is what keeps a later pan from
    // reviving the arrow at a stale spot.
    const stopWatching = observeViewportTransform(() => throttle.schedule());
    return (): void => {
      container.removeEventListener('pointermove', onMove);
      container.removeEventListener('pointerleave', onLeave);
      stopWatching();
    };
  }, [awareness, container, throttle]);

  // Withdraw. Leaving the space must take the presence with it, and this runs
  // after the throttle above was cancelled, so it is the last word.
  React.useEffect(() => {
    if (!awareness) return undefined;
    return (): void => {
      screenPoint.current = null;
      awareness.setLocalState({
        ...awareness.getLocalState(),
        activeNodeIds: null,
        pointer: null,
      });
    };
  }, [awareness]);
}
