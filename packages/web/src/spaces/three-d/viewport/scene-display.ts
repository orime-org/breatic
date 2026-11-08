// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

import type { SceneObject } from '@breatic/shared';

import type { SceneRemotePeer } from '@web/spaces/three-d/viewport/scene-viewport-props';

/**
 * The values each object is drawn with (inner#1692, design 5.4 and 7.3): a
 * collaborator's drag shows on the real model while it lasts, as a drag does
 * on the canvas (#2010); this page's own drag and a locked object keep their
 * values, and identity and attributes always stay the document's.
 * @param objects - The committed objects, in document order.
 * @param localGestureIds - Objects this page is dragging, drawn from its own draft.
 * @param remotePeers - Collaborators, in the session's order; the last gesture on an object wins.
 * @returns One value per object, in document order.
 */
export function displayedObjects(
  objects: readonly SceneObject[],
  localGestureIds: ReadonlySet<string>,
  remotePeers: readonly SceneRemotePeer[],
): SceneObject[] {
  const dragged = new Map<string, SceneObject>();
  for (const peer of remotePeers) for (const value of peer.gesture ?? []) dragged.set(value.id, value);
  return objects.map((object) => {
    const value = dragged.get(object.id);
    if (value === undefined || object.locked || localGestureIds.has(object.id)) return object;
    const { pose: _pose, ...committed } = object;
    return { ...committed, position: value.position, rotation: value.rotation, scale: value.scale,
      ...(value.pose === undefined ? {} : { pose: value.pose }) };
  });
}
