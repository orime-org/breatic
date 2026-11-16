// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

import * as React from 'react';
import type { Viewport } from '@xyflow/react';
import type { Awareness } from 'y-protocols/awareness';

import { pickLeaderField } from '@web/data/yjs/follow-presence';
import { FOLLOW_BAR_HEIGHT } from '@web/features/follow/FollowBar';
import { followViewport, type FlowRect, type PaneSize } from '@web/features/follow/follow-geometry';
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
 * Once aligned, only a camera stamped later than the last one is applied: the
 * awareness change event fires for every member's pointer and holding, and
 * those must not refit a viewport the leader has not moved. A follower
 * publishes no viewport of its own (`usePublishPresence`); following is one
 * level deep, so nobody follows a follower.
 *
 * The move this hook makes runs inside a synchronous `applying` flag, because
 * xyflow reports a programmatic move through `onMoveStart` in the same call.
 * Every other move start (wheel, drag, pinch, minimap, toolbar, shortcut)
 * stops following. A canvas opened while following queues no opening fit,
 * and the one a canvas still has queued when following starts is dropped
 * then, so no move of the canvas's own reads as the user's.
 * @param input - The awareness, the leader, readiness and the viewport commands.
 * @returns The `<ReactFlow onMoveStart>` handler.
 */
export function useCanvasFollow(input: CanvasFollowInput): (event: unknown) => void {
  const { awareness, leaderUserId, ready } = input;
  const latest = React.useRef(input);
  latest.current = input;
  const applying = React.useRef(false);
  // The leader camera last applied, kept for a refit when this pane changes size.
  const last = React.useRef<{ rect: FlowRect; at: number } | null>(null);

  /**
   * Move this viewport to show a leader rectangle, marking the move as this hook's own.
   * @param rect - The leader rectangle.
   */
  const fitLeader = React.useCallback((rect: FlowRect): void => {
    const { pane, applyViewport } = latest.current;
    applying.current = true;
    try {
      applyViewport(belowFollowBar(rect, pane));
    } finally {
      applying.current = false;
    }
  }, []);

  React.useEffect(() => {
    if (leaderUserId !== null) latest.current.clearOpeningFit();
  }, [leaderUserId]);

  React.useEffect(() => {
    if (!awareness || leaderUserId === null || !ready) return undefined;
    /** Fit the leader's latest rectangle into this pane, when it is newer than the last. */
    const align = (): void => {
      // Stopped from inside (a move start) before the store's value re-rendered us.
      if (useFollowStore.getState().targetUserId !== leaderUserId) return;
      const camera = pickLeaderField(awareness, leaderUserId, 'camera');
      if (camera === null) return;
      if (last.current !== null && camera.at <= last.current.at) return;
      const rect: FlowRect = { x: camera.x, y: camera.y, width: camera.width, height: camera.height };
      last.current = { rect, at: camera.at };
      fitLeader(rect);
    };
    align();
    awareness.on('change', align);
    return (): void => {
      awareness.off('change', align);
      last.current = null;
    };
  }, [awareness, leaderUserId, ready, fitLeader]);

  const { width, height } = input.pane;
  React.useEffect(() => {
    const applied = last.current;
    if (applied === null) return;
    if (useFollowStore.getState().targetUserId !== latest.current.leaderUserId) return;
    fitLeader(applied.rect);
  }, [width, height, fitLeader]);

  return React.useCallback((): void => {
    if (!applying.current) stopFollowing();
  }, []);
}
