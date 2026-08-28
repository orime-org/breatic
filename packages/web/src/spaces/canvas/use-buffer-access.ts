// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import * as React from 'react';
import type { Node } from '@xyflow/react';

import type { DocumentPlace } from '@web/spaces/canvas/doc-geometry-view';
import {
  docGeometryView,
  landingCandidates,
} from '@web/spaces/canvas/doc-geometry-view';
import type { GestureTable } from '@web/spaces/canvas/gesture-table';
import { heldIds, speaksFor } from '@web/spaces/canvas/gesture-table';

/** The ways the canvas may read its own render buffer. */
export interface BufferAccess {
  /**
   * The buffer with every remote gesture's geometry back where the document
   * has it. Everything that turns buffer geometry into a document write reads
   * this one.
   */
  settled: () => Node[];
  /**
   * Those of `settled`'s nodes no remote gesture is holding, for a set that
   * exists to produce writes — one per entry. A planner that draws conclusions
   * from a node's absence needs `settled` instead, and is told separately which
   * of those nodes may take part.
   */
  landing: () => Node[];
  /**
   * The nodes as the document has them.
   *
   * A resize computes each member's new position from the document rather than
   * from the buffer: the buffer's copy of a member depends on whose gesture is
   * running and when it started, while the document holds one number that every
   * client agrees on, collaborators' finished moves included.
   */
  documentPlaces: () => ReadonlyArray<DocumentPlace>;
  /**
   * The ids remote gestures are holding right now, judged against the document:
   * an entry that rode in on a Group holds nothing once the document has taken
   * the node out of that Group.
   */
  heldByRemote: () => ReadonlySet<string>;
  /**
   * The Groups a remote is RESIZING, out of those it is holding.
   *
   * A resize moves no member, so it commits each member's stored position minus
   * its whole travel — which lands right only if that position was measured
   * against the Group's document origin. A drag carries its members along
   * instead, so the two need telling apart.
   */
  resizedByRemote: () => ReadonlySet<string>;
  /**
   * The buffer as the canvas is drawing it this instant, in-flight geometry
   * included. This is what the gesture field publishes, which is the one thing
   * that is supposed to carry those coordinates.
   */
  onScreen: () => ReadonlyArray<Node>;
}

/**
 * Hold the render buffer and hand out the readings the canvas is allowed.
 *
 * The buffer is what the canvas draws, and while a collaborator drags something
 * it holds that collaborator's in-flight coordinates. Several paths read
 * geometry out of it on their way to writing the document — a Group growing
 * around its members, a resize absorbing a loose node, a new Group sizing
 * itself, a duplicate growing the Group it lands in. Any of those reading the
 * raw buffer would commit somebody else's moving coordinates, where they stay
 * (#2010, design §5.7 and invariant 7).
 *
 * The buffer lives in here so that reading it means picking one of these by
 * name. Each of the three writing readings answers a different question, and
 * the fourth says in its own name that it is the screen rather than the
 * document.
 *
 * The refs are written in the commit phase, which is as early as React lets a
 * component observe its own render. A gesture callback runs inside the pointer
 * event, before that commit, so mid-gesture these hold the previous frame —
 * what matters is that the broadcast and the document write read the same one,
 * and that the last frame is committed by the time the release lands in a
 * later task.
 * @param flowNodes - The render buffer this frame.
 * @param docNodes - The nodes as the document has them, mapped for the buffer.
 * @param remoteGesture - The nodes remote gestures are currently moving.
 * @returns The readings, stable for the life of the canvas.
 */
export function useBufferAccess(
  flowNodes: ReadonlyArray<Node>,
  docNodes: ReadonlyArray<DocumentPlace>,
  remoteGesture: GestureTable,
): BufferAccess {
  const nodesRef = React.useRef<ReadonlyArray<Node>>(flowNodes);
  const docRef = React.useRef<ReadonlyArray<DocumentPlace>>(docNodes);
  const gestureRef = React.useRef<GestureTable>(remoteGesture);
  React.useLayoutEffect(() => {
    nodesRef.current = flowNodes;
    docRef.current = docNodes;
    gestureRef.current = remoteGesture;
  }, [flowNodes, docNodes, remoteGesture]);
  return React.useMemo((): BufferAccess => {
    /**
     * The buffer with remote gestures put back at their document places.
     * @returns The settled view.
     */
    const settled = (): Node[] =>
      docGeometryView(nodesRef.current, docRef.current, gestureRef.current);
    return {
      settled,
      landing: (): Node[] => landingCandidates(settled(), gestureRef.current),
      documentPlaces: (): ReadonlyArray<DocumentPlace> => docRef.current,
      heldByRemote: (): ReadonlySet<string> =>
        heldIds(gestureRef.current, docRef.current),
      resizedByRemote: (): ReadonlySet<string> => {
        // Only a resize publishes a size, so carrying one is what marks it.
        const resizing = new Set<string>();
        const byId = new Map(docRef.current.map((node) => [node.id, node]));
        for (const [id, geometry] of gestureRef.current) {
          const node = byId.get(id);
          if (geometry.width === undefined || node === undefined) continue;
          if (speaksFor(geometry, node)) resizing.add(id);
        }
        return resizing;
      },
      onScreen: (): ReadonlyArray<Node> => nodesRef.current,
    };
  }, []);
}
