// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Placing a proposed flow on a canvas document, for every writer that places
 * one: the browser (an Agent proposal, an applied template) and collab (an
 * external agent's template, #1488 §8). The caller runs it inside one
 * transaction and owns undo, rollback and the size gate.
 */

import * as Y from 'yjs';
import { withStandInOn } from '@shared/canvas/dialogue.js';
import { currentModelName } from '@shared/canvas/retired-models.js';
import { writePlainTextIntoBody } from '@shared/canvas/text-body.js';
import { nodeDataMap, readEdges, readNodePlacementsInDoc, readNodes } from '@shared/canvas/model/canvas-read.js';
import {
  addEdgeInDoc,
  addNodeInDoc,
  createGroupInDoc,
  expandGroupInDoc,
  restoreNodeMediaInDoc,
  setGroupBackgroundInDoc,
  setNodeModeInDoc,
  setNodeModelInDoc,
  setNodeNameInDoc,
  setNodeParentInDoc,
  setNodeTemplateNodeInDoc,
} from '@shared/canvas/model/canvas-write.js';
import { groupBackgroundFor } from '@shared/canvas/model/group-background.js';
import { EMPTY_NODE_SIZE, groupRectForMembers, planGroupGrowth, toRelativePosition, type Rect } from '@shared/canvas/model/group-geometry.js';
import { createEmptyNode, createGroupNode } from '@shared/canvas/model/node-factory.js';
import { planFlowLayout, ROW_GAP_PX, shiftRightPastOccupied, withTaskCounts, type Spot } from '@shared/canvas/model/place-flow.js';
import { proposalMentionOf, writeDialogueLines, writeProposalPrompt, type MentionOf, type ProposalMention } from '@shared/canvas/model/proposal-prompt.js';
import { writeProposalFillsInDoc } from '@shared/canvas/model/slot-fill.js';
import { setStoryboardShotsInDoc } from '@shared/canvas/model/storyboard-shots.js';
import { newId } from '@shared/ids.js';
import { promptPlainText, type CanvasProposal } from '@shared/types/canvas-proposal.js';
import { PANEL_EDITOR_PARAM } from '@shared/types/generate-panel.js';
import type { ModelEntry } from '@shared/types/model-catalog.js';

/** A proposal index that stands for a node already on the canvas. */
export interface ExistingNode {
  nodeId: string;
  /** How a ref to it is written: as its reference row names it. */
  mention: ProposalMention;
  /** Its params by model, written whole when the proposal sets its mode and model. */
  paramsByModel?: Record<string, Record<string, unknown>>;
  /** True for a node of the template instance being applied, reused from an earlier apply. */
  instance?: boolean;
}

/** Where a proposal's new nodes go, and the group they join or make. */
interface Arrangement {
  /** Each index's top-left and size; meaningful for new nodes only. */
  spots: Rect[];
  /** Where a proposal placed on its own landed: its group's rect, or the one node's. */
  bounds?: Rect;
  /** Where a new group goes, for two or more new nodes that join no group already there. */
  aimedGroup: Rect | null;
  /** The unlocked group already on the canvas the new nodes join. */
  joinGroup?: { id: string; rect: Rect };
}

/**
 * Where a proposal's new nodes go. On its own, the flow is aimed at `start`
 * and moved right past `occupied`. Around nodes already there, it is lined up
 * on the anchor's real position, or on a reused instance node's when the new
 * nodes join that node's group, even where that covers other nodes: they work
 * on the same thing.
 * @param doc - The canvas document.
 * @param proposal - The proposal.
 * @param start - Where a proposal placed on its own is aimed.
 * @param occupied - What a proposal placed on its own must not cover.
 * @param existing - The indices already on the canvas.
 * @param order - Each index's rank within its column, as {@link planFlowLayout} takes it.
 * @returns The arrangement.
 */
function arrangeProposal(
  doc: Y.Doc,
  proposal: CanvasProposal,
  start: Spot,
  occupied: readonly Rect[],
  existing: ReadonlyMap<number, ExistingNode>,
  order?: readonly number[],
): Arrangement {
  if (existing.size === 0) {
    const aimed = planFlowLayout(proposal, start, order);
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
      aimedGroup: aimedGroup && { ...aimedGroup, x: aimedGroup.x + dx },
    };
  }
  const views = new Map(readNodes(doc).map((node) => [node.id, node]));
  // The edges already on the canvas between the nodes the proposal reuses
  // decide their columns too, so a new node feeding a reused one lands left
  // of it. Laid out only: the canvas has them already.
  const indexOf = new Map([...existing].map(([index, node]) => [node.nodeId, index]));
  const wired = readEdges(doc).flatMap((edge) => {
    const fromIndex = indexOf.get(edge.source);
    const toIndex = indexOf.get(edge.target);
    return fromIndex === undefined || toIndex === undefined ? [] : [{ fromIndex, toIndex }];
  });
  const aimed = planFlowLayout({ ...proposal, edges: [...proposal.edges, ...wired] }, { x: 0, y: 0 }, order);
  const anchorIndex = Math.min(...existing.keys());
  const anchorId = existing.get(anchorIndex)?.nodeId;
  const placements = readNodePlacementsInDoc(doc);
  /**
   * The unlocked group a node sits in.
   * @param nodeId - The node.
   * @returns The group's id and rect, or undefined when it sits in none or in a locked one.
   */
  const unlockedGroupOf = (nodeId: string | undefined): { id: string; rect: Rect } | undefined => {
    const parentId = nodeId === undefined ? undefined : views.get(nodeId)?.parentId;
    const group = parentId === undefined ? undefined : placements.find((p) => p.id === parentId);
    const groupView = group === undefined ? undefined : views.get(group.id);
    if (!group || groupView?.type !== 'group' || groupView.data.locked === true) return undefined;
    return { id: group.id, rect: { x: group.x, y: group.y, width: group.width ?? 0, height: group.height ?? 0 } };
  };
  // The anchor's own group first. An anchor in no unlocked group lends the new
  // nodes the group this template's reused nodes sit in, which a first apply
  // made, so the instance stays one piece the user drags as one. A
  // reference the user wired in keeps its own group to itself.
  const joinGroup = unlockedGroupOf(anchorId)
    ?? [...existing.values()].filter((node) => node.instance === true).map((node) => unlockedGroupOf(node.nodeId)).find((group) => group !== undefined);
  // When a reused node of this instance sits in the group the new nodes join,
  // the flow lines up on it, so a node put back lands in its place in the
  // instance wherever the user has since moved the anchor.
  const alignIndex = (joinGroup
    && [...existing].find(([index, node]) => index !== anchorIndex && node.instance === true && unlockedGroupOf(node.nodeId)?.id === joinGroup.id)?.[0])
    ?? anchorIndex;
  const alignAt = placements.find((p) => p.id === existing.get(alignIndex)?.nodeId) ?? start;
  const cell = aimed[alignIndex] ?? { x: 0, y: 0 };
  const lined = aimed.map((spot) => ({ ...spot, x: spot.x + alignAt.x - cell.x, y: spot.y + alignAt.y - cell.y }));
  const added = lined.filter((_, i) => !existing.has(i));
  const aimedGroup = joinGroup === undefined && added.length > 1 ? groupRectForMembers(added) : null;
  return {
    spots: lined,
    aimedGroup,
    ...(joinGroup ? { joinGroup } : {}),
  };
}

/**
 * A proposal with every node's model under its current name.
 * @param proposal - The proposal as it was sent.
 * @returns The proposal, the same object when no node names a retired model.
 */
export function withCurrentProposalModels(proposal: CanvasProposal): CanvasProposal {
  if (!proposal.nodes.some((node) => node.model !== undefined && currentModelName(node.model) !== node.model)) return proposal;
  return { ...proposal, nodes: proposal.nodes.map((node) => (node.model === undefined ? node : { ...node, model: currentModelName(node.model) })) };
}

/**
 * A node's fragment for one mode, without creating one.
 * @param doc - The canvas document.
 * @param nodeId - The node.
 * @param key - Which per-mode box.
 * @param mode - The mode.
 * @returns The fragment, or null when the node has none for that mode.
 */
function modeFragmentInDoc(doc: Y.Doc, nodeId: string, key: 'prompts' | 'lyrics', mode: string): Y.XmlFragment | null {
  const byMode = nodeDataMap(doc, nodeId)?.get(key);
  const fragment = byMode instanceof Y.Map ? byMode.get(mode) : undefined;
  return fragment instanceof Y.XmlFragment ? fragment : null;
}

/** What placing a proposal is given. */
export interface PlaceProposalInput {
  proposal: CanvasProposal;
  /** Where a proposal placed on its own is aimed. */
  start: Spot;
  /** What a proposal placed on its own must not cover. */
  occupied: readonly Rect[];
  /** The indices that stand for nodes already on the canvas. */
  existing?: ReadonlyMap<number, ExistingNode>;
  /** Each index's rank within its column. */
  order?: readonly number[];
  /** Who places it, who the new nodes are created by. */
  userId: string;
  /** A model's catalog entry, for the params a new generation node starts on. */
  entryOf: (model: string) => ModelEntry | undefined;
  /** The ids the new nodes and group take, for a writer that must place the same flow again under the same ids; fresh ids otherwise. */
  ids?: { node: (index: number) => string; group: string };
}

/** What a placed proposal left on the canvas. */
export interface PlacedProposal {
  /** The node at each index, in the proposal's own order. */
  nodeIds: string[];
  /** The group this placing made for the new nodes, when it made one; unset when they joined a group already there. */
  groupId?: string;
  /** Where a proposal placed on its own landed: its group's rect, or the one node's; unset for a template built on nodes already there. */
  bounds?: Rect;
  /** Each node's rect as laid out, in the proposal's own order; a node already on the canvas is not moved, and its entry is where the layout would put it. */
  rects: Rect[];
}

/**
 * Place a whole proposed flow, wired and configured: new nodes laid out and
 * named, each generation's mode, model, params, fills and words, the template
 * tags, a group for two or more new nodes (or the unlocked group they join),
 * and edges stamped in the proposal's order. Run it inside one transaction.
 * @param doc - The canvas document.
 * @param input - The proposal and where it goes.
 * @returns What it left on the canvas, and whether each index was placed new.
 */
export function placeProposalInDoc(doc: Y.Doc, input: PlaceProposalInput): PlacedProposal & { fresh: boolean[] } {
  // A proposal kept in the chat history may name a model since retired; it
  // lands on the replacement, whose entry decides the dialogue side (#1521).
  const proposal = withCurrentProposalModels(input.proposal);
  const existing = input.existing ?? new Map<number, ExistingNode>();
  const { start } = input;
  const fresh = proposal.nodes.map((_, i) => !existing.has(i));
  const { spots, bounds, aimedGroup, joinGroup } = arrangeProposal(doc, proposal, start, input.occupied, existing, input.order);
  const nodeIds: string[] = proposal.nodes.map((_, i) => existing.get(i)?.nodeId ?? '');
  let groupId: string | undefined;
  proposal.nodes.forEach((node, i) => {
    const settled = existing.get(i);
    if (settled === undefined) {
      const empty = createEmptyNode(node.type, spots[i] ?? { x: start.x, y: start.y }, input.userId);
      const built = input.ids ? { ...empty, id: input.ids.node(i) } : empty;
      addNodeInDoc(doc, built);
      nodeIds[i] = built.id;
      setNodeNameInDoc(doc, built.id, node.name);
      // The user's material, with the numbers its registration holds, the
      // same write a restored result goes through (inner#1315).
      if (node.material !== undefined && node.materialMedia !== undefined) {
        restoreNodeMediaInDoc(doc, built.id, { content: node.material, media: node.materialMedia });
      }
    }
    const id = nodeIds[i]!;
    // Mode and model go together in one write, so a collaborator never sees
    // the proposed mode paired with whatever model the node defaulted to. A
    // source node carries neither. A node already on the canvas keeps its
    // records for other models.
    if (node.mode && node.model && (settled === undefined || node.role === 'generate')) {
      const params = settled?.paramsByModel ?? { [node.model]: withStandInOn(input.entryOf(node.model), node.params ?? {}) };
      setNodeModeInDoc(doc, id, node.mode, node.model, params);
      // And record it as a choice: written only as a mode switch it is
      // forgotten the moment the user looks at another mode and comes back.
      setNodeModelInDoc(doc, id, node.mode, node.model, params);
    }
  });
  // Two or more new nodes are one piece of work, and a group is how the
  // canvas says so. Only the new nodes become members: an anchor or a reused
  // node already on the canvas stays where it is.
  if (aimedGroup) {
    const id = input.ids?.group ?? newId();
    groupId = id;
    createGroupInDoc(
      doc,
      createGroupNode(id, { x: aimedGroup.x, y: aimedGroup.y }, aimedGroup.width, aimedGroup.height, input.userId),
      nodeIds.flatMap((member, i) => (fresh[i] ? [{ id: member, position: toRelativePosition(spots[i] ?? aimedGroup, aimedGroup) }] : [])),
    );
    if (proposal.groupName) setNodeNameInDoc(doc, id, proposal.groupName);
    setGroupBackgroundInDoc(doc, id, groupBackgroundFor(Math.random()));
  }
  // Stamped in the proposal's order, strictly increasing, so the reference
  // rail -- which lists a node's edges by when they were drawn -- reads them
  // as the proposal lists them.
  let stamp = Date.now() - 1;
  proposal.edges.forEach((edge) => {
    const source = nodeIds[edge.fromIndex];
    const target = nodeIds[edge.toIndex];
    // Indices that point nowhere are refused before a proposal is ever
    // shown; skipping keeps one bad wire from taking back the rest.
    if (source && target && source !== target) {
      stamp += 1;
      addEdgeInDoc(doc, { id: `${source}->${target}`, source, target, createdAt: stamp });
    }
  });
  proposal.nodes.forEach((node, i) => {
    const tag = node.templateNode;
    const id = nodeIds[i];
    if (tag === undefined || !fresh[i] || !id) return;
    const anchor = tag.anchor === undefined ? undefined : nodeIds[tag.anchor];
    setNodeTemplateNodeInDoc(doc, id, {
      template: tag.template,
      key: tag.key,
      ...(anchor === undefined || anchor === '' ? {} : { anchor }),
      ...(tag.input ? { input: true as const } : {}),
    });
  });
  // Words last, once every node and edge is in place: a ref lands as a
  // mention of the node placed for it (inner#1315), and of a node already
  // there as its reference row names it.
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
    // A reused generation takes its fills too: a template input already
    // holding material lands in its slot this way (inner#1825 §4.1).
    writeProposalFillsInDoc(doc, id, node, proposal.nodes);
    if (node.role === 'written') {
      // A written node's words are its body, not a prompt: nothing generates
      // there, and the body is what the user reads and edits.
      const body = nodeDataMap(doc, id)?.get('body');
      if (body instanceof Y.XmlFragment && node.prompt) writePlainTextIntoBody(body, promptPlainText(node.prompt));
      return;
    }
    if (!node.mode) return;
    // Words sent into a song model's lyrics box are @'d there, the way the
    // user would @ them, and nowhere else; one line each, so two mentions
    // never send their words run together.
    const lyrics = proposal.edges.filter((edge) => edge.toIndex === i && edge.into === PANEL_EDITOR_PARAM);
    const lyricsBox = lyrics.length > 0 ? modeFragmentInDoc(doc, id, 'lyrics', node.mode) : null;
    const lyricsLines = lyrics.flatMap((edge, k) => (k === 0 ? [{ ref: edge.fromIndex }] : [{ text: '\n' }, { ref: edge.fromIndex }]));
    if (lyricsBox) writeProposalPrompt(lyricsBox, lyricsLines, mentionOf);
    // A model drawing no prompt box shows nothing written there.
    if (node.takesPrompt === false) return;
    // The main prompt goes into the proposal's own mode (#2218), then each shot.
    const fragment = modeFragmentInDoc(doc, id, 'prompts', node.mode);
    if (fragment && node.prompt) writeProposalPrompt(fragment, node.prompt, mentionOf);
    if (fragment && node.lines) writeDialogueLines(fragment, node.lines, mentionOf);
    if (node.shots) {
      const shotFragments = setStoryboardShotsInDoc(doc, id, node.shots.map((shot) => shot.duration));
      node.shots.forEach((shot, k) => {
        const target = shotFragments[k];
        if (target) writeProposalPrompt(target, shot.prompt, mentionOf);
      });
    }
  });
  // The new nodes join that group last, and its frame grows to keep its
  // padding around them.
  if (joinGroup) {
    const added = proposal.nodes.flatMap((_, i) => (fresh[i] && spots[i] ? [{ id: nodeIds[i]!, rect: spots[i] }] : []));
    for (const { id, rect } of added) {
      setNodeParentInDoc(doc, id, joinGroup.id, { x: rect.x - joinGroup.rect.x, y: rect.y - joinGroup.rect.y });
    }
    for (const growth of planGroupGrowth([{ groupId: joinGroup.id, rect: joinGroup.rect, memberRects: added.map((one) => one.rect) }])) {
      expandGroupInDoc(doc, growth.groupId, growth.position, growth.width, growth.height);
    }
  }
  return {
    nodeIds,
    ...(groupId === undefined ? {} : { groupId }),
    ...(bounds === undefined ? {} : { bounds }),
    rects: proposal.nodes.map((_, i) => spots[i] ?? { x: start.x, y: start.y, ...EMPTY_NODE_SIZE }),
    fresh,
  };
}
