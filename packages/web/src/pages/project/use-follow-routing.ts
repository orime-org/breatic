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
  /** Whether the strip's latest change was an open this hook asked for. */
  byFollow: boolean;
  /** Opens a Space's tab, or switches to it, marking the change as following's. */
  open: (spaceId: string) => void;
}

/**
 * Take the follower's tab to the Space the leader has in front (#920), and
 * stop following when the user changes the tab in front themselves.
 *
 * Every change of the leader's Space to one this project has is passed on as
 * an open; the strip applies them in order and ignores an open of the tab
 * already in front, so a leader going A -> B -> A lands on A however the
 * renders fall. A Space this project does not have, or none at all, leaves the
 * tab where it is. Whether a change of the tab in front was the user's is read
 * off the strip itself: it stops following when the user made it (`persist`)
 * and it was not one of these opens (`byFollow`), once the strip has landed.
 * A Space deleted from under the user moves the tab without `persist` and
 * keeps following. Modelled on `useCanvasRevealRouting`.
 * @param input - The current state; see `FollowRoutingInput`.
 */
export function useFollowRouting(input: FollowRoutingInput): void {
  const { following, leaderSpaceId, spaces, activeId, ready, persist, byFollow, open } = input;
  // The leader Space already acted on while following; undefined until the first.
  const routed = React.useRef<string | null | undefined>(undefined);
  React.useEffect(() => {
    if (!following) {
      routed.current = undefined;
      return;
    }
    if (leaderSpaceId === routed.current) return;
    if (leaderSpaceId === null) {
      routed.current = null;
      return;
    }
    // Not yet (or no longer) in this project: judged again when the Spaces change.
    if (!spaces.some((space) => space.id === leaderSpaceId)) return;
    const first = routed.current === undefined;
    routed.current = leaderSpaceId;
    // Following that starts on the leader's Space has nothing to open.
    if (first && leaderSpaceId === activeId) return;
    open(leaderSpaceId);
  }, [following, leaderSpaceId, spaces, activeId, open]);

  // The tab in front and whether the strip had landed, as of the previous render.
  const last = React.useRef({ activeId, ready });
  React.useEffect(() => {
    const was = last.current;
    last.current = { activeId, ready };
    if (!following || was.activeId === activeId) return;
    if (persist && was.ready && !byFollow) useFollowStore.getState().stop('space');
  }, [following, activeId, ready, persist, byFollow]);
}
