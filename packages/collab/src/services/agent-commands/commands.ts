// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * What each external-agent command does to its document (breatic#1488 §7,
 * §8): one entry per command type. The consumer decides who may run a
 * command and when; an entry only reads or writes the document it is handed,
 * through the same shared readers and writers the browser uses. The canvas
 * commands live in `canvas-commands.ts`, the document commands in
 * `document-commands.ts`.
 */

import { readPresence } from "@collab/hooks/presence.js";
import * as Y from "yjs";
import type { z } from "zod";
import {
  agentCommandParamsSchemas,
  type AgentCommand,
  type AgentCommandParams,
  type AgentCommandType,
  type AgentReply,
  type ProjectRole,
} from "@breatic/shared";
import { strongestKind, type SpaceWriteKind } from "@breatic/shared/canvas-model";
import {
  comment,
  connectNodes,
  createLate,
  createNodes,
  deleteNodes,
  deletionKind,
  disconnectNodes,
  readCanvas,
  restore,
  setLocked,
  updateNode,
} from "@collab/services/agent-commands/canvas-commands.js";
import { generationKind, readGenerationInputs } from "@collab/services/agent-commands/generation-commands.js";
import {
  checkUploadTarget,
  createMiniToolResults,
  createReadingNode,
  createUploadNodes,
  placedLate,
} from "@collab/services/agent-commands/result-commands.js";
import {
  commentOnDocument,
  deleteBlocks,
  editText,
  insertBlocks,
  insertLate,
  readDocument,
} from "@collab/services/agent-commands/document-commands.js";

/** A reply without its call id. */
export type Answer = AgentReply extends infer R ? (R extends AgentReply ? Omit<R, "callId"> : never) : never;

/** A JSON value, as a reply's result carries it. */
export type Json = Extract<AgentReply, { status: "done" }>["result"];

/** Who runs a command, as the gates that depend on the person read it. */
export interface Actor {
  /** The user's role on the Project. */
  role: ProjectRole;
}

/** One command type. */
interface CommandSpec<T extends AgentCommandType> {
  /** Its parameters. */
  params: z.ZodType<AgentCommandParams<T>>;
  /** Whether it writes: writes take the document lease and are refused to viewers. */
  write: boolean;
  /**
   * The size kind its write is judged by, the one the browser's equivalent
   * write uses (`canvasWrite` in web's `canvas-space.ts`); null for a read.
   */
  size: SpaceWriteKind | ((doc: Y.Doc, params: AgentCommandParams<T>) => SpaceWriteKind) | null;
  /** The type of Space whose document it works on; `null` for the Project's meta document. */
  space: "canvas" | "document" | null;
  /** Read or write the document. A write runs inside one transaction. */
  run: (doc: Y.Doc, params: AgentCommandParams<T>, command: AgentCommand, actor: Actor) => Answer;
  /** A write's answer once its deadline has passed; writes nothing. */
  late: (doc: Y.Doc, params: AgentCommandParams<T>, command: AgentCommand) => Answer;
  /**
   * The nodes or blocks the agent's presence shows it working on (§19.2);
   * undefined keeps the last focus.
   */
  focus: (params: AgentCommandParams<T>, answer: Answer) => readonly string[] | undefined;
  /** Whether it counts against `commands_per_minute`; only the presence refresh does not. */
  counted: boolean;
}

/** The command table, by type. */
type CommandTable = { [T in AgentCommandType]: CommandSpec<T> };

/** A command type as the consumer handles it, before its parameters are narrowed. */
export interface AnyCommandSpec {
  params: z.ZodType<unknown>;
  write: boolean;
  size: SpaceWriteKind | ((doc: Y.Doc, params: unknown) => SpaceWriteKind) | null;
  space: "canvas" | "document" | null;
  run: (doc: Y.Doc, params: unknown, command: AgentCommand, actor: Actor) => Answer;
  late: (doc: Y.Doc, params: unknown, command: AgentCommand) => Answer;
  focus: (params: unknown, answer: Answer) => readonly string[] | undefined;
  counted: boolean;
}

/**
 * Answer a late command as not finished.
 * @returns The answer.
 */
function unfinished(): Answer {
  return { status: "unfinished" };
}

/**
 * The ids a done answer's result lists under one key.
 * @param answer - The answer.
 * @param key - `nodeIds`, `nodeId` or `blockIds`.
 * @returns The ids, or undefined when it holds none.
 */
function resultIds(answer: Answer, key: "nodeIds" | "nodeId" | "blockIds"): string[] | undefined {
  if (answer.status !== "done" || answer.result === null || typeof answer.result !== "object" || Array.isArray(answer.result)) return undefined;
  const value = answer.result[key];
  if (typeof value === "string") return [value];
  return Array.isArray(value) && value.every((id) => typeof id === "string") && value.length > 0 ? value : undefined;
}

/**
 * Keeps the last focus: the command names no node or block.
 * @returns Nothing, which keeps the last focus.
 */
const keepFocus = (): undefined => undefined;

const COMMANDS: CommandTable = {
  touch_presence: {
    params: agentCommandParamsSchemas.touch_presence,
    write: false,
    size: null,
    space: null,
    run: () => ({ status: "done", result: {} }),
    late: unfinished,
    focus: ({ focus }) => focus,
    counted: false,
  },
  // Answers whether the owner is in the project at all; when they are, the
  // consumer asks their browser for the capture (§19.1).
  view_user_screen: {
    params: agentCommandParamsSchemas.view_user_screen,
    write: false,
    size: null,
    space: null,
    run: (meta, _params, command) => ({ status: "done", result: { watching: readPresence(meta, command.userId)?.online === true } }),
    late: unfinished,
    focus: keepFocus,
    counted: true,
  },
  list_spaces: {
    params: agentCommandParamsSchemas.list_spaces,
    write: false,
    size: null,
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
    focus: keepFocus,
    counted: true,
  },
  read_canvas: {
    params: agentCommandParamsSchemas.read_canvas,
    write: false,
    size: null,
    space: "canvas",
    run: (doc, { nodeIds }) => readCanvas(doc, nodeIds),
    late: unfinished,
    focus: ({ nodeIds }) => nodeIds,
    counted: true,
  },
  create_canvas_nodes: {
    params: agentCommandParamsSchemas.create_canvas_nodes,
    write: true,
    size: "add",
    space: "canvas",
    run: (doc, params, command) => createNodes(doc, params, command),
    late: createLate,
    focus: (_p, answer) => resultIds(answer, "nodeIds"),
    counted: true,
  },
  update_canvas_node: {
    params: agentCommandParamsSchemas.update_canvas_node,
    write: true,
    size: (_doc, { generation, ...rest }) =>
      strongestKind(
        ...(Object.keys(rest).some((key) => key !== "nodeId" && rest[key as keyof typeof rest] !== undefined) ? (["edit"] as const) : []),
        ...(generation ? [generationKind(generation)] : []),
      ),
    space: "canvas",
    run: (doc, params) => updateNode(doc, params),
    late: unfinished,
    focus: ({ nodeId }) => [nodeId],
    counted: true,
  },
  lock_canvas_nodes: {
    params: agentCommandParamsSchemas.lock_canvas_nodes,
    write: true,
    size: "edit",
    space: "canvas",
    run: (doc, { nodeIds }) => setLocked(doc, nodeIds, true),
    late: unfinished,
    focus: ({ nodeIds }) => nodeIds,
    counted: true,
  },
  unlock_canvas_nodes: {
    params: agentCommandParamsSchemas.unlock_canvas_nodes,
    write: true,
    // Unlocking deletes the key, a pure removal.
    size: "remove",
    space: "canvas",
    run: (doc, { nodeIds }) => setLocked(doc, nodeIds, false),
    late: unfinished,
    focus: ({ nodeIds }) => nodeIds,
    counted: true,
  },
  delete_canvas_nodes: {
    params: agentCommandParamsSchemas.delete_canvas_nodes,
    write: true,
    size: (doc, { nodeIds }) => deletionKind(doc, nodeIds),
    space: "canvas",
    run: (doc, { nodeIds }, command, actor) => deleteNodes(doc, nodeIds, command, actor),
    late: unfinished,
    focus: ({ nodeIds }) => nodeIds,
    counted: true,
  },
  connect_nodes: {
    params: agentCommandParamsSchemas.connect_nodes,
    write: true,
    size: "add",
    space: "canvas",
    run: (doc, { edges }) => connectNodes(doc, edges),
    late: unfinished,
    focus: ({ edges }) => [...new Set(edges.flatMap((e) => [e.source, e.target]))],
    counted: true,
  },
  disconnect_nodes: {
    params: agentCommandParamsSchemas.disconnect_nodes,
    write: true,
    size: "remove",
    space: "canvas",
    run: (doc, { edgeIds }) => disconnectNodes(doc, edgeIds),
    late: unfinished,
    focus: keepFocus,
    counted: true,
  },
  comment_on_canvas: {
    params: agentCommandParamsSchemas.comment_on_canvas,
    write: true,
    size: "add",
    space: "canvas",
    run: (doc, params, command) => comment(doc, params, command),
    late: unfinished,
    focus: ({ nodeId }) => (nodeId === undefined ? undefined : [nodeId]),
    counted: true,
  },
  restore_node_version: {
    params: agentCommandParamsSchemas.restore_node_version,
    write: true,
    // Restoring puts a result back on the node, new content.
    size: "add",
    space: "canvas",
    run: (doc, params) => restore(doc, params),
    late: unfinished,
    focus: ({ nodeId }) => [nodeId],
    counted: true,
  },
  read_generation_inputs: {
    params: agentCommandParamsSchemas.read_generation_inputs,
    write: false,
    size: null,
    space: "canvas",
    run: (doc, { nodeId }) => readGenerationInputs(doc, nodeId),
    late: unfinished,
    focus: ({ nodeId }) => [nodeId],
    counted: true,
  },
  create_mini_tool_results: {
    params: agentCommandParamsSchemas.create_mini_tool_results,
    write: true,
    size: "add",
    space: "canvas",
    run: (doc, params, command) => createMiniToolResults(doc, params, command),
    late: (doc, _params, command) => placedLate(doc, command, (i) => `result:${String(i)}`, (nodeIds) => ({ nodeIds })),
    focus: (_p, answer) => resultIds(answer, "nodeIds"),
    counted: true,
  },
  create_reading_node: {
    params: agentCommandParamsSchemas.create_reading_node,
    write: true,
    size: "add",
    space: "canvas",
    run: (doc, params, command) => createReadingNode(doc, params, command),
    late: (doc, _params, command) => placedLate(doc, command, ["reading"], ([nodeId]) => ({ nodeId: nodeId! })),
    focus: (_p, answer) => resultIds(answer, "nodeId"),
    counted: true,
  },
  create_upload_nodes: {
    params: agentCommandParamsSchemas.create_upload_nodes,
    write: true,
    size: "add",
    space: "canvas",
    run: (doc, params, command) => createUploadNodes(doc, params, command),
    late: (doc, { files }, command) => {
      const grouped = files.length >= 2;
      const slots = [...files.map((_, i) => `upload:${String(i)}`), ...(grouped ? ["group"] : [])];
      return placedLate(doc, command, slots, (ids): Json => (grouped ? { nodeIds: ids.slice(0, -1), groupId: ids.at(-1)! } : { nodeIds: ids }));
    },
    focus: (_p, answer) => resultIds(answer, "nodeIds"),
    counted: true,
  },
  check_upload_target: {
    params: agentCommandParamsSchemas.check_upload_target,
    write: false,
    size: null,
    space: "canvas",
    run: (doc, params) => checkUploadTarget(doc, params),
    late: unfinished,
    focus: ({ nodeId }) => [nodeId],
    counted: true,
  },
  read_document: {
    params: agentCommandParamsSchemas.read_document,
    write: false,
    size: null,
    space: "document",
    run: (doc, _params, command) => readDocument(doc, command),
    late: unfinished,
    focus: keepFocus,
    counted: true,
  },
  // The document kinds are those collab's size gate gives the editor's own
  // updates: new blocks and comments add, a text change edits, and removing
  // whole blocks deletes whole Yjs types, which a Space past its ceiling still takes.
  insert_document_blocks: {
    params: agentCommandParamsSchemas.insert_document_blocks,
    write: true,
    size: "add",
    space: "document",
    run: (doc, params, command) => insertBlocks(doc, params, command),
    late: insertLate,
    focus: (_p, answer) => resultIds(answer, "blockIds"),
    counted: true,
  },
  edit_document_text: {
    params: agentCommandParamsSchemas.edit_document_text,
    write: true,
    size: "edit",
    space: "document",
    run: (doc, params) => editText(doc, params),
    late: unfinished,
    focus: ({ blockId }) => [blockId],
    counted: true,
  },
  delete_document_blocks: {
    params: agentCommandParamsSchemas.delete_document_blocks,
    write: true,
    size: "remove",
    space: "document",
    run: (doc, { blockIds }) => deleteBlocks(doc, blockIds),
    late: unfinished,
    focus: ({ blockIds }) => blockIds,
    counted: true,
  },
  comment_on_document: {
    params: agentCommandParamsSchemas.comment_on_document,
    write: true,
    size: "add",
    space: "document",
    run: (doc, params, command) => commentOnDocument(doc, params, command),
    late: unfinished,
    focus: ({ blockId }) => (blockId === undefined ? undefined : [blockId]),
    counted: true,
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
