// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Following a video node's shots from a React component.
 *
 * The shots are not part of the node view, so the video panel subscribes to
 * them here: a shot added, removed or brought back, or a shot's seconds, here
 * or from a collaborator, produces a fresh read. Words typed inside a shot do
 * not: the shot's box is bound to that fragment and edits it in place, and the
 * submit reads the words off the fragment itself.
 */

import * as React from 'react';
import * as Y from 'yjs';

import { readShots, shotListOf, type StoryboardShotView } from '@web/data/yjs/node-storyboard';

/**
 * A video node's shots, kept current.
 * @param projectId - Project the canvas space belongs to.
 * @param spaceId - Canvas space containing the node.
 * @param nodeId - The video node.
 * @returns The shots, or null when the node has no list of them.
 */
export function useShots(projectId: string, spaceId: string, nodeId: string): StoryboardShotView[] | null {
  const [version, setVersion] = React.useState(0);
  React.useEffect(() => {
    const shots = shotListOf(projectId, spaceId, nodeId);
    if (!shots) return undefined;
    /**
     * Ask for a fresh read, unless every change was words inside a shot.
     * @param events - The changes of one transaction.
     */
    const bump = (events: Array<Y.YEvent<Y.AbstractType<unknown>>>): void => {
      if (events.every((event) => isPromptText(event.target))) return;
      setVersion((v) => v + 1);
    };
    shots.observeDeep(bump);
    // Read again once subscribed: a change landing between the render-time
    // read and this effect produced no event this hook heard.
    setVersion((v) => v + 1);
    return () => shots.unobserveDeep(bump);
  }, [projectId, spaceId, nodeId]);
  return React.useMemo(
    () => readShots(projectId, spaceId, nodeId),
    // `version` is the change signal; the read itself goes to the document.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [projectId, spaceId, nodeId, version],
  );
}

/**
 * Whether a changed type is part of a shot's prompt rather than the list.
 * @param target - The type a change happened on.
 * @returns True for a prompt fragment and anything inside one.
 */
function isPromptText(target: Y.AbstractType<unknown>): boolean {
  return target instanceof Y.XmlFragment || target instanceof Y.XmlElement || target instanceof Y.XmlText;
}
