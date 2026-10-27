// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import * as React from 'react';
import * as Y from 'yjs';

import {
  CANVAS_NODES_KEY,
  newId,
  PANEL_EDITOR_PARAM,
  promptPlainText,
  proposalMarkSegments,
  type CanvasProposal,
} from '@breatic/shared';

import {
  addEdge,
  addNode,
  createCanvasRollback,
  createGroup,
  expandGroup,
  getLyricsFragment,
  getPromptFragment,
  getTextBody,
  CANVAS_ROLLED_BACK,
  readCanvasGraph,
  readNodePlacements,
  restoreNodeMedia,
  runCanvasUndoBatch,
  setGroupBackground,
  setNodeMode,
  setNodeModel,
  setNodeName,
  setNodeParent,
  setNodeTemplateNode,
  writeSnapshotNodes,
  type CanvasNodeView,
  type SnapshotNode,
} from '@web/data/yjs/canvas-space';
import { docName, getDoc, hasDoc } from '@web/data/yjs/manager';
import { setStoryboardShots } from '@web/data/yjs/node-storyboard';
import { writePlainTextIntoBody } from '@breatic/shared/canvas/text-body';
import { writeProposalFills } from '@web/spaces/canvas/generate/proposal-fills';
import {
  proposalMentionOf,
  writeProposalPrompt,
  type MentionOf,
  type ProposalMention,
} from '@web/spaces/canvas/generate/proposal-prompt';
import {
  ROW_GAP_PX,
  planFlowLayout,
  shiftRightPastOccupied,
  withTaskCounts,
  type Spot,
} from '@web/spaces/canvas/lib/place-flow';
import {
  cloneForPaste,
  stepPastOccupied,
  textToNode,
  type ClipboardPayload,
  type CloneOptions,
} from '@web/spaces/canvas/node-clipboard';
import { collectAddresses, historyItems, replaceAddresses } from '@web/spaces/canvas/paste-addresses';
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
  planGroupGrowth,
  toRelativePosition,
  type Rect,
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

/** Options for {@link NodeCreation.pastePayload}. */
export interface PastePayloadOptions extends CloneOptions {
  /** Runs inside the paste's undo step, after the clones are written. */
  afterWrite?: (clones: ReadonlyArray<SnapshotNode>, idMap: ReadonlyMap<string, string>) => void;
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
   * Paste or duplicate a clipboard payload (inner#1349): clone it shifted by
   * `offset`, register what it names in this Studio and write each copy's
   * history (the request is skipped only when there is no address to register
   * and no history to write), then write the clones and edges in one undo
   * step, stepped past nodes already where they land — the step is read at
   * write time, so two pastes made before either answered do not stack.
   * Resolves to the new node ids, or null when the registration request fails
   * (a toast says so, with the server's reason when it gave one) or the Space
   * went away first.
   */
  pastePayload: (
    payload: ClipboardPayload,
    offset: { dx: number; dy: number },
    options?: PastePayloadOptions,
  ) => Promise<string[] | null>;
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
   * worse than no flow at all. The flow is aimed at `start` and moved right
   * past `occupied` until it covers none of it (inner#1443). With `existing`,
   * the proposal is a template landing around nodes already on the canvas
   * (inner#1345): those indices are written over rather than placed, the new
   * nodes line up left of the anchor (the lowest existing index) and move
   * left past `occupied`, and they join the anchor's group when it is
   * unlocked. If a write fails part way, everything this press wrote is taken
   * back, out of undo history, and the error is rethrown.
   * @throws {Error} When a write fails part way; nothing is left on the canvas
   *   or in undo history.
   */
  placeProposalAt: (
    proposal: CanvasProposal,
    start: Spot,
    occupied: readonly Rect[],
    existing?: ReadonlyMap<number, ExistingNode>,
  ) => PlacedProposal;
}

/** A proposal index that stands for a node already on the canvas. */
export interface ExistingNode {
  nodeId: string;
  /** How a ref to it is written: as its reference row names it. */
  mention: ProposalMention;
  /** Its params by model, written whole when the proposal sets its mode and model. */
  paramsByModel?: Record<string, Record<string, unknown>>;
}

/** Where a proposal's new nodes go, and the group they join or make. */
interface Arrangement {
  /** Each index's top-left and size; meaningful for new nodes only. */
  spots: Rect[];
  /** Where the batch landed, for a proposal placed on its own. */
  bounds?: Rect;
  /** The rect of a new group, for two or more nodes placed on their own. */
  aimedGroup: Rect | null;
  /** The unlocked group around the anchor the new nodes join. */
  joinGroup?: { id: string; rect: Rect };
}

/**
 * Where a proposal's new nodes go. On its own, the flow is aimed at `start`
 * and moved right past `occupied`. Around nodes already there, it is lined up
 * on the anchor's real position, so the new nodes stand left of it, and moved
 * left as one block past `occupied` -- the same walk, mirrored.
 * @param projectId - Owning project id.
 * @param spaceId - Canvas space id.
 * @param proposal - The proposal.
 * @param start - Where a proposal placed on its own is aimed.
 * @param occupied - What the new nodes must not cover.
 * @param existing - The indices already on the canvas.
 * @returns The arrangement.
 * @throws {never} Never.
 */
function arrangeProposal(
  projectId: string,
  spaceId: string,
  proposal: CanvasProposal,
  start: Spot,
  occupied: readonly Rect[],
  existing: ReadonlyMap<number, ExistingNode>,
): Arrangement {
  if (existing.size === 0) {
    const aimed = planFlowLayout(proposal, start);
    // Two or more nodes land as one group, so the group's rect is what has
    // to be clear; a single node needs only its own.
    const aimedGroup = aimed.length > 1 ? groupRectForMembers(aimed) : null;
    const footprint = aimedGroup ?? aimed[0];
    // The new nodes will hang their own task counts off their corners, so
    // the spot keeps that much clear too: the group's frame, and each node
    // with its counts, as nodes already there are counted.
    const searched = groupRectForMembers([...(aimedGroup ? [aimedGroup] : []), ...aimed.map(withTaskCounts)], 0);
    const dx = searched ? shiftRightPastOccupied(searched, occupied, ROW_GAP_PX) : 0;
    return {
      spots: aimed.map((spot) => ({ ...spot, x: spot.x + dx })),
      ...(footprint ? { bounds: { ...footprint, x: footprint.x + dx } } : {}),
      aimedGroup,
    };
  }
  const graph = readCanvasGraph(projectId, spaceId);
  const views = new Map(graph.nodes.map((node) => [node.id, node]));
  // The edges already on the canvas between the nodes the proposal reuses
  // decide their columns too, so a new node feeding a reused one lands left
  // of it. Laid out only: the canvas has them already.
  const indexOf = new Map([...existing].map(([index, node]) => [node.nodeId, index]));
  const wired = graph.edges.flatMap((edge) => {
    const fromIndex = indexOf.get(edge.source);
    const toIndex = indexOf.get(edge.target);
    return fromIndex === undefined || toIndex === undefined ? [] : [{ fromIndex, toIndex }];
  });
  const aimed = planFlowLayout({ ...proposal, edges: [...proposal.edges, ...wired] }, { x: 0, y: 0 });
  const anchorIndex = Math.min(...existing.keys());
  const anchorId = existing.get(anchorIndex)?.nodeId;
  const placements = readNodePlacements(projectId, spaceId);
  const anchorAt = placements.find((p) => p.id === anchorId) ?? start;
  const cell = aimed[anchorIndex] ?? { x: 0, y: 0 };
  const lined = aimed.map((spot) => ({ ...spot, x: spot.x + anchorAt.x - cell.x, y: spot.y + anchorAt.y - cell.y }));
  const added = lined.filter((_, i) => !existing.has(i));
  const searched = groupRectForMembers(added.map(withTaskCounts), 0);
  // Mirrored, a walk to the right is a walk to the left.
  /**
   * A rect reflected across the vertical axis.
   * @param r - The rect.
   * @returns It, mirrored.
   */
  const mirror = (r: Rect): Rect => ({ ...r, x: -(r.x + r.width) });
  const back = searched ? shiftRightPastOccupied(mirror(searched), occupied.map(mirror), ROW_GAP_PX) : 0;
  const spots = lined.map((spot) => ({ ...spot, x: spot.x - back }));
  const anchorView = anchorId === undefined ? undefined : views.get(anchorId);
  const group = anchorView?.parentId === undefined ? undefined : placements.find((p) => p.id === anchorView.parentId);
  const groupView = group === undefined ? undefined : views.get(group.id);
  const unlocked = groupView?.type === 'group' && groupView.data.locked !== true;
  return {
    spots,
    aimedGroup: null,
    ...(group && unlocked
      ? { joinGroup: { id: group.id, rect: { x: group.x, y: group.y, width: group.width ?? 0, height: group.height ?? 0 } } }
      : {}),
  };
}

/**
 * Whether a node holds nothing yet and nothing is fetching or generating into it.
 * @param view - The node.
 * @returns Whether it stands empty.
 */
export function standsEmpty(view: CanvasNodeView | undefined): boolean {
  if (!view || view.type === 'group' || view.type === 'annotation') return false;
  return (view.data as { content?: unknown }).content === undefined && (view.data.taskCounts?.running ?? 0) === 0;
}

/**
 * Hands every template resource node this press placed, or found still empty
 * with nothing fetching into it, to the ingest Worker -- after the batch,
 * never inside it, so a refused fetch cannot take the batch back.
 * @param projectId - Owning project id.
 * @param spaceId - Canvas space id.
 * @param proposal - The proposal placed.
 * @param nodeIds - The node at each index.
 * @param fresh - Whether each index was placed by this press.
 * @param refused - Says a refused fetch, by message key.
 * @throws {never} Never; a refusal is said through `refused`.
 */
function fetchTemplateResources(
  projectId: string,
  spaceId: string,
  proposal: CanvasProposal,
  nodeIds: readonly string[],
  fresh: readonly boolean[],
  refused: (key: string) => void,
): void {
  const views = readCanvasGraph(projectId, spaceId).nodes;
  proposal.nodes.forEach((node, i) => {
    const id = nodeIds[i];
    if (node.resource === undefined || !id) return;
    if (!fresh[i] && !standsEmpty(views.find((n) => n.id === id))) return;
    canvasApi
      .ingestUrl({ template_resource: node.resource, project_id: projectId, space_id: spaceId, node_id: id })
      .catch((err: unknown) => {
        refused(ingestRefusalToastKey(err instanceof ApiException ? err.status : undefined));
      });
  });
}

/** What a placed proposal left on the canvas. */
export interface PlacedProposal {
  /** The new node ids, in the proposal's own order. */
  nodeIds: string[];
  /** The group they landed in, when there were two or more of them. */
  groupId?: string;
  /** Where the batch landed: the group's rect, or the one node's. */
  bounds?: Rect;
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
      stepPastOccupied(corners, readNodePlacements(projectId, spaceId)),
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
  const pastePayload = React.useCallback(
    async (
      payload: ClipboardPayload,
      offset: { dx: number; dy: number },
      options: PastePayloadOptions = {},
    ): Promise<string[] | null> => {
      const cloned = cloneForPaste(payload, userId, offset, options);
      // An external clone carries no address yet (cloneForPaste drops it), so
      // it adds nothing here; its fetch into storage follows the write.
      const addresses = collectAddresses(cloned.nodes);
      const history = historyItems(cloned.nodes);
      let nodes: SnapshotNode[] = cloned.nodes;
      if (addresses.urls.length > 0 || addresses.pairs.length > 0 || history.length > 0) {
        try {
          const { map } = await canvasApi.paste({
            project_id: projectId,
            urls: addresses.urls,
            pairs: addresses.pairs,
            history,
          });
          nodes = replaceAddresses(nodes, new Map(Object.entries(map)));
        } catch (err) {
          toast.error(err instanceof ApiException && err.fromServer ? err.message : t('canvas.paste.failed'));
          return null;
        }
      }
      // A paste waits on the server; a Space closed meanwhile is not written.
      if (!hasDoc(docName.canvasSpace(projectId, spaceId))) return null;
      const doc = getDoc(docName.canvasSpace(projectId, spaceId));
      const nodesMap = doc.getMap<Y.Map<unknown>>(CANVAS_NODES_KEY);
      const placed = stepClones(
        nodes,
        cloned.idMap,
        options.externalParentAbs ?? new Map(),
        (id) => liveGroup(nodesMap, id),
        stepPaste,
      );
      runCanvasUndoBatch(projectId, spaceId, () => {
        writeSnapshotNodes(doc, placed, cloned.edges);
        options.afterWrite?.(placed, cloned.idMap);
      });
      for (const source of payload.nodes) {
        const target = cloned.idMap.get(source.id);
        const url = source.data.content;
        if (source.external !== true || typeof url !== 'string' || target === undefined) continue;
        canvasApi
          .ingestUrl({ url, project_id: projectId, space_id: spaceId, node_id: target })
          .catch((err: unknown) => {
            toast.error(t(ingestRefusalToastKey(err instanceof ApiException ? err.status : undefined)));
          });
      }
      return placed.map((node) => node.id);
    },
    [projectId, spaceId, userId, t, stepPaste],
  );
  const placeProposalAt = React.useCallback(
    (
      proposal: CanvasProposal,
      start: Spot,
      occupied: readonly Rect[],
      existing: ReadonlyMap<number, ExistingNode> = new Map(),
    ): PlacedProposal => {
      const fresh = proposal.nodes.map((_, i) => !existing.has(i));
      const arrangement = arrangeProposal(projectId, spaceId, proposal, start, occupied, existing);
      const { spots, bounds, aimedGroup, joinGroup } = arrangement;
      const nodeIds: string[] = proposal.nodes.map((_, i) => existing.get(i)?.nodeId ?? '');
      let groupId: string | undefined;
      // Takes back everything this press writes when a write fails part way.
      // The failed transaction is marked so the canvas undo manager skips it,
      // and the rollback's own undo is an origin that manager does not track,
      // so the reader's undo history holds no trace of either.
      const rollback = createCanvasRollback(projectId, spaceId);
      try {
        runCanvasUndoBatch(projectId, spaceId, (tr) => {
          try {
            proposal.nodes.forEach((node, i) => {
              const settled = existing.get(i);
              if (settled === undefined) {
                const at = spots[i] ?? { x: start.x, y: start.y };
                // `createNodeAt` centres what it is given on the standard
                // footprint, so the arrangement's top-left is handed over as
                // that centre -- otherwise every node lands half a footprint up
                // and to the left of where the group was measured around it.
                const id = createNodeAt(node.type, {
                  x: at.x + EMPTY_NODE_SIZE.width / 2,
                  y: at.y + EMPTY_NODE_SIZE.height / 2,
                });
                nodeIds[i] = id;
                setNodeName(projectId, spaceId, id, node.name);
                // The reader's material, with the numbers its registration
                // holds, the same write a restored result goes through
                // (inner#1315). The tool answers with both or neither.
                if (node.material !== undefined && node.materialMedia !== undefined) {
                  restoreNodeMedia(projectId, spaceId, id, { content: node.material, media: node.materialMedia });
                }
              }
              const id = nodeIds[i];
              // Mode and model go together in one write, so a collaborator never
              // sees the proposed mode paired with whatever model the node
              // defaulted to. A source node carries neither. A node already on
              // the canvas keeps its records for other models.
              if (node.mode && node.model && (settled === undefined || node.role === 'generate')) {
                const params = settled?.paramsByModel ?? { [node.model]: node.params ?? {} };
                setNodeMode(projectId, spaceId, id, node.mode, node.model, params);
                // And record it as a choice: written only as a mode switch it
                // is forgotten the moment they look at another mode and come back.
                setNodeModel(projectId, spaceId, id, node.mode, node.model, params);
              }
            });
            // Two or more new nodes are one piece of work, and a group is how
            // the canvas says so. Built from the arrangement's own rects: the
            // nodes were written a moment ago and the render buffer has not
            // seen them yet. A template landing around nodes already there
            // makes no group of its own; it joins the anchor's.
            const rect = aimedGroup && bounds;
            if (rect) {
              const id = newId();
              groupId = id;
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
            }
            // Stamped in the proposal's order, strictly increasing, so the
            // reference rail -- which lists a node's edges by when they were
            // drawn -- reads them as the proposal lists them.
            let stamp = Date.now() - 1;
            proposal.edges.forEach((edge) => {
              const source = nodeIds[edge.fromIndex];
              const target = nodeIds[edge.toIndex];
              // Indices that point nowhere are refused before a card is ever
              // drawn (`checkProposal`); skipping rather than throwing keeps the
              // rest of the flow from being rolled back by one bad wire.
              if (source && target) {
                stamp += 1;
                addEdge(projectId, spaceId, { id: `${source}->${target}`, source, target, createdAt: stamp });
              }
            });
            proposal.nodes.forEach((node, i) => {
              const tag = node.templateNode;
              const id = nodeIds[i];
              if (tag === undefined || !fresh[i] || !id) return;
              const anchor = tag.anchor === undefined ? undefined : nodeIds[tag.anchor];
              setNodeTemplateNode(projectId, spaceId, id, {
                template: tag.template,
                key: tag.key,
                ...(anchor === undefined || anchor === '' ? {} : { anchor }),
              });
            });
            // Words last, once every node and edge is in place: a ref lands as
            // a mention of the node placed for it (inner#1315), and of a node
            // already there as its reference row names it.
            const placedMention = proposalMentionOf(proposal, nodeIds);
            /**
             * What a ref at an index mentions.
             * @param index - The proposal index.
             * @returns The mention, or undefined when nothing is there.
             */
            const mentionOf: MentionOf = (index) => existing.get(index)?.mention ?? placedMention(index);
            proposal.nodes.forEach((node, i) => {
              const id = nodeIds[i];
              if (!id) return;
              // A node already there that does not generate keeps what it holds.
              if (!fresh[i] && node.role !== 'generate') return;
              if (fresh[i]) writeProposalFills(projectId, spaceId, id, node, proposal.nodes);
              if (node.role === 'written') {
                // A written node's words are its body, not a prompt: nothing
                // generates there, and the body is what the reader reads and edits.
                const body = getTextBody(projectId, spaceId, id);
                if (body && node.prompt) writePlainTextIntoBody(body, promptPlainText(node.prompt));
                return;
              }
              if (!node.mode) return;
              // Words sent into a song model's lyrics box are @'d there, the way
              // the reader would @ them, and nowhere else.
              const lyrics = proposal.edges.filter((edge) => edge.toIndex === i && edge.into === PANEL_EDITOR_PARAM);
              const lyricsBox = lyrics.length > 0 ? getLyricsFragment(projectId, spaceId, id, node.mode) : null;
              // One line each, the way a reader @'ing them by hand would: two
              // mentions on one line send their words run together.
              const lyricsLines = lyrics.flatMap((edge, k) =>
                k === 0 ? [{ ref: edge.fromIndex }] : [{ text: '\n' }, { ref: edge.fromIndex }],
              );
              if (lyricsBox) writeProposalPrompt(lyricsBox, lyricsLines, mentionOf);
              // A model drawing no prompt box shows nothing written there; the
              // card lists its marks instead.
              if (node.takesPrompt === false) return;
              // The main prompt goes into the proposal's own mode (#2218), then
              // each shot.
              const fragment = getPromptFragment(projectId, spaceId, id, node.mode);
              if (fragment && node.prompt) writeProposalPrompt(fragment, node.prompt, mentionOf);
              if (node.shots) {
                const shotFragments = setStoryboardShots(projectId, spaceId, id, node.shots.map((shot) => shot.duration));
                node.shots.forEach((shot, k) => {
                  const target = shotFragments[k];
                  if (target) writeProposalPrompt(target, shot.prompt, mentionOf);
                });
              }
            });
            // The new nodes join the anchor's group last, and its frame grows
            // to keep its padding around them.
            if (joinGroup) {
              const added = proposal.nodes.flatMap((_, i) => (fresh[i] && spots[i] ? [{ id: nodeIds[i], rect: spots[i] }] : []));
              for (const { id, rect } of added) {
                setNodeParent(projectId, spaceId, id, joinGroup.id, { x: rect.x - joinGroup.rect.x, y: rect.y - joinGroup.rect.y });
              }
              for (const growth of planGroupGrowth([{ groupId: joinGroup.id, rect: joinGroup.rect, memberRects: added.map((one) => one.rect) }])) {
                expandGroup(projectId, spaceId, growth.groupId, growth.position, growth.width, growth.height);
              }
            }
          } catch (error) {
            tr.meta.set(CANVAS_ROLLED_BACK, true);
            throw error;
          }
        });
      } catch (error) {
        rollback.undo();
        throw error;
      } finally {
        rollback.destroy();
      }
      fetchTemplateResources(projectId, spaceId, proposal, nodeIds, fresh, (key) => toast.error(t(key)));
      // Words in braces are the reader's to write. Saying so is all: what
      // they leave as it is goes out as it is (inner#977). A proposal's
      // references land as mentions and its notes show in the box, so only
      // braces are left to point at (inner#1315). Where no prompt box is drawn
      // nothing was written, and the card is where the marks are.
      const toFill = proposal.nodes.some(
        (node) => node.takesPrompt !== false && proposalMarkSegments(node).some((segment) => segment.slot?.kind === 'tweak'),
      );
      if (toFill) toast.info(t('canvas.generatePanel.editProposalMarks'));
      return {
        nodeIds,
        ...(groupId === undefined ? {} : { groupId }),
        ...(bounds === undefined ? {} : { bounds }),
      };
    },
    [projectId, spaceId, createNodeAt, userId, t],
  );
  return {
    createNodeAt,
    createUploadNodeAt,
    pasteTextAt,
    pastePayload,
    stepPaste,
    placeProposalAt,
  };
}

/** An existing Group as it is in the document when a paste writes. */
interface LiveGroup {
  position: { x: number; y: number };
  locked: boolean;
}

/**
 * Settle a paste's clones where they land, at write time. A lone member
 * rejoins its existing Group only while that Group is in the document and
 * unlocked, measured where the Group is now; otherwise the copy goes to the
 * top level at the canvas position it had inside the Group. Then every clone
 * is measured where it is painted (inner#1235 A20), so a member of a cloned
 * Group landing on a taken spot steps the batch too; only the nodes that sit
 * on the canvas by themselves move — top-level clones and lone members
 * rejoining an existing Group — and members of a cloned Group follow it.
 * @param clones - The clones.
 * @param idMap - Source id → clone id.
 * @param externalParentAbs - Where each existing Group was when the copy was made.
 * @param groupNow - An existing Group as the document holds it now, or undefined once it is gone.
 * @param stepPaste - How far a batch at these corners steps.
 * @returns The clones at their final positions.
 */
function stepClones(
  clones: ReadonlyArray<SnapshotNode>,
  idMap: ReadonlyMap<string, string>,
  externalParentAbs: ReadonlyMap<string, { x: number; y: number }>,
  groupNow: (id: string) => LiveGroup | undefined,
  stepPaste: (corners: ReadonlyArray<{ x: number; y: number }>) => { dx: number; dy: number },
): ReadonlyArray<SnapshotNode> {
  const fresh = new Set(idMap.values());
  const nodes = clones.map((node): SnapshotNode => {
    if (node.parentId === undefined || fresh.has(node.parentId)) return node;
    const group = groupNow(node.parentId);
    if (group !== undefined && !group.locked) return node;
    // A clone keeps an existing Group's id only when that Group is in externalParentAbs.
    const parent = group?.position ?? (externalParentAbs.get(node.parentId) as { x: number; y: number });
    const { parentId: _left, ...rest } = node;
    return { ...rest, position: { x: parent.x + node.position.x, y: parent.y + node.position.y } };
  });
  const byId = new Map(nodes.map((node) => [node.id, node]));
  /**
   * Whether a clone sits on the canvas by itself rather than inside a cloned Group.
   * @param node - The clone.
   * @returns True for a top-level clone or a member of an existing Group.
   */
  const moves = (node: SnapshotNode): boolean => node.parentId === undefined || !fresh.has(node.parentId);
  const corners = nodes.map((node) => {
    if (node.parentId === undefined) return node.position;
    const parent = byId.get(node.parentId)?.position ?? groupNow(node.parentId)?.position;
    return parent === undefined ? node.position : { x: parent.x + node.position.x, y: parent.y + node.position.y };
  });
  const step = stepPaste(corners);
  if (step.dx === 0 && step.dy === 0) return nodes;
  return nodes.map((node) =>
    moves(node) ? { ...node, position: { x: node.position.x + step.dx, y: node.position.y + step.dy } } : node,
  );
}

/**
 * An existing Group as the document holds it now.
 * @param nodesMap - The canvas `nodesMap`.
 * @param id - The Group's id.
 * @returns Its position and lock, or undefined when it is gone.
 */
function liveGroup(nodesMap: Y.Map<Y.Map<unknown>>, id: string): LiveGroup | undefined {
  const group = nodesMap.get(id);
  if (!(group instanceof Y.Map)) return undefined;
  const data = group.get('data');
  return {
    position: group.get('position') as { x: number; y: number },
    locked: data instanceof Y.Map && data.get('locked') === true,
  };
}
