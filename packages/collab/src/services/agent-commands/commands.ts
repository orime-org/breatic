// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * What each external-agent command does to its document (breatic#1488 §7,
 * §8): one entry per command type. The consumer decides who may run a
 * command and when; an entry only reads or writes the document it is handed,
 * through the same shared readers and writers the browser uses. The canvas
 * commands live in `canvas-commands.ts`, the document commands in
 * `document-commands.ts`.
 */

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
}

/**
 * Answer a late command as not finished.
 * @returns The answer.
 */
function unfinished(): Answer {
  return { status: "unfinished" };
}

const COMMANDS: CommandTable = {
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
  },
  read_canvas: {
    params: agentCommandParamsSchemas.read_canvas,
    write: false,
    size: null,
    space: "canvas",
    run: (doc, { nodeIds }) => readCanvas(doc, nodeIds),
    late: unfinished,
  },
  create_canvas_nodes: {
    params: agentCommandParamsSchemas.create_canvas_nodes,
    write: true,
    size: "add",
    space: "canvas",
    run: (doc, params, command) => createNodes(doc, params, command),
    late: createLate,
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
  },
  lock_canvas_nodes: {
    params: agentCommandParamsSchemas.lock_canvas_nodes,
    write: true,
    size: "edit",
    space: "canvas",
    run: (doc, { nodeIds }) => setLocked(doc, nodeIds, true),
    late: unfinished,
  },
  unlock_canvas_nodes: {
    params: agentCommandParamsSchemas.unlock_canvas_nodes,
    write: true,
    // Unlocking deletes the key, a pure removal.
    size: "remove",
    space: "canvas",
    run: (doc, { nodeIds }) => setLocked(doc, nodeIds, false),
    late: unfinished,
  },
  delete_canvas_nodes: {
    params: agentCommandParamsSchemas.delete_canvas_nodes,
    write: true,
    size: (doc, { nodeIds }) => deletionKind(doc, nodeIds),
    space: "canvas",
    run: (doc, { nodeIds }, command, actor) => deleteNodes(doc, nodeIds, command, actor),
    late: unfinished,
  },
  connect_nodes: {
    params: agentCommandParamsSchemas.connect_nodes,
    write: true,
    size: "add",
    space: "canvas",
    run: (doc, { edges }) => connectNodes(doc, edges),
    late: unfinished,
  },
  disconnect_nodes: {
    params: agentCommandParamsSchemas.disconnect_nodes,
    write: true,
    size: "remove",
    space: "canvas",
    run: (doc, { edgeIds }) => disconnectNodes(doc, edgeIds),
    late: unfinished,
  },
  comment_on_canvas: {
    params: agentCommandParamsSchemas.comment_on_canvas,
    write: true,
    size: "add",
    space: "canvas",
    run: (doc, params, command) => comment(doc, params, command),
    late: unfinished,
  },
  restore_node_version: {
    params: agentCommandParamsSchemas.restore_node_version,
    write: true,
    // Restoring puts a result back on the node, new content.
    size: "add",
    space: "canvas",
    run: (doc, params) => restore(doc, params),
    late: unfinished,
  },
  read_generation_inputs: {
    params: agentCommandParamsSchemas.read_generation_inputs,
    write: false,
    size: null,
    space: "canvas",
    run: (doc, { nodeId }) => readGenerationInputs(doc, nodeId),
    late: unfinished,
  },
  read_document: {
    params: agentCommandParamsSchemas.read_document,
    write: false,
    size: null,
    space: "document",
    run: (doc, _params, command) => readDocument(doc, command),
    late: unfinished,
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
  },
  edit_document_text: {
    params: agentCommandParamsSchemas.edit_document_text,
    write: true,
    size: "edit",
    space: "document",
    run: (doc, params) => editText(doc, params),
    late: unfinished,
  },
  delete_document_blocks: {
    params: agentCommandParamsSchemas.delete_document_blocks,
    write: true,
    size: "remove",
    space: "document",
    run: (doc, { blockIds }) => deleteBlocks(doc, blockIds),
    late: unfinished,
  },
  comment_on_document: {
    params: agentCommandParamsSchemas.comment_on_document,
    write: true,
    size: "add",
    space: "document",
    run: (doc, params, command) => commentOnDocument(doc, params, command),
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
