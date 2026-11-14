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
] as const;
export const agentCommandRefusalSchema = z.enum(AGENT_COMMAND_REFUSALS);
export type AgentCommandRefusal = z.infer<typeof agentCommandRefusalSchema>;

/**
 * A node id an agent names. Not narrowed to a uuid: the canvas writes uuids
 * today, and an id written under an older scheme must still be addressable;
 * an id that names no node is answered `not_found`.
 */
const nodeIdSchema = z.string().min(1);

/** A node type an agent can create, the same four the node library offers. */
const creatableNodeTypeSchema = z.custom<CreatableNodeType>(
  (value) => typeof value === "string" && (CREATABLE_NODE_TYPES as readonly string[]).includes(value),
);

/**
 * The parameters of each command type, by type (breatic#1488 §7). A type not
 * listed here is not a command collab executes.
 */
export const agentCommandParamsSchemas = {
  list_spaces: z.object({}),
  read_canvas: z.object({ nodeIds: z.array(nodeIdSchema).optional() }),
  create_canvas_nodes: z.object({
    nodes: z.array(z.object({ type: creatableNodeTypeSchema, name: z.string().optional() })).min(1),
  }),
  // Every field but the id is a change to make, and at least one is given;
  // later fields join `name` here.
  update_canvas_node: z
    .object({ nodeId: nodeIdSchema, name: z.string().optional() })
    .refine((p) => p.name !== undefined, { message: "nothing to change" }),
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
