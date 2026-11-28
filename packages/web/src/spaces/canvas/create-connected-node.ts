// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-Breatic-Source-Available-2.0

import { addEdge, runCanvasUndoBatch } from '@web/data/yjs/canvas-space';
import type { CreatableNodeType } from '@web/spaces/canvas/node-factory';

/** A point in flow coordinates. */
interface FlowPoint {
  x: number;
  y: number;
}

/** What {@link createConnectedNode} builds. */
export interface CreateConnectedNodeInput {
  /** The project id. */
  projectId: string;
  /** The canvas Space id. */
  spaceId: string;
  /** The node type to create. */
  type: CreatableNodeType;
  /** The new node's centre in flow coordinates. */
  center: FlowPoint;
  /** The upstream node ids, in reference order. */
  sourceIds: readonly string[];
  /** The canvas's node builder; returns the new node's id. */
  createNodeAt: (type: CreatableNodeType, center: FlowPoint) => string;
  /** The clock the first stamp is read from; defaults to `Date.now`. */
  now?: () => number;
}

/** What {@link createConnectedNode} built. */
export interface ConnectedNodeResult {
  /** The new node's id. */
  nodeId: string;
  /** Sources whose wire was not written (removed by a collaborator meanwhile). */
  failedSourceIds: string[];
}

/**
 * Creates a node and wires every given source into it as one undo step: the
 * drag-to-blank menu passes one source, the selection plus passes many
 * (inner#2216). Wires are stamped with strictly rising `createdAt` in the
 * order given, because the reference rail lists a node's wires by when they
 * were drawn and wires written in one millisecond would otherwise fall back
 * to the order of their random ids (`deriveReferences`; the Agent proposal
 * path stamps the same way in `use-node-creation.ts`).
 * @param input - What to build.
 * @returns The new node's id and the sources left unwired, or null when the
 *   Space refused the write (its own toast tells the user).
 * @throws {never} Never.
 */
export function createConnectedNode(input: CreateConnectedNodeInput): ConnectedNodeResult | null {
  const { projectId, spaceId } = input;
  let nodeId = '';
  const failedSourceIds: string[] = [];
  // One add for the size cap: the empty node and its wires.
  const written = runCanvasUndoBatch(projectId, spaceId, { kind: 'add' }, () => {
    nodeId = input.createNodeAt(input.type, input.center);
    const start = (input.now ?? Date.now)();
    input.sourceIds.forEach((source, index) => {
      const added = addEdge(projectId, spaceId, {
        id: `${source}->${nodeId}`,
        source,
        target: nodeId,
        createdAt: start + index,
      });
      if (!added) failedSourceIds.push(source);
    });
  });
  return written.ok ? { nodeId, failedSourceIds } : null;
}
