// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * What each external-agent command does to its document (breatic#1488 §7,
 * §8): one entry per command type. The consumer decides who may run a
 * command and when; an entry only reads or writes the document it is handed,
 * through the same shared readers and writers the browser uses.
 */

import * as Y from "yjs";
import type { z } from "zod";
import {
  agentCommandParamsSchemas,
  callScopedId,
  type AgentCommand,
  type AgentCommandParams,
  type AgentCommandType,
  type AgentReply,
  type CanvasProposal,
} from "@breatic/shared";
import {
  ROW_GAP_PX,
  addNodeInDoc,
  canvasNodesMap,
  centerOf,
  createEmptyNode,
  groupRectForMembers,
  nodeDataMap,
  occupiedRects,
  planFlowLayout,
  readEdges,
  readNodePlacementsInDoc,
  readNodes,
  setNodeNameInDoc,
  shiftRightPastOccupied,
  withTaskCounts,
} from "@breatic/shared/canvas-model";

/** A reply without its call id. */
export type Answer = AgentReply extends infer R ? (R extends AgentReply ? Omit<R, "callId"> : never) : never;

/** A JSON value, as a reply's result carries it. */
type Json = Extract<AgentReply, { status: "done" }>["result"];

/** One command type. */
interface CommandSpec<T extends AgentCommandType> {
  /** Its parameters. */
  params: z.ZodType<AgentCommandParams<T>>;
  /** Whether it writes: writes take the document lease and are refused to viewers. */
  write: boolean;
  /** The Space document it works on; `null` for the Project's meta document. */
  space: "canvas" | null;
  /** Read or write the document. A write runs inside one transaction. */
  run: (doc: Y.Doc, params: AgentCommandParams<T>, command: AgentCommand) => Answer;
  /** A write's answer once its deadline has passed; writes nothing. */
  late: (doc: Y.Doc, params: AgentCommandParams<T>, command: AgentCommand) => Answer;
}

/** The command table, by type. */
type CommandTable = { [T in AgentCommandType]: CommandSpec<T> };

/** A command type as the consumer handles it, before its parameters are narrowed. */
export interface AnyCommandSpec {
  params: z.ZodType<unknown>;
  write: boolean;
  space: "canvas" | null;
  run: (doc: Y.Doc, params: unknown, command: AgentCommand) => Answer;
  late: (doc: Y.Doc, params: unknown, command: AgentCommand) => Answer;
}

/**
 * Answer a late command as not finished.
 * @returns The answer.
 */
function unfinished(): Answer {
  return { status: "unfinished" };
}

/**
 * The ids a create command's nodes take, derived from its call id.
 * @param command - The command.
 * @param count - How many nodes it creates.
 * @returns One id per node, in order.
 */
function createdIds(command: AgentCommand, count: number): string[] {
  return Array.from({ length: count }, (_, i) => callScopedId(command.callId, `node:${String(i)}`));
}

/**
 * Where new nodes go when the agent names no place and the user's view is
 * not known (§8.2): aimed at the centre of what the canvas holds, or the
 * origin on an empty canvas, laid out as the browser lays out a placed batch,
 * then moved right until it covers nothing.
 * @param doc - The canvas document.
 * @param nodes - The nodes to place.
 * @returns One top-left position per node.
 */
function placeNewNodes(doc: Y.Doc, nodes: AgentCommandParams<"create_canvas_nodes">["nodes"]): Array<{ x: number; y: number }> {
  const occupied = occupiedRects(readNodePlacementsInDoc(doc), () => undefined);
  const all = groupRectForMembers(occupied, 0);
  const proposal: CanvasProposal = {
    nodes: nodes.map((node) => ({ role: "source", type: node.type, name: node.name ?? "" })),
    edges: [],
    rationale: "",
  };
  const aimed = planFlowLayout(proposal, all ? centerOf(all) : { x: 0, y: 0 });
  const searched = groupRectForMembers(aimed.map(withTaskCounts), 0);
  const dx = searched ? shiftRightPastOccupied(searched, occupied, ROW_GAP_PX) : 0;
  return aimed.map((spot) => ({ x: spot.x + dx, y: spot.y }));
}

const COMMANDS: CommandTable = {
  list_spaces: {
    params: agentCommandParamsSchemas.list_spaces,
    write: false,
    space: null,
    run: (meta) => {
      const spaces: Array<{ id: string; type: string; name: string; order: number }> = [];
      meta.getMap("spaces").forEach((entry, id) => {
        if (!(entry instanceof Y.Map)) return;
        const type = entry.get("type");
        if (typeof type !== "string") return;
        const name = entry.get("name");
        const order = entry.get("order");
        spaces.push({ id, type, name: typeof name === "string" ? name : "", order: typeof order === "number" ? order : 0 });
      });
      spaces.sort((a, b) => a.order - b.order);
      return { status: "done", result: { spaces: spaces.map(({ id, type, name }) => ({ id, type, name })) } };
    },
    late: unfinished,
  },
  read_canvas: {
    params: agentCommandParamsSchemas.read_canvas,
    write: false,
    space: "canvas",
    run: (doc, { nodeIds }) => {
      const wanted = nodeIds ? new Set(nodeIds) : null;
      const nodes = readNodes(doc).filter((node) => !wanted || wanted.has(node.id));
      const edges = readEdges(doc).filter((edge) => !wanted || wanted.has(edge.source) || wanted.has(edge.target));
      // The views hold no value JSON cannot carry except `undefined`, which
      // the round trip drops.
      return { status: "done", result: JSON.parse(JSON.stringify({ nodes, edges })) as Json };
    },
    late: unfinished,
  },
  create_canvas_nodes: {
    params: agentCommandParamsSchemas.create_canvas_nodes,
    write: true,
    space: "canvas",
    run: (doc, { nodes }, command) => {
      const ids = createdIds(command, nodes.length);
      const existing = canvasNodesMap(doc);
      const missing = nodes.flatMap((node, i) => (existing.has(ids[i]!) ? [] : [{ node, id: ids[i]! }]));
      // A node already there was written by an earlier delivery of this call;
      // writing it again would replace it with an empty one.
      const spots = placeNewNodes(doc, missing.map((m) => m.node));
      missing.forEach(({ node, id }, i) => {
        const empty = createEmptyNode(node.type, spots[i]!, command.userId);
        addNodeInDoc(doc, {
          ...empty,
          id,
          data: { ...empty.data, ...(node.name !== undefined ? { name: node.name } : {}) },
        });
      });
      return { status: "done", result: { nodeIds: ids } };
    },
    late: (doc, { nodes }, command) => {
      const ids = createdIds(command, nodes.length);
      const existing = canvasNodesMap(doc);
      return ids.every((id) => existing.has(id)) ? { status: "done", result: { nodeIds: ids } } : unfinished();
    },
  },
  update_canvas_node: {
    params: agentCommandParamsSchemas.update_canvas_node,
    write: true,
    space: "canvas",
    run: (doc, { nodeId, name }) => {
      if (nodeDataMap(doc, nodeId) === null) return { status: "rejected", reason: "not_found" };
      if (name !== undefined) setNodeNameInDoc(doc, nodeId, name);
      return { status: "done", result: { nodeId } };
    },
    late: unfinished,
  },
};

/**
 * One command type's entry. The parameters it is then handed are the ones
 * its own `params` schema parsed.
 * @param type - The command type.
 * @returns Its entry.
 */
export function commandSpec(type: AgentCommandType): AnyCommandSpec {
  return COMMANDS[type] as unknown as AnyCommandSpec;
}
