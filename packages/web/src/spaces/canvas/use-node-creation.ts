// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import * as React from 'react';

import {
  newId,
  promptPlainText,
  proposalMarkSegments,
  type CanvasProposal,
} from '@breatic/shared';

import {
  addEdge,
  addNode,
  createGroup,
  getPromptFragment,
  getTextBody,
  readNodeCorners,
  runCanvasUndoBatch,
  setGroupBackground,
  setNodeMode,
  setNodeModel,
  setNodeName,
} from '@web/data/yjs/canvas-space';
import { setStoryboardShots } from '@web/data/yjs/node-storyboard';
import { writePlainTextIntoBody } from '@breatic/shared/canvas/text-body';
import { writeProposalPrompt } from '@web/spaces/canvas/generate/proposal-prompt';
import { planFlowLayout, type Spot } from '@web/spaces/canvas/lib/place-flow';
import {
  cloneForPaste,
  stepPastOccupied,
  textToNode,
  type ClipboardNode,
} from '@web/spaces/canvas/node-clipboard';
import {
  centerToTopLeft,
  createEmptyNode,
  createGroupNode,
  type CreatableNodeType,
} from '@web/spaces/canvas/node-factory';
import { groupBackgroundFor } from '@web/spaces/canvas/group-background';
import {
  EMPTY_NODE_SIZE,
  groupRectForMembers,
  toRelativePosition,
} from '@web/spaces/canvas/group-geometry';
import { useCurrentUserStore } from '@web/stores/current-user';
import { canvasApi } from '@web/data/api/canvas';
import { ApiException } from '@web/data/api/types';
import { useTranslation } from '@web/i18n/use-translation';
import { toast } from '@web/lib/toast';
import { ingestRefusalToastKey } from '@web/spaces/canvas/upload-failure';

/** A node an upload just created: its id and the top-left it was written at. */
export interface CreatedUploadNode {
  id: string;
  position: { x: number; y: number };
}

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
   *
   * Reports the top-left it wrote alongside the id, so a batch that becomes a
   * Group frames itself around where its members actually are.
   */
  createUploadNodeAt: (
    type: CreatableNodeType,
    position: { x: number; y: number },
  ) => CreatedUploadNode;
  /**
   * Paste plain text as a new text node CENTRED on a point, stepped past any
   * node already on that spot; returns its id. The pasted text becomes the
   * node's content.
   */
  pasteTextAt: (text: string, position: { x: number; y: number }) => string;
  /**
   * Paste cloned clipboard nodes (fresh ids, positions shifted by `offset`
   * so relative layout is preserved, then the whole batch stepped past any
   * node already where one of them would land); returns the new node ids in
   * order.
   * The duplicate path (which can re-home a clone into an existing Group +
   * grow it) is orchestrated by the canvas, not here.
   */
  pasteNodesAt: (
    nodes: ReadonlyArray<ClipboardNode>,
    offset: { dx: number; dy: number },
  ) => string[];
  /**
   * How far a paste whose nodes would land at `corners` (their top-lefts, in
   * flow coordinates) steps down and right past the nodes already on this
   * Space. Every paste goes through it (inner#1235 A20).
   */
  stepPaste: (corners: ReadonlyArray<{ x: number; y: number }>) => { dx: number; dy: number };
  /**
   * Place a whole proposed flow around a point, wired and configured.
   * One press is ONE undo entry: a half-placed flow -- nodes without their
   * wires, or a generation node still on whatever mode it defaults to -- is
   * worse than no flow at all.
   */
  placeProposalAt: (proposal: CanvasProposal, start: Spot) => PlacedProposal;
}

/** What a placed proposal left on the canvas. */
export interface PlacedProposal {
  /** The new node ids, in the proposal's own order. */
  nodeIds: string[];
  /** The group they landed in, when there were two or more of them. */
  groupId?: string;
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
  const t = useTranslation();
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
    ): CreatedUploadNode => {
      const topLeft = centerToTopLeft(position, EMPTY_NODE_SIZE);
      const node = createEmptyNode(type, topLeft, userId);
      addNode(projectId, spaceId, node);
      return { id: node.id, position: topLeft };
    },
    [projectId, spaceId, userId],
  );
  // Every paste steps past the nodes already on its spot, so it shows
  // (inner#1235 A20). The spot is read from the document, so a paste made a
  // moment ago counts before it has rendered.
  const stepPaste = React.useCallback(
    (corners: ReadonlyArray<{ x: number; y: number }>): { dx: number; dy: number } =>
      stepPastOccupied(corners, readNodeCorners(projectId, spaceId)),
    [projectId, spaceId],
  );
  const pasteTextAt = React.useCallback(
    (text: string, position: { x: number; y: number }): string => {
      const topLeft = centerToTopLeft(position, EMPTY_NODE_SIZE);
      const step = stepPaste([topLeft]);
      const node = textToNode(
        text,
        { x: topLeft.x + step.dx, y: topLeft.y + step.dy },
        userId,
      );
      addNode(projectId, spaceId, node);
      return node.id;
    },
    [projectId, spaceId, userId, stepPaste],
  );
  const pasteNodesAt = React.useCallback(
    (
      nodes: ReadonlyArray<ClipboardNode>,
      offset: { dx: number; dy: number },
    ): string[] => {
      // Clipboard positions are absolute, Group members included, so each one
      // plus the offset is where that node will be painted.
      const step = stepPaste(
        nodes.map((node) => ({ x: node.position.x + offset.dx, y: node.position.y + offset.dy })),
      );
      const cloned = cloneForPaste(nodes, userId, {
        dx: offset.dx + step.dx,
        dy: offset.dy + step.dy,
      });
      // One paste is ONE undo entry — a group + its members (or a multi-node
      // selection) must undo as a unit, not node-by-node (mirrors the duplicate
      // path's batch).
      runCanvasUndoBatch(projectId, spaceId, () => {
        cloned.forEach((node) => addNode(projectId, spaceId, node));
      });
      // `cloneForPaste` keeps the payload's order, so a clone sits at its
      // source's index.
      nodes.forEach((source, i) => {
        const target = cloned[i];
        if (source.external !== true || source.content === undefined || target === undefined) {
          return;
        }
        canvasApi
          .ingestUrl({
            url: source.content,
            project_id: projectId,
            space_id: spaceId,
            node_id: target.id,
          })
          .catch((err: unknown) => {
            toast.error(t(ingestRefusalToastKey(err instanceof ApiException ? err.status : undefined)));
          });
      });
      return cloned.map((node) => node.id);
    },
    [projectId, spaceId, userId, t, stepPaste],
  );
  const placeProposalAt = React.useCallback(
    (proposal: CanvasProposal, start: Spot): PlacedProposal => {
      const spots = planFlowLayout(proposal, start);
      const nodeIds: string[] = [];
      let groupId: string | undefined;
      runCanvasUndoBatch(projectId, spaceId, () => {
        proposal.nodes.forEach((node, i) => {
          const at = spots[i] ?? { x: start.x, y: start.y };
          // `createNodeAt` centres what it is given on the standard footprint,
          // so the arrangement's top-left is handed over as that centre --
          // otherwise every node lands half a footprint up and to the left of
          // where the group was measured around it.
          const id = createNodeAt(node.type, {
            x: at.x + EMPTY_NODE_SIZE.width / 2,
            y: at.y + EMPTY_NODE_SIZE.height / 2,
          });
          nodeIds.push(id);
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
        // Two or more nodes are one piece of work, and a group is how the
        // canvas says so -- a name and a ground of its own, rather than a
        // handful of nodes the reader has to work out the relation between.
        // Built from the arrangement's own rects: the nodes were written a
        // moment ago and the render buffer has not seen them yet, so anything
        // reading that buffer would find no members and quietly make nothing.
        const rect = nodeIds.length > 1 ? groupRectForMembers(spots) : null;
        if (rect) {
          const id = newId();
          createGroup(
            projectId,
            spaceId,
            createGroupNode(id, { x: rect.x, y: rect.y }, rect.width, rect.height, userId),
            nodeIds.map((member, i) => ({
              id: member,
              position: toRelativePosition(spots[i] ?? rect, rect),
            })),
          );
          if (proposal.groupName) setNodeName(projectId, spaceId, id, proposal.groupName);
          setGroupBackground(projectId, spaceId, id, groupBackgroundFor(Math.random()));
          groupId = id;
        }
        proposal.edges.forEach((edge) => {
          const source = nodeIds[edge.fromIndex];
          const target = nodeIds[edge.toIndex];
          // Indices that point nowhere are refused before a card is ever drawn
          // (`checkProposal`); skipping rather than throwing keeps the rest of
          // the flow from being rolled back by one bad wire.
          if (source && target) {
            addEdge(projectId, spaceId, {
              id: `${source}->${target}`,
              source,
              target,
            });
          }
        });
        // Words last, once every node and edge is in place.
        proposal.nodes.forEach((node, i) => {
          const id = nodeIds[i];
          if (!id) return;
          if (node.role === 'written') {
            // A written node's words are its body, not a prompt: nothing
            // generates there, and the body is what the reader reads and edits.
            const body = getTextBody(projectId, spaceId, id);
            if (body && node.prompt) writePlainTextIntoBody(body, promptPlainText(node.prompt));
            return;
          }
          if (!node.mode) return;
          // A model drawing no prompt box shows nothing written there; the card
          // lists its marks instead.
          if (node.takesPrompt === false) return;
          // The main prompt goes into the proposal's own mode (#2218), then
          // each shot.
          const fragment = getPromptFragment(projectId, spaceId, id, node.mode);
          if (fragment && node.prompt) writeProposalPrompt(fragment, node.prompt);
          if (node.shots) {
            const shotFragments = setStoryboardShots(projectId, spaceId, id, node.shots.map((shot) => shot.duration));
            node.shots.forEach((shot, k) => {
              const target = shotFragments[k];
              if (target) writeProposalPrompt(target, shot.prompt);
            });
          }
        });
      });
      // A mark is something the reader still does. Saying so is all: what
      // they leave as it is goes out as it is (inner#977). Where no prompt box
      // is drawn nothing was written, and the card is where the marks are.
      const marked = proposal.nodes.some(
        (node) => node.takesPrompt !== false && proposalMarkSegments(node).some((segment) => segment.slot),
      );
      if (marked) toast.info(t('canvas.generatePanel.editMarks'));
      return groupId === undefined ? { nodeIds } : { nodeIds, groupId };
    },
    [projectId, spaceId, createNodeAt, userId, t],
  );
  return {
    createNodeAt,
    createUploadNodeAt,
    pasteTextAt,
    pasteNodesAt,
    stepPaste,
    placeProposalAt,
  };
}
