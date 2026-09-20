// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import * as React from 'react';

import type { CanvasProposal } from '@breatic/shared';

import {
  addEdge,
  addNode,
  getPromptFragment,
  runCanvasUndoBatch,
  setNodeMode,
  setNodeModel,
  setNodeName,
} from '@web/data/yjs/canvas-space';
import {
  writeProposalPrompt,
  type ProposalFeeders,
  type ProposalSource,
} from '@web/spaces/canvas/generate/proposal-prompt';
import { placeLeftToRight, type Spot } from '@web/spaces/canvas/lib/place-group';
import {
  cloneForPaste,
  textToNode,
  type ClipboardNode,
} from '@web/spaces/canvas/node-clipboard';
import {
  centerToTopLeft,
  createEmptyNode,
  type CreatableNodeType,
} from '@web/spaces/canvas/node-factory';
import { EMPTY_NODE_SIZE } from '@web/spaces/canvas/group-geometry';
import { useCurrentUserStore } from '@web/stores/current-user';

export interface NodeCreation {
  /**
   * Create an empty node of `type` CENTRED on a canvas point and return its id.
   * The caller (canvas) supplies the drop point (viewport centre for the
   * library, cursor for right-click / drag-drop); the node is placed centred on
   * it (top-left = point − {@link EMPTY_NODE_SIZE}/2).
   */
  createNodeAt: (
    type: CreatableNodeType,
    position: { x: number; y: number },
  ) => string;
  /**
   * Create a media node for an in-flight upload, CENTRED on the drop point.
   * What it ends up holding arrives from the server once the upload's task
   * settles (#186 §3.4); the caller writes nothing onto it.
   */
  createUploadNodeAt: (
    type: CreatableNodeType,
    position: { x: number; y: number },
  ) => string;
  /**
   * Paste plain text as a new text node CENTRED on a point; returns its id.
   * The pasted text becomes the node's content.
   */
  pasteTextAt: (text: string, position: { x: number; y: number }) => string;
  /**
   * Paste cloned clipboard nodes (fresh ids, positions shifted by `offset`
   * so relative layout is preserved); returns the new node ids in order.
   * The duplicate path (which can re-home a clone into an existing Group +
   * grow it) is orchestrated by the canvas, not here.
   */
  pasteNodesAt: (
    nodes: ReadonlyArray<ClipboardNode>,
    offset: { dx: number; dy: number },
  ) => string[];
  /**
   * Place a whole proposed group starting at a point, wired and configured.
   * Returns the new node ids in the proposal's own order, so the caller can
   * select the one that generates. One press is ONE undo entry: a half-placed
   * group -- nodes without their wires, or a generation node still on whatever
   * mode it defaults to -- is worse than no group at all.
   */
  placeProposalAt: (proposal: CanvasProposal, start: Spot) => string[];
}

/** How far apart two neighbours of a placed group sit, left to right. */
const GROUP_STEP_PX = 360;

/**
 * What is wired into one node of a proposal, in the order placed.
 *
 * These are what its prompt's marks mention, one each in order, so what the
 * generation reads reaches it without the reader making the mention by hand.
 * Two lists, because the two kinds of mark point at different things: an asset
 * mark at an empty node still to be filled, a ref mark at a node already
 * carrying work.
 *
 * Read off the node list rather than the edge list: the marks are numbered by
 * the nodes the reader sees left to right, and nothing makes a proposal list
 * its edges in that same order -- listed the other way round, each bracket
 * would carry the other node's name.
 * @param proposal - The whole proposal.
 * @param index - Which of its nodes is being fed.
 * @param ids - The placed node ids, in the proposal's own order.
 * @returns The two lists, each in placement order.
 * @throws {never} Never.
 */
function feedersOf(
  proposal: CanvasProposal,
  index: number,
  ids: readonly string[],
): ProposalFeeders {
  const fedFrom = new Set(
    proposal.edges.filter((edge) => edge.toIndex === index).map((edge) => edge.fromIndex),
  );
  const sources: ProposalSource[] = [];
  const upstream: ProposalSource[] = [];
  proposal.nodes.forEach((node, at) => {
    const id = ids[at];
    if (!fedFrom.has(at) || !id) return;
    // What the reader still has to fill goes in one list, what already carries
    // work in the other: an asset mark draws from the first and a ref mark
    // from the second, and one list would have them taking each other's turn.
    (node.role === 'source' ? sources : upstream).push({ id, kind: node.type });
  });
  return { sources, upstream };
}

/**
 * Canvas node-creation core — composes the empty-node factory with the
 * frontend-owned Yjs `addNode` write. Kept as a hook (not inline in the
 * canvas) so the create path stays unit-testable without mounting ReactFlow:
 * the `createdBy` is read here from the current-user store, the only piece
 * the pure factory cannot supply.
 * @param projectId - Owning project id.
 * @param spaceId - Canvas space id.
 * @returns The `createNodeAt` action bound to this project / space.
 */
export function useNodeCreation(
  projectId: string,
  spaceId: string,
): NodeCreation {
  const userId = useCurrentUserStore((s) => s.user?.id) ?? '';
  // Every create drop centres the new node on the given point (its top-left =
  // point − EMPTY_NODE_SIZE/2) so it appears centred where the user dropped it,
  // not offset to the bottom-right. Consistent across the library (viewport
  // centre), right-click create, drag-drop, and text paste.
  const createNodeAt = React.useCallback(
    (type: CreatableNodeType, position: { x: number; y: number }): string => {
      const node = createEmptyNode(
        type,
        centerToTopLeft(position, EMPTY_NODE_SIZE),
        userId,
      );
      addNode(projectId, spaceId, node);
      return node.id;
    },
    [projectId, spaceId, userId],
  );
  const createUploadNodeAt = React.useCallback(
    (
      type: CreatableNodeType,
      position: { x: number; y: number },
    ): string => {
      const node = createEmptyNode(
        type,
        centerToTopLeft(position, EMPTY_NODE_SIZE),
        userId,
      );
      addNode(projectId, spaceId, node);
      return node.id;
    },
    [projectId, spaceId, userId],
  );
  const pasteTextAt = React.useCallback(
    (text: string, position: { x: number; y: number }): string => {
      const node = textToNode(
        text,
        centerToTopLeft(position, EMPTY_NODE_SIZE),
        userId,
      );
      addNode(projectId, spaceId, node);
      return node.id;
    },
    [projectId, spaceId, userId],
  );
  const pasteNodesAt = React.useCallback(
    (
      nodes: ReadonlyArray<ClipboardNode>,
      offset: { dx: number; dy: number },
    ): string[] => {
      const cloned = cloneForPaste(nodes, userId, offset);
      // One paste is ONE undo entry — a group + its members (or a multi-node
      // selection) must undo as a unit, not node-by-node (mirrors the duplicate
      // path's batch).
      runCanvasUndoBatch(projectId, spaceId, () => {
        cloned.forEach((node) => addNode(projectId, spaceId, node));
      });
      return cloned.map((node) => node.id);
    },
    [projectId, spaceId, userId],
  );
  const placeProposalAt = React.useCallback(
    (proposal: CanvasProposal, start: Spot): string[] => {
      const spots = placeLeftToRight(proposal.nodes.length, start, GROUP_STEP_PX);
      const ids: string[] = [];
      runCanvasUndoBatch(projectId, spaceId, () => {
        proposal.nodes.forEach((node, i) => {
          const id = createNodeAt(node.type, spots[i] ?? start);
          ids.push(id);
          setNodeName(projectId, spaceId, id, node.name);
          // Mode and model go together in one write, so a collaborator never
          // sees the proposed mode paired with whatever model the node
          // defaulted to. A source node carries neither -- it is the empty
          // place the reader drops their own material into.
          if (node.mode && node.model) {
            const params = { [node.model]: node.params ?? {} };
            setNodeMode(projectId, spaceId, id, node.mode, node.model, params);
            // And record it as a choice. The agent picked this model on the
            // reader's behalf; written only as a mode switch it is forgotten
            // the moment they look at another mode and come back.
            setNodeModel(projectId, spaceId, id, node.mode, node.model, params);
          }
        });
        proposal.edges.forEach((edge) => {
          const source = ids[edge.fromIndex];
          const target = ids[edge.toIndex];
          // Indices that point nowhere are refused before a card is ever drawn
          // (`checkProposal`); skipping rather than throwing keeps the rest of
          // the group from being rolled back by one bad wire.
          if (source && target) {
            addEdge(projectId, spaceId, {
              id: `${source}->${target}`,
              source,
              target,
            });
          }
        });
        // Prompts last: an asset spot mentions the empty node feeding it, so
        // the wiring has to be settled before the mentions are written.
        proposal.nodes.forEach((node, i) => {
          const id = ids[i];
          if (!id || !node.prompt) return;
          const fragment = getPromptFragment(projectId, spaceId, id);
          if (!fragment) return;
          writeProposalPrompt(fragment, node.prompt, feedersOf(proposal, i, ids));
        });
      });
      return ids;
    },
    [projectId, spaceId, createNodeAt],
  );
  return {
    createNodeAt,
    createUploadNodeAt,
    pasteTextAt,
    pasteNodesAt,
    placeProposalAt,
  };
}
