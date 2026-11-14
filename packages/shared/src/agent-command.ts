// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * The contract between the MCP service and collab for external-agent commands
 * (breatic#1488): the Redis key names both sides build from the deployment
 * prefix, the command envelope both sides validate, the reply collab writes,
 * and the ids a command derives from its call id.
 */

import { z } from "zod";
import { deriveId } from "@shared/ids.js";
import { CREATABLE_NODE_TYPES, type CreatableNodeType } from "@shared/canvas/model/node-factory.js";
import { MAX_NODE_NAME_LEN } from "@shared/types/canvas-node.js";
import { promptSegmentSchema } from "@shared/types/canvas-proposal.js";

/**
 * Approximate length cap of the command stream. Same value as core's
 * `STREAM_MAXLEN` in `infra/event-stream.ts`, which caps every other stream;
 * shared cannot import core, so the number is repeated here.
 */
export const AGENT_COMMAND_STREAM_MAXLEN = 10_000;

/**
 * Stream the MCP service appends commands to and collab consumes.
 * @param prefix - The deployment's Redis key prefix
 * @returns The stream key
 */
export function mcpCommandStreamKey(prefix: string): string {
  return `${prefix}:mcp:commands`;
}

/**
 * Key collab writes one command's reply to.
 * @param prefix - The deployment's Redis key prefix
 * @param callId - The command's call id
 * @returns The reply key
 */
export function mcpReplyKey(prefix: string, callId: string): string {
  return `${prefix}:mcp:reply:${callId}`;
}

/**
 * Key holding one command's submission record (submit time, deadline,
 * connection, Project and Space), read when the agent asks for the result later.
 * @param prefix - The deployment's Redis key prefix
 * @param callId - The command's call id
 * @returns The operation key
 */
export function mcpOperationKey(prefix: string, callId: string): string {
  return `${prefix}:mcp:op:${callId}`;
}

/**
 * Pub/sub channel announcing that a command's reply is written.
 * @param prefix - The deployment's Redis key prefix
 * @returns The channel name
 */
export function mcpDoneChannel(prefix: string): string {
  return `${prefix}:mcp:done`;
}

/**
 * Key listing the tasks one agent connection has in flight.
 * @param prefix - The deployment's Redis key prefix
 * @param connectionId - The agent connection id
 * @returns The in-flight tasks key
 */
export function mcpInFlightTasksKey(prefix: string, connectionId: string): string {
  return `${prefix}:mcp:tasks:${connectionId}`;
}

/**
 * Key for one capture request.
 * @param prefix - The deployment's Redis key prefix
 * @param requestId - The capture request id
 * @returns The capture request key
 */
export function mcpCaptureRequestKey(prefix: string, requestId: string): string {
  return `${prefix}:mcp:capture-request:${requestId}`;
}

/**
 * Largest on-screen data one capture upload carries, in bytes. Together with
 * `view_capture.max_bytes` it must fit under the request body limit.
 */
export const VIEW_CAPTURE_VIEW_MAX_BYTES = 65_536;

/**
 * The credential behind a command, the same shape as core's `AgentCredential`:
 * collab asks core whether it is still usable before it executes the command.
 */
export const agentCredentialSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("oauth"), grantId: z.string().min(1) }),
  z.object({ type: z.literal("pat"), tokenId: z.string().min(1) }),
]);

/** One command the MCP service sends collab. Times are epoch milliseconds. */
export const agentCommandSchema = z.object({
  callId: z.uuid(),
  type: z.string(),
  userId: z.uuid(),
  connectionId: z.uuid(),
  credential: agentCredentialSchema,
  projectId: z.uuid(),
  spaceId: z.uuid().nullable(),
  params: z.json(),
  submittedAt: z.number(),
  deadlineAt: z.number(),
});
export type AgentCommand = z.infer<typeof agentCommandSchema>;

/** The outcome collab writes for one command. */
export const agentReplySchema = z.discriminatedUnion("status", [
  z.object({ callId: z.uuid(), status: z.literal("done"), result: z.json() }),
  z.object({ callId: z.uuid(), status: z.literal("rejected"), reason: z.string().min(1) }),
  z.object({ callId: z.uuid(), status: z.literal("unfinished") }),
]);
export type AgentReply = z.infer<typeof agentReplySchema>;

/** Why collab refused a command before or instead of executing it. */
export const AGENT_COMMAND_REFUSALS = [
  "read_only",
  "no_access",
  "credential_revoked",
  "rate_limited",
  "invalid_command",
  "not_found",
  // The gates the browser applies to a user's own edit (§8.3).
  "locked",
  "handling",
  "not_yours",
  "cannot_connect",
  "reference_pool_full",
  "space_full",
  // A document edit whose words appear more than once in the block.
  "ambiguous_text",
  // The project publishes a document format this build does not write.
  "schema_mismatch",
  // A prompt @'ing a node that is not connected in as one of the node's references.
  "not_a_reference",
] as const;
export const agentCommandRefusalSchema = z.enum(AGENT_COMMAND_REFUSALS);
export type AgentCommandRefusal = z.infer<typeof agentCommandRefusalSchema>;

/**
 * A node id an agent names. Not narrowed to a uuid: the canvas writes uuids
 * today, and an id written under an older scheme must still be addressable;
 * an id that names no node is answered `not_found`.
 */
const nodeIdSchema = z.string().min(1);

/** A node or Group name, no longer than the rename input lets a user type. */
const nodeNameSchema = z.string().max(MAX_NODE_NAME_LEN);

/** A node type an agent can create, the same four the node library offers. */
const creatableNodeTypeSchema = z.custom<CreatableNodeType>(
  (value) => typeof value === "string" && (CREATABLE_NODE_TYPES as readonly string[]).includes(value),
);

/** A point in flow coordinates. `z.number()` refuses NaN and the infinities. */
const pointSchema = z.object({ x: z.number(), y: z.number() });

/** One end of an edge a create command writes: a node of this batch, by index, or one on the canvas. */
const newEdgeEndSchema = z.union([
  z.object({ new: z.number().int().min(0) }).strict(),
  z.object({ id: nodeIdSchema }).strict(),
]);

/**
 * A model's catalog entry, as the MCP service read it from `GET /api/v1/models`.
 * collab resolves a mode or model switch against it; it is not collab's to
 * hold the catalog, so only what that switch reads is required.
 */
const modelEntrySchema = z.looseObject({
  name: z.string().min(1),
  mode: z.union([z.string(), z.array(z.string())]),
  params: z.record(z.string(), z.unknown()),
});

/**
 * A change to a node's generation settings (breatic#1488 §8.1, §9): mode and
 * model with the model's catalog entry, params for the model in use, a
 * prompt, lyrics and storyboard shots whose refs index `mentions`, and slot
 * picks by field, each naming the node a click would fill it from (`null`
 * empties it).
 */
const generationChangeSchema = z
  .object({
    mode: z.string().min(1).optional(),
    model: z.string().min(1).optional(),
    modelEntry: modelEntrySchema.optional(),
    params: z.record(z.string(), z.json()).optional(),
    prompt: z.array(promptSegmentSchema).optional(),
    lyrics: z.array(promptSegmentSchema).optional(),
    shots: z.array(z.object({ duration: z.number().positive(), prompt: z.array(promptSegmentSchema) })).optional(),
    mentions: z.array(nodeIdSchema).optional(),
    slots: z.record(z.string(), z.union([nodeIdSchema, z.array(nodeIdSchema), z.null()])).optional(),
  })
  .refine((g) => Object.values(g).some((v) => v !== undefined), { message: "nothing to change" })
  .refine((g) => (g.mode === undefined && g.model === undefined) || g.modelEntry !== undefined, {
    message: "a mode or a model comes with the model's catalog entry",
  })
  .refine((g) => g.model === undefined || g.modelEntry?.name === g.model, { message: "the catalog entry is another model's" })
  .refine(
    (g) =>
      [...(g.prompt ?? []), ...(g.lyrics ?? []), ...(g.shots ?? []).flatMap((shot) => shot.prompt)].every(
        (s) => s.ref === undefined || s.ref < (g.mentions ?? []).length,
      ),
    { message: "a ref indexes past its mentions" },
  );

/** One BlockNote block as JSON: its type, and whatever else BlockNote reads. */
const documentBlockSchema = z.looseObject({ type: z.string().min(1) });

/** A list of node ids, at least one. */
const nodeIdsSchema = z.array(nodeIdSchema).min(1);

/**
 * The parameters of each command type, by type (breatic#1488 §7). A type not
 * listed here is not a command collab executes.
 */
export const agentCommandParamsSchemas = {
  list_spaces: z.object({}),
  read_canvas: z.object({ nodeIds: z.array(nodeIdSchema).optional() }),
  create_canvas_nodes: z
    .object({
      nodes: z
        .array(z.object({ type: creatableNodeTypeSchema, name: nodeNameSchema.optional(), position: pointSchema.optional() }))
        .min(1),
      edges: z.array(z.object({ source: newEdgeEndSchema, target: newEdgeEndSchema })).optional(),
      group: z.object({ name: nodeNameSchema.optional(), include: z.array(nodeIdSchema).optional() }).optional(),
    })
    .refine(
      (p) => (p.edges ?? []).every((e) => [e.source, e.target].every((end) => !("new" in end) || end.new < p.nodes.length)),
      { message: "an edge names a new node the batch does not have" },
    ),
  // Every field but the id is a change to make, and at least one is given.
  update_canvas_node: z
    .object({
      nodeId: nodeIdSchema,
      name: nodeNameSchema.optional(),
      position: pointSchema.optional(),
      parentId: nodeIdSchema.nullable().optional(),
      text: z.string().optional(),
      generation: generationChangeSchema.optional(),
    })
    .refine(
      (p) => p.name !== undefined || p.position !== undefined || p.parentId !== undefined || p.text !== undefined || p.generation !== undefined,
      { message: "nothing to change" },
    ),
  lock_canvas_nodes: z.object({ nodeIds: nodeIdsSchema }),
  unlock_canvas_nodes: z.object({ nodeIds: nodeIdsSchema }),
  delete_canvas_nodes: z.object({ nodeIds: nodeIdsSchema }),
  connect_nodes: z.object({ edges: z.array(z.object({ source: nodeIdSchema, target: nodeIdSchema })).min(1) }),
  disconnect_nodes: z.object({ edgeIds: z.array(z.string().min(1)).min(1) }),
  // Where the thread goes: a point (the pin's tip), a node, or an existing
  // thread to reply to; exactly one of them.
  comment_on_canvas: z
    .object({
      text: z.string().min(1),
      position: pointSchema.optional(),
      nodeId: nodeIdSchema.optional(),
      annotationId: nodeIdSchema.optional(),
    })
    .refine((p) => [p.position, p.nodeId, p.annotationId].filter((v) => v !== undefined).length === 1, {
      message: "name exactly one of position, nodeId and annotationId",
    }),
  // A history row the MCP service read for the node; only a successful one
  // with content is restorable, as in the history panel.
  restore_node_version: z.object({
    nodeId: nodeIdSchema,
    entry: z.object({
      status: z.literal("success"),
      content: z.string().min(1),
      thumbnailUrl: z.string().nullable(),
      mediaWidth: z.number().nullable(),
      mediaHeight: z.number().nullable(),
      duration: z.number().nullable(),
      mimeType: z.string().nullable(),
      size: z.number().nullable(),
    }),
  }),
  // What the generation panel's view model is built from, read before a run.
  read_generation_inputs: z.object({ nodeId: nodeIdSchema }),
  // The nodes a composite tool's result lands on, placed before the MCP
  // service asks the server for the run (§10.2).
  create_mini_tool_results: z.object({ toolId: z.string().min(1), sourceNodeId: nodeIdSchema, params: z.record(z.string(), z.json()) }),
  create_reading_node: z.object({ sourceNodeId: nodeIdSchema, reading: z.enum(["understand", "transcribe"]) }),
  create_upload_nodes: z.object({
    files: z.array(z.object({ type: creatableNodeTypeSchema, name: z.string().min(1).optional() })).min(1),
    afterNodeId: nodeIdSchema.optional(),
  }),
  // Whether a file may go into a node already on the canvas: read only.
  check_upload_target: z.object({ nodeId: nodeIdSchema, type: creatableNodeTypeSchema }),
  read_document: z.object({}),
  // Blocks as BlockNote block JSON (the MCP service converts Markdown);
  // whether the document schema can build one is collab's to judge.
  insert_document_blocks: z.object({
    afterBlockId: z.string().min(1).nullable().optional(),
    blocks: z.array(documentBlockSchema).min(1),
  }),
  edit_document_text: z.object({ blockId: z.string().min(1), find: z.string().min(1), replace: z.string() }),
  delete_document_blocks: z.object({ blockIds: z.array(z.string().min(1)).min(1) }),
  // A new thread on a block (on the words `find` names, or its whole text),
  // or a reply to a thread; exactly one of `blockId` and `threadId`.
  comment_on_document: z
    .object({
      text: z.string().min(1),
      blockId: z.string().min(1).optional(),
      find: z.string().min(1).optional(),
      threadId: z.string().min(1).optional(),
    })
    .refine((p) => (p.blockId === undefined) !== (p.threadId === undefined), { message: "name exactly one of blockId and threadId" })
    .refine((p) => p.find === undefined || p.blockId !== undefined, { message: "find names words in a block" }),
} as const;

/** A command type collab executes. */
export type AgentCommandType = keyof typeof agentCommandParamsSchemas;

/** The parameters of one command type. */
export type AgentCommandParams<T extends AgentCommandType> = z.infer<(typeof agentCommandParamsSchemas)[T]>;

/**
 * Whether a command type is one collab executes.
 * @param type - The command's `type`.
 * @returns True for a listed type.
 */
export function isAgentCommandType(type: string): type is AgentCommandType {
  return Object.hasOwn(agentCommandParamsSchemas, type);
}

/**
 * Deterministic id for one slot of a command, so a re-run of the same call
 * writes the same node or block instead of a duplicate.
 * @param callId - The command's call id
 * @param slot - The slot within the call (e.g. `node:0`)
 * @returns A v5 UUID derived from the call id and slot
 */
export function callScopedId(callId: string, slot: string): string {
  return deriveId(`${callId}:${slot}`);
}
