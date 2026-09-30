// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Following one mode's storyboard from a React component (#2218).
 *
 * The storyboard is not part of the node view (design §4.1), so the video
 * panel subscribes to it here: a change to the mode's storyboard map -- its
 * tier, a shot added, removed or brought back, a shot's seconds, here or from
 * a collaborator -- produces a fresh read. Words typed inside a shot do not:
 * the shot's box is bound to that fragment and edits it in place, and the
 * submit reads the words off the fragment itself.
 */

import * as React from 'react';
import * as Y from 'yjs';

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
    /**
     * Ask for a fresh read, unless every change was words inside a shot.
     * @param events - The changes of one transaction.
     */
    const bump = (events: Array<Y.YEvent<Y.AbstractType<unknown>>>): void => {
      if (events.every((event) => isPromptText(event.target))) return;
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

/**
 * Whether a changed type is part of a shot's prompt rather than the board.
 * @param target - The type a change happened on.
 * @returns True for a prompt fragment and anything inside one.
 */
function isPromptText(target: Y.AbstractType<unknown>): boolean {
  return target instanceof Y.XmlFragment || target instanceof Y.XmlElement || target instanceof Y.XmlText;
}
