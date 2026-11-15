// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

import * as React from 'react';
import type { Viewport } from '@xyflow/react';
import type { Awareness } from 'y-protocols/awareness';

import { pickLeaderField } from '@web/data/yjs/follow-presence';
import { followViewport, type FlowRect, type PaneSize } from '@web/features/follow/follow-geometry';
import { useFollowStore } from '@web/stores/follow';

/** What following a member on the canvas needs (#920 design 4.2). */
export interface CanvasFollowInput {
  /** This canvas Space's awareness, or null before it is attached. */
  awareness: Awareness | null;
  /** The member being followed, or null while not following. */
  leaderUserId: string | null;
  /** Whether the canvas has loaded far enough to be moved. */
  ready: boolean;
  /** This client's pane size on screen, read at the moment of aligning. */
  paneSize: () => PaneSize;
  /** Move this client's viewport, at once. */
  applyViewport: (viewport: Viewport) => void;
  /** Drop the opening fit a canvas with no stored camera still has queued. */
  clearOpeningFit: () => void;
}

/** What the canvas wires back in. */
export interface CanvasFollowResult {
  /** The leader rectangle the viewport was last aligned to, or null; the camera publisher sends it on unchanged. */
  followCamera: FlowRect | null;
  /** The `<ReactFlow onMoveStart>` handler: any move this hook did not start stops following. */
  onMoveStart: (event: unknown) => void;
}

/**
 * Whether two rectangles are the same.
 * @param a - One rectangle.
 * @param b - The other.
 * @returns True when they match.
 */
function sameRect(a: FlowRect | null, b: FlowRect): boolean {
  return a !== null && a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height;
}

/**
 * Keep this canvas's viewport on the followed member's visible rectangle
 * (#920 design 4.2): each new `camera` the leader publishes on this Space is
 * fitted into this pane, the way tldraw fits a followed user's viewport.
 *
 * The move this hook makes runs inside a synchronous `applying` flag, because
 * xyflow reports a programmatic move through `onMoveStart` in the same call;
 * every other move start (wheel, drag, minimap, toolbar, framing) is the user
 * moving the view and stops following. Moves before the first alignment (the
 * opening fit of a canvas that loads after following started) are not judged.
 * @param input - The awareness, the leader, readiness and the viewport commands.
 * @returns The rectangle to publish while following and the move-start handler.
 */
export function useCanvasFollow(input: CanvasFollowInput): CanvasFollowResult {
  const { awareness, leaderUserId, ready } = input;
  const latest = React.useRef(input);
  latest.current = input;
  const applying = React.useRef(false);
  const aligned = React.useRef(false);
  const [followCamera, setFollowCamera] = React.useState<FlowRect | null>(null);

  React.useEffect(() => {
    if (!awareness || leaderUserId === null || !ready) return undefined;
    let last: { rect: FlowRect; at: number } | null = null;
    /** Fit the leader's latest rectangle into this pane, when it moved. */
    const align = (): void => {
      // Stopped from inside (a move start) before the store's value re-rendered us.
      if (useFollowStore.getState().targetUserId !== leaderUserId) return;
      const camera = pickLeaderField(
        awareness.getStates() as ReadonlyMap<number, Record<string, unknown>>,
        leaderUserId,
        'camera',
        awareness.clientID,
      );
      if (camera === null) return;
      const rect: FlowRect = { x: camera.x, y: camera.y, width: camera.width, height: camera.height };
      if (last !== null && last.at === camera.at && sameRect(last.rect, rect)) return;
      last = { rect, at: camera.at };
      const { paneSize, applyViewport, clearOpeningFit } = latest.current;
      // Otherwise the queued fit frames every node right after this move.
      if (!aligned.current) clearOpeningFit();
      applying.current = true;
      try {
        applyViewport(followViewport(rect, paneSize()));
      } finally {
        applying.current = false;
      }
      aligned.current = true;
      setFollowCamera((prev) => (sameRect(prev, rect) ? prev : rect));
    };
    align();
    awareness.on('change', align);
    return (): void => {
      awareness.off('change', align);
      aligned.current = false;
      setFollowCamera(null);
    };
  }, [awareness, leaderUserId, ready]);

  const onMoveStart = React.useCallback((): void => {
    if (applying.current || !aligned.current) return;
    useFollowStore.getState().stop('viewport');
    aligned.current = false;
    setFollowCamera(null);
  }, []);

  return React.useMemo(
    (): CanvasFollowResult => ({ followCamera: leaderUserId === null ? null : followCamera, onMoveStart }),
    [followCamera, leaderUserId, onMoveStart],
  );
}
