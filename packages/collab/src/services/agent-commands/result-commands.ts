// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The first step of an external agent's composite tools (breatic#1488 §6,
 * §9, §10.2): the nodes a result lands on, placed before the MCP service asks
 * the server for the run, the way the browser places them at the press — a
 * model mini-tool's results (web's `start-mini-tool-run.ts`), the text node a
 * reading writes (`start-understand-run.ts`), and the nodes an upload fills
 * (the canvas file drop) — and the check an upload into an existing node
 * passes first.
 */

import * as Y from "yjs";
import type { LastView } from "@collab/services/last-view-cache.js";
import {
  callScopedId,
  type AgentCommand,
  type AgentCommandParams,
  type AgentCommandRefusal,
} from "@breatic/shared";
import { defaultParamsOf, isModelTool, miniToolById } from "@breatic/shared/mini-tools";
import {
  EMPTY_NODE_SIZE,
  ROW_GAP_PX,
  addEdgeInDoc,
  addNodeInDoc,
  batchGroupName,
  batchLayoutAt,
  canvasNodesMap,
  createEmptyNode,
  createGroupInDoc,
  createGroupNode,
  groupBackgroundFor,
  groupRectForMembers,
  nodeDataMap,
  planGroupCreation,
  planMiniToolResultGroup,
  planMiniToolResults,
  resultBaseOf,
  shiftRightPastOccupied,
  understandNodePosition,
  withTaskCounts,
  type StoredPlacement,
} from "@breatic/shared/canvas-model";
import { bodyToPlainText } from "@breatic/shared/canvas/text-body";
import type { Answer, Json } from "@collab/services/agent-commands/commands.js";
import { connectable, edgeIdOf, newNodesAim, ownLocked, typeOf } from "@collab/services/agent-commands/canvas-commands.js";

/** What a reading names its text node, and the node types it reads (web's `READINGS`, `node-understand.ts`). */
const READINGS: Readonly<Record<"understand" | "transcribe", { prefix: string; reads: ReadonlySet<string> }>> = {
  understand: { prefix: "UNDERSTAND-", reads: new Set(["image", "video", "audio"]) },
  transcribe: { prefix: "TRANSCRIBE-", reads: new Set(["audio", "video"]) },
};

/**
 * Refuse a command.
 * @param reason - Why.
 * @returns The answer.
 */
function refuse(reason: AgentCommandRefusal): Answer {
  return { status: "rejected", reason };
}

/**
 * Answer a command as done.
 * @param result - What it did.
 * @returns The answer.
 */
function done(result: Json): Answer {
  return { status: "done", result };
}

/**
 * Where a node is: its stored position and its group's origin.
 * @param doc - The canvas document.
 * @param nodeId - The node.
 * @returns Where it is, or undefined when it is not on the canvas.
 */
function placementOf(doc: Y.Doc, nodeId: string): StoredPlacement | undefined {
  const nodesMap = canvasNodesMap(doc);
  const node = nodesMap.get(nodeId);
  const position = node?.get("position") as { x: number; y: number } | undefined;
  if (!node || !position) return undefined;
  const parentId = node.get("parentId");
  const parent = typeof parentId === "string" ? (nodesMap.get(parentId)?.get("position") as { x: number; y: number } | undefined) : undefined;
  return { position, groupOrigin: parent ?? null };
}

/**
 * A field of a node's data.
 * @param doc - The canvas document.
 * @param nodeId - The node.
 * @param key - The field.
 * @returns Its value.
 */
function dataField(doc: Y.Doc, nodeId: string, key: string): unknown {
  return nodeDataMap(doc, nodeId)?.get(key);
}

/**
 * Whether a node holds something: a file, or a text node's words.
 * @param doc - The canvas document.
 * @param nodeId - The node.
 * @returns True when it does.
 */
function holdsContent(doc: Y.Doc, nodeId: string): boolean {
  const content = dataField(doc, nodeId, "content");
  if (typeof content === "string" && content !== "") return true;
  const body = dataField(doc, nodeId, "body");
  return body instanceof Y.XmlFragment && bodyToPlainText(body) !== "";
}

/**
 * A node's name, when it has one.
 * @param doc - The canvas document.
 * @param nodeId - The node.
 * @returns The name.
 */
function nameOf(doc: Y.Doc, nodeId: string): string | undefined {
  const name = dataField(doc, nodeId, "name");
  return typeof name === "string" ? name : undefined;
}

/**
 * Place a model mini-tool's result nodes a step right of the node it runs
 * on, each wired from it with the tool's id, as the browser builds them at
 * the press. Tools that run in the browser are the agent's own to run on the
 * user's machine, so only server-side model tools are placed here.
 * @param doc - The canvas document.
 * @param params - The command's parameters.
 * @param command - The command.
 * @returns The answer.
 */
export function createMiniToolResults(doc: Y.Doc, params: AgentCommandParams<"create_mini_tool_results">, command: AgentCommand): Answer {
  const spec = miniToolById(params.toolId);
  if (!spec || !isModelTool(spec)) return refuse("invalid_command");
  const at = placementOf(doc, params.sourceNodeId);
  if (!at) return refuse("not_found");
  if (typeOf(doc, params.sourceNodeId) !== spec.source) return refuse("invalid_command");
  // The run's params over the tool's defaults, as the panel's draft starts.
  const runParams = { ...defaultParamsOf(spec), ...params.params };
  const width = dataField(doc, params.sourceNodeId, "mediaWidth");
  const height = dataField(doc, params.sourceNodeId, "mediaHeight");
  const sourceName = nameOf(doc, params.sourceNodeId);
  const planned = planMiniToolResults(
    spec,
    runParams,
    {
      name: sourceName,
      ...(typeof width === "number" ? { width } : {}),
      ...(typeof height === "number" ? { height } : {}),
    },
    resultBaseOf(at),
    command.userId,
  );
  const nodes = planned.nodes.map((node, i) => ({ ...node, id: callScopedId(command.callId, `result:${String(i)}`) }));
  const nodeIds = nodes.map((node) => node.id);
  const nodesMap = canvasNodesMap(doc);
  // Written by an earlier delivery of this call.
  if (nodeIds.every((id) => nodesMap.has(id))) return done({ nodeIds });
  for (const node of nodes) {
    addNodeInDoc(doc, node);
    addEdgeInDoc(doc, { id: edgeIdOf(params.sourceNodeId, node.id), source: params.sourceNodeId, target: node.id, toolId: spec.id });
  }
  if (spec.groupOutputs === true) {
    const group = planMiniToolResultGroup(spec, nodes, planned.placements, sourceName, callScopedId(command.callId, "group"));
    if (group) {
      const { plan, name } = group;
      createGroupInDoc(
        doc,
        createGroupNode(plan.groupId, plan.position, plan.width, plan.height, command.userId, groupBackgroundFor(Math.random()), name),
        plan.members,
      );
    }
  }
  return done({ nodeIds });
}

/**
 * Place the text node an understanding or a transcription writes, a step
 * right of the node it reads and wired from it. The file's format and size
 * are the server's to judge when the run is asked for.
 * @param doc - The canvas document.
 * @param params - The command's parameters.
 * @param command - The command.
 * @returns The answer.
 */
export function createReadingNode(doc: Y.Doc, params: AgentCommandParams<"create_reading_node">, command: AgentCommand): Answer {
  const { sourceNodeId, reading } = params;
  const at = placementOf(doc, sourceNodeId);
  if (!at) return refuse("not_found");
  const type = typeOf(doc, sourceNodeId);
  const content = dataField(doc, sourceNodeId, "content");
  if (type === undefined || !READINGS[reading].reads.has(type) || typeof content !== "string" || content === "") {
    return refuse("invalid_command");
  }
  const nodeId = callScopedId(command.callId, "reading");
  if (canvasNodesMap(doc).has(nodeId)) return done({ nodeId });
  const built = createEmptyNode("text", understandNodePosition(at.position, at.groupOrigin), command.userId);
  const sourceName = nameOf(doc, sourceNodeId);
  addNodeInDoc(doc, {
    ...built,
    id: nodeId,
    data: { ...built.data, ...(sourceName !== undefined ? { name: READINGS[reading].prefix + sourceName } : {}) },
  });
  addEdgeInDoc(doc, { id: edgeIdOf(sourceNodeId, nodeId), source: sourceNodeId, target: nodeId });
  return done({ nodeId });
}

/**
 * Place the empty nodes an upload fills, laid out as a dropped batch is and,
 * for two or more, framed in a Group named for its count. After a node
 * named, they start a step right of it and each is wired from it; otherwise
 * they go where new nodes go when no place is named (§8.2).
 * @param doc - The canvas document.
 * @param params - The command's parameters.
 * @param command - The command.
 * @param view - What the user has on screen on this canvas, when they are on it.
 * @returns The answer.
 */
export function createUploadNodes(doc: Y.Doc, params: AgentCommandParams<"create_upload_nodes">, command: AgentCommand, view?: LastView): Answer {
  const { files, afterNodeId } = params;
  const nodeIds = files.map((_, i) => callScopedId(command.callId, `upload:${String(i)}`));
  const groupId = files.length >= 2 ? callScopedId(command.callId, "group") : undefined;
  const result = { nodeIds, ...(groupId ? { groupId } : {}) };
  let tops: Array<{ x: number; y: number }>;
  if (afterNodeId !== undefined) {
    const at = placementOf(doc, afterNodeId);
    const afterType = typeOf(doc, afterNodeId);
    if (!at || afterType === undefined) return refuse("not_found");
    // Each new node is wired from the one named, under the browser's
    // connection rule.
    if (files.some((file, i) => !connectable(afterNodeId, afterType, nodeIds[i]!, file.type))) return refuse("cannot_connect");
    const slot = resultBaseOf(at);
    tops = batchLayoutAt({ x: slot.x + EMPTY_NODE_SIZE.width / 2, y: slot.y + EMPTY_NODE_SIZE.height / 2 }, files.length).tops;
  } else {
    const { centre, occupied } = newNodesAim(doc, view);
    const layout = batchLayoutAt(centre, files.length);
    const searched = groupRectForMembers(
      [...(layout.frame ? [layout.frame] : []), ...layout.tops.map((top) => withTaskCounts({ ...top, ...EMPTY_NODE_SIZE }))],
      0,
    );
    const dx = searched ? shiftRightPastOccupied(searched, occupied, ROW_GAP_PX) : 0;
    tops = layout.tops.map((top) => ({ x: top.x + dx, y: top.y }));
  }
  const nodesMap = canvasNodesMap(doc);
  // Written by an earlier delivery of this call.
  if (nodeIds.every((id) => nodesMap.has(id))) return done(result);
  const created = files.map((file, i) => {
    const built = createEmptyNode(file.type, tops[i]!, command.userId);
    const node = { ...built, id: nodeIds[i]!, data: { ...built.data, ...(file.name !== undefined ? { name: file.name } : {}) } };
    addNodeInDoc(doc, node);
    if (afterNodeId !== undefined) addEdgeInDoc(doc, { id: edgeIdOf(afterNodeId, node.id), source: afterNodeId, target: node.id });
    return { id: node.id, type: node.type, position: node.position };
  });
  if (groupId) {
    const plan = planGroupCreation(created, nodeIds, groupId);
    if (plan) {
      createGroupInDoc(
        doc,
        createGroupNode(plan.groupId, plan.position, plan.width, plan.height, command.userId, groupBackgroundFor(Math.random()), batchGroupName(files.length)),
        plan.members,
      );
    }
  }
  return done(result);
}

/**
 * Whether a file may go into a node already on the canvas: it is there, of
 * the file's type, holds nothing yet, and its own lock is off, as the
 * browser's upload into a node is gated.
 * @param doc - The canvas document.
 * @param params - The command's parameters.
 * @returns The answer.
 */
export function checkUploadTarget(doc: Y.Doc, params: AgentCommandParams<"check_upload_target">): Answer {
  const type = typeOf(doc, params.nodeId);
  if (type === undefined || nodeDataMap(doc, params.nodeId) === null) return refuse("not_found");
  if (ownLocked(doc, params.nodeId)) return refuse("locked");
  if (type !== params.type || holdsContent(doc, params.nodeId)) return refuse("invalid_command");
  return done({ nodeId: params.nodeId });
}

/**
 * A placing command's answer once its deadline has passed: done when an
 * earlier delivery placed its nodes, read off the ids the call derives.
 * @param doc - The canvas document.
 * @param command - The command.
 * @param slots - The slots its nodes take, in order; a mini-tool's count is
 *   read off the document, slot by slot, until one is missing.
 * @param result - The answer's result, from the ids found.
 * @returns The answer.
 */
export function placedLate(
  doc: Y.Doc,
  command: AgentCommand,
  slots: readonly string[] | ((i: number) => string),
  result: (ids: string[]) => Json,
): Answer {
  const nodesMap = canvasNodesMap(doc);
  const ids: string[] = [];
  if (typeof slots === "function") {
    for (let i = 0; nodesMap.has(callScopedId(command.callId, slots(i))); i++) ids.push(callScopedId(command.callId, slots(i)));
    return ids.length > 0 ? done(result(ids)) : { status: "unfinished" };
  }
  for (const slot of slots) ids.push(callScopedId(command.callId, slot));
  return ids.every((id) => nodesMap.has(id)) ? done(result(ids)) : { status: "unfinished" };
}
