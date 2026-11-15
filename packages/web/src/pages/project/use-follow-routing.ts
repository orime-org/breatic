// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

import * as React from 'react';

import type { ProjectSpace } from '@web/data/yjs/project-meta';
import { useFollowStore } from '@web/stores/follow';

/** What the project page tells the follow routing on each render. */
export interface FollowRoutingInput {
  /** Whether this user is following a member. */
  following: boolean;
  /** The Space the leader has in front, or null when the leader has none. */
  leaderSpaceId: string | null;
  /** The project's Spaces. */
  spaces: readonly ProjectSpace[];
  /** The Space in front here, if any. */
  activeId: string | null;
  /** Whether the tab strip has landed. */
  ready: boolean;
  /** Whether the latest change of the tab in front was the user's (false when a deleted Space moved it). */
  persist: boolean;
  /** Opens a Space's tab, or switches to it. */
  open: (spaceId: string) => void;
}

/**
 * Take the follower's tab to the Space the leader has in front (#920), and
 * stop following when the user changes the tab in front themselves.
 *
 * The leader's Space is acted on when following starts and each time it
 * changes; a Space this project does not have, or none at all, leaves the tab
 * where it is. A change of the tab in front that is not the one this hook just
 * asked for stops following when the user made it (`persist`), once the tab
 * strip has landed; a Space deleted from under the user moves the tab without
 * `persist` and keeps following. Modelled on `useCanvasRevealRouting`.
 * @param input - The current state; see `FollowRoutingInput`.
 */
export function useFollowRouting(input: FollowRoutingInput): void {
  const { following, leaderSpaceId, spaces, activeId, ready, persist, open } = input;
  // The leader Space already acted on while following, and the tab this hook asked for and is waiting on.
  const routed = React.useRef<string | null | undefined>(undefined);
  const pending = React.useRef<string | null>(null);
  React.useEffect(() => {
    if (!following) {
      routed.current = undefined;
      pending.current = null;
      return;
    }
    if (leaderSpaceId === routed.current) return;
    if (leaderSpaceId === null) {
      routed.current = null;
      return;
    }
    // Not yet (or no longer) in this project: judged again when the Spaces change.
    if (!spaces.some((space) => space.id === leaderSpaceId)) return;
    routed.current = leaderSpaceId;
    if (leaderSpaceId !== activeId) {
      pending.current = leaderSpaceId;
      open(leaderSpaceId);
    }
  }, [following, leaderSpaceId, spaces, activeId, open]);

  // The tab in front and whether the strip had landed, as of the previous render.
  const last = React.useRef({ activeId, ready });
  React.useEffect(() => {
    const was = last.current;
    last.current = { activeId, ready };
    if (!following || was.activeId === activeId) return;
    if (activeId !== null && activeId === pending.current) {
      pending.current = null;
      return;
    }
    if (persist && was.ready) useFollowStore.getState().stop('space');
  }, [following, activeId, ready, persist]);
}
