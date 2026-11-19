// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * A generation template placed for an external agent (#1488 §8) through the
 * planning and placing the generate panel's apply uses: on a node already on
 * the canvas, or on a new node of the template's anchor type placed where new
 * nodes go, the whole flow kept clear of what is there. Ids derive from the
 * call, so a second delivery finds the flow as the template's own and adds nothing.
 */

import * as Y from "yjs";
import type { LastView } from "@collab/services/last-view-cache.js";
import {
  GENERATION_TEMPLATES,
  callScopedId,
  templateAnchor,
  type AgentCommand,
  type AgentCommandParams,
  type AgentCommandRefusal,
  type GenerationTemplate,
  type ModelEntry,
} from "@breatic/shared";
import {
  EMPTY_NODE_SIZE,
  ROW_GAP_PX,
  addNodeInDoc,
  canvasNodesMap,
  createEmptyNode,
  groupRectForMembers,
  placeProposalInDoc,
  planTemplateApply,
  readEdges,
  readNodes,
  shiftRightPastOccupied,
  standsEmpty,
  type TemplateApplyPlan,
} from "@breatic/shared/canvas-model";
import type { Answer, Json } from "@collab/services/agent-commands/commands.js";
import { newNodesAim, typeOf } from "@collab/services/agent-commands/canvas-commands.js";

/** The slot of the new anchor among the call's ids. */
const ANCHOR_SLOT = "template:anchor";

/**
 * Refuse a command.
 * @param reason - Why.
 * @returns The answer.
 */
function refuse(reason: AgentCommandRefusal): Answer {
  return { status: "rejected", reason };
}

/**
 * The id a proposal index takes under this call.
 * @param command - The command.
 * @param index - The index.
 * @returns Its id.
 */
const nodeIdOf = (command: AgentCommand, index: number): string => callScopedId(command.callId, `template:${String(index)}`);

/**
 * Plan the template on a canvas, mapping each refusal to the command's.
 * @param template - The template.
 * @param doc - The canvas, holding the anchor.
 * @param anchorId - The anchor.
 * @param models - The template's model entries.
 * @returns The plan, or the refusal.
 */
function planOn(template: GenerationTemplate, doc: Y.Doc, anchorId: string, models: readonly ModelEntry[]): TemplateApplyPlan | Answer {
  const plan = planTemplateApply(template, { nodes: readNodes(doc), edges: readEdges(doc) }, anchorId, models);
  if (!("reason" in plan)) return plan;
  return refuse(plan.reason === "model_unavailable" ? "invalid_command" : plan.reason === "group_locked" ? "locked" : plan.reason);
}

/**
 * The template's resource nodes this call placed, or found standing empty,
 * that the ingest Worker is to fetch into, as the browser's apply hands them over.
 * @param doc - The canvas.
 * @param plan - The plan placed.
 * @param nodeIds - The node at each index.
 * @param fresh - Whether each index was placed new.
 * @returns Each node and the template resource it takes.
 */
function resourcesOf(doc: Y.Doc, plan: TemplateApplyPlan, nodeIds: readonly string[], fresh: readonly boolean[]): Array<{ nodeId: string; resource: string }> {
  const views = new Map(readNodes(doc).map((node) => [node.id, node]));
  return plan.proposal.nodes.flatMap((node, i) => {
    const id = nodeIds[i];
    if (node.resource === undefined || !id) return [];
    return fresh[i] || standsEmpty(views.get(id)) ? [{ nodeId: id, resource: node.resource }] : [];
  });
}

/**
 * Where a new anchor goes so the whole flow it grows lands clear: the flow is
 * laid out around an anchor at the origin on a scratch canvas, aimed where
 * new nodes go, and moved right past what is there.
 * @param template - The template.
 * @param anchor - The new anchor, at the origin.
 * @param models - The template's model entries.
 * @param doc - The canvas.
 * @param view - What the user has on screen on this canvas.
 * @param userId - Who places it.
 * @returns The anchor's top-left, or the refusal.
 */
function anchorSpot(
  template: GenerationTemplate,
  anchor: ReturnType<typeof createEmptyNode>,
  models: readonly ModelEntry[],
  doc: Y.Doc,
  view: LastView | undefined,
  userId: string,
): { x: number; y: number } | Answer {
  const scratch = new Y.Doc();
  addNodeInDoc(scratch, anchor);
  const plan = planOn(template, scratch, anchor.id, models);
  if ("status" in plan) return plan;
  const { rects } = placeProposalInDoc(scratch, { proposal: plan.proposal, start: { x: 0, y: 0 }, occupied: [], existing: plan.existing, order: plan.order, userId, entryOf: () => undefined });
  const footprint = groupRectForMembers(rects, 0) ?? { x: 0, y: 0, ...EMPTY_NODE_SIZE };
  const { centre, occupied } = newNodesAim(doc, view);
  const dx = centre.x - (footprint.x + footprint.width / 2);
  const dy = centre.y - (footprint.y + footprint.height / 2);
  const aimed = { ...footprint, x: footprint.x + dx, y: footprint.y + dy };
  return { x: dx + shiftRightPastOccupied(aimed, occupied, ROW_GAP_PX), y: dy };
}

/**
 * Apply a generation template, as the generate panel's apply does.
 * @param doc - The canvas document.
 * @param params - The command's parameters.
 * @param command - The command.
 * @param view - What the user has on screen on this canvas, when they are on it.
 * @returns The answer: the node at each index of the flow, the anchor first, and the resource nodes to fetch into.
 */
export function applyGenerationTemplate(doc: Y.Doc, params: AgentCommandParams<"apply_generation_template">, command: AgentCommand, view?: LastView): Answer {
  const template = GENERATION_TEMPLATES.find((one) => one.id === params.templateId);
  if (!template) return refuse("not_found");
  const models = params.models as unknown as ModelEntry[];
  const anchorType = templateAnchor(template).type;
  const nodesMap = canvasNodesMap(doc);
  let anchorId = params.nodeId;
  if (anchorId === undefined) {
    anchorId = callScopedId(command.callId, ANCHOR_SLOT);
    if (!nodesMap.has(anchorId)) {
      const anchor = { ...createEmptyNode(anchorType, { x: 0, y: 0 }, command.userId), id: anchorId };
      const spot = anchorSpot(template, anchor, models, doc, view, command.userId);
      if ("status" in spot) return spot;
      addNodeInDoc(doc, { ...anchor, position: spot });
    }
  } else if (typeOf(doc, anchorId) === undefined) {
    return refuse("not_found");
  } else if (typeOf(doc, anchorId) !== anchorType) {
    return refuse("invalid_command");
  }
  const plan = planOn(template, doc, anchorId, models);
  if ("status" in plan) return plan;
  const ids = { node: (index: number): string => nodeIdOf(command, index), group: callScopedId(command.callId, "template:group") };
  // A second delivery of this call finds the nodes the first one placed as
  // the template's own, so it places nothing new and writes the same values.
  const placed = placeProposalInDoc(doc, {
    proposal: plan.proposal,
    start: { x: 0, y: 0 },
    occupied: [],
    existing: plan.existing,
    order: plan.order,
    userId: command.userId,
    ids,
    entryOf: (model) => models.find((one) => one.name === model),
  });
  const result = {
    nodeIds: placed.nodeIds,
    ...(placed.groupId === undefined ? {} : { groupId: placed.groupId }),
    resources: resourcesOf(doc, plan, placed.nodeIds, placed.fresh),
    toFill: plan.toFill,
  };
  return { status: "done", result: result as unknown as Json };
}
