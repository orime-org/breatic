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
  /** Whether the opening fit of a canvas with no stored camera has yet to run. */
  openingFitPending: () => boolean;
}

/** What the canvas wires back in. */
export interface CanvasFollowResult {
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
 * Once aligned, only a camera stamped later than the last one is applied: the
 * awareness change event fires for every member's pointer and holding, and
 * those must not refit a viewport the leader has not moved. A follower
 * publishes no viewport of its own (`usePublishPresence`); following is one
 * level deep, so nobody follows a follower.
 *
 * The move this hook makes runs inside a synchronous `applying` flag, because
 * xyflow reports a programmatic move through `onMoveStart` in the same call.
 * A move start carrying an input event (wheel, drag, pinch) is the user
 * moving the view and always stops following; so does one without (minimap,
 * toolbar, shortcut), except the opening fit of a canvas that loads after
 * following started and before the first alignment.
 * @param input - The awareness, the leader, readiness and the viewport commands.
 * @returns The move-start handler.
 */
export function useCanvasFollow(input: CanvasFollowInput): CanvasFollowResult {
  const { awareness, leaderUserId, ready } = input;
  const latest = React.useRef(input);
  latest.current = input;
  const applying = React.useRef(false);
  const aligned = React.useRef(false);
  // The leader camera last applied, kept for a refit when this pane changes size.
  const last = React.useRef<{ rect: FlowRect; at: number } | null>(null);

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
    };
    align();
    awareness.on('change', align);
    return (): void => {
      awareness.off('change', align);
      aligned.current = false;
      last.current = null;
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
    // The canvas framing itself on open is not the user moving the view.
    const programmatic = event === null || event === undefined;
    if (!aligned.current && programmatic && latest.current.openingFitPending()) return;
    stopFollowing();
    aligned.current = false;
    last.current = null;
  }, []);

  return React.useMemo((): CanvasFollowResult => ({ onMoveStart }), [onMoveStart]);
}
