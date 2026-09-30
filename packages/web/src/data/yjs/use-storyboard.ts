// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Following one mode's storyboard from a React component (#2218).
 *
 * The storyboard is not part of the node view (design §4.1), so the video
 * panel subscribes to it here: any change inside the mode's storyboard map --
 * its tier, a shot added or removed, a shot's seconds or words, here or from
 * a collaborator -- produces a fresh read.
 */

import * as React from 'react';

import { readStoryboard, storyboardMapOf, type StoryboardView } from '@web/data/yjs/node-storyboard';

/**
 * One mode's storyboard, kept current.
 * @param projectId - Project the canvas space belongs to.
 * @param spaceId - Canvas space containing the node.
 * @param nodeId - The video node.
 * @param mode - The video mode.
 * @returns The storyboard, or null when the node or that mode has none.
 */
export function useStoryboard(
  projectId: string,
  spaceId: string,
  nodeId: string,
  mode: string,
): StoryboardView | null {
  const [version, setVersion] = React.useState(0);
  React.useEffect(() => {
    const board = storyboardMapOf(projectId, spaceId, nodeId, mode);
    if (!board) return undefined;
    /** Ask for a fresh read. */
    const bump = (): void => {
      setVersion((v) => v + 1);
    };
    board.observeDeep(bump);
    return () => board.unobserveDeep(bump);
  }, [projectId, spaceId, nodeId, mode]);
  return React.useMemo(
    () => readStoryboard(projectId, spaceId, nodeId, mode),
    // `version` is the change signal; the read itself goes to the document.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [projectId, spaceId, nodeId, mode, version],
  );
}
