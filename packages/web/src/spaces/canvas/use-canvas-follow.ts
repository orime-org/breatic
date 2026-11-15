// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

import * as React from 'react';
import type { Viewport } from '@xyflow/react';
import type { Awareness } from 'y-protocols/awareness';

import { pickLeaderField } from '@web/data/yjs/follow-presence';
import { FOLLOW_BAR_HEIGHT } from '@web/features/follow/FollowBar';
import { followViewport, sameRect, type FlowRect, type PaneSize } from '@web/features/follow/follow-geometry';
import { stopFollowing, useFollowStore } from '@web/stores/follow';

/** What following a member on the canvas needs (#920 design 4.2). */
export interface CanvasFollowInput {
  /** This canvas Space's awareness, or null before it is attached. */
  awareness: Awareness | null;
  /** The member being followed, or null while not following. */
  leaderUserId: string | null;
  /** Whether the canvas has loaded far enough to be moved. */
  ready: boolean;
  /** This client's pane size on screen; a change fits the leader rectangle again. */
  pane: PaneSize;
  /** Move this client's viewport, at once. */
  applyViewport: (viewport: Viewport) => void;
  /** Drop the opening fit a canvas with no stored camera still has queued. */
  clearOpeningFit: () => void;
}

/** What the canvas wires back in. */
export interface CanvasFollowResult {
  /** The leader rectangle the viewport was last aligned to, or null; the camera publisher sends it on unchanged. */
  followCamera: FlowRect | null;
  /** The `<ReactFlow onMoveStart>` handler: the user's moves, and after the first alignment any move this hook did not start, stop following. */
  onMoveStart: (event: unknown) => void;
}

/**
 * The viewport that shows the whole of a leader rectangle below the follow
 * bar, which covers the top of the pane while following.
 * @param rect - The leader rectangle.
 * @param pane - This client's pane size.
 * @returns The viewport to set.
 */
function belowFollowBar(rect: FlowRect, pane: PaneSize): Viewport {
  const fit = followViewport(rect, { width: pane.width, height: pane.height - FOLLOW_BAR_HEIGHT });
  return { ...fit, y: fit.y + FOLLOW_BAR_HEIGHT };
}

/**
 * Keep this canvas's viewport on the followed member's visible rectangle
 * (#920 design 4.2): each new `camera` the leader publishes on this Space is
 * fitted into this pane below the follow bar, the way tldraw fits a followed
 * user's viewport, and fitted again when this pane changes size.
 *
 * Once aligned, only a camera stamped later than the last one is applied. A
 * follower passes the leader's camera on with the leader's own stamp (the
 * camera publisher), so two members who press View on each other within one
 * round trip settle on one rectangle instead of swapping theirs forever.
 * Stamps are wall clocks: a relay from a browser whose clock is behind is held
 * until that clock catches up.
 *
 * The move this hook makes runs inside a synchronous `applying` flag, because
 * xyflow reports a programmatic move through `onMoveStart` in the same call.
 * A move start carrying an input event (wheel, drag, pinch) is the user
 * moving the view and always stops following; one without (minimap, toolbar,
 * framing) stops it once aligned, while before the first alignment it is the
 * opening fit of a canvas that loads after following started.
 * @param input - The awareness, the leader, readiness and the viewport commands.
 * @returns The rectangle to publish while following and the move-start handler.
 */
export function useCanvasFollow(input: CanvasFollowInput): CanvasFollowResult {
  const { awareness, leaderUserId, ready } = input;
  const latest = React.useRef(input);
  latest.current = input;
  const applying = React.useRef(false);
  const aligned = React.useRef(false);
  // The leader camera last applied, kept for a refit when this pane changes size.
  const last = React.useRef<{ rect: FlowRect; at: number } | null>(null);
  const [followCamera, setFollowCamera] = React.useState<FlowRect | null>(null);

  /**
   * Move this viewport to show a leader rectangle, marking the move as this hook's own.
   * @param rect - The leader rectangle.
   */
  const fitLeader = React.useCallback((rect: FlowRect): void => {
    const { pane, applyViewport, clearOpeningFit } = latest.current;
    // Otherwise the queued fit frames every node right after this move.
    if (!aligned.current) clearOpeningFit();
    applying.current = true;
    try {
      applyViewport(belowFollowBar(rect, pane));
    } finally {
      applying.current = false;
    }
    aligned.current = true;
  }, []);

  React.useEffect(() => {
    if (!awareness || leaderUserId === null || !ready) return undefined;
    last.current = null;
    /** Fit the leader's latest rectangle into this pane, when it is newer than the last. */
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
      if (last.current !== null && camera.at <= last.current.at) return;
      const rect: FlowRect = { x: camera.x, y: camera.y, width: camera.width, height: camera.height };
      last.current = { rect, at: camera.at };
      fitLeader(rect);
      setFollowCamera((prev) => (sameRect(prev, rect) ? prev : rect));
    };
    align();
    awareness.on('change', align);
    return (): void => {
      awareness.off('change', align);
      aligned.current = false;
      last.current = null;
      setFollowCamera(null);
    };
  }, [awareness, leaderUserId, ready, fitLeader]);

  const { width, height } = input.pane;
  React.useEffect(() => {
    const applied = last.current;
    if (applied === null || !aligned.current) return;
    if (useFollowStore.getState().targetUserId !== latest.current.leaderUserId) return;
    fitLeader(applied.rect);
  }, [width, height, fitLeader]);

  const onMoveStart = React.useCallback((event: unknown): void => {
    if (applying.current) return;
    // Before the first alignment only an input event is the user's own move.
    if (!aligned.current && (event === null || event === undefined)) return;
    stopFollowing();
    aligned.current = false;
    last.current = null;
    setFollowCamera(null);
  }, []);

  return React.useMemo(
    (): CanvasFollowResult => ({ followCamera: leaderUserId === null ? null : followCamera, onMoveStart }),
    [followCamera, leaderUserId, onMoveStart],
  );
}
