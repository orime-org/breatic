// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * What every tool is built from (breatic#1488 §7): its definition, what it
 * runs on, and the one way it sends a command to collab and turns the
 * outcome into something an agent can act on.
 */

import { randomUUID } from "node:crypto";
import type { McpConfig } from "@breatic/core";
import {
  agentCommandRefusalSchema,
  type AgentCommandParams,
  type AgentCommandRefusal,
  type AgentCommandType,
} from "@breatic/shared";
import type { z } from "zod";
import type { AgentCall } from "@mcp/app.js";
import type { CommandChannel } from "@mcp/command-channel.js";
import type { ServerApi } from "@mcp/server-api.js";
import type { TaskTracker } from "@mcp/tools/task-tracker.js";

/** What one call's tools run on. */
export interface ToolDeps {
  /** Who the call acts as. */
  call: AgentCall;
  /** The server, as this call's user. */
  api: ServerApi;
  /** Commands to collab. */
  commands: CommandChannel;
  /** The tasks this connection started and has not been told about. */
  tasks: TaskTracker;
  /** `config/mcp.yaml`. */
  config: Readonly<McpConfig>;
  /** Log a failure the tool answers past, such as a report that did not go out. */
  report: (err: Error, context: Record<string, unknown>) => void;
}

/** An image a tool hands back, as MCP image content. */
export interface ToolImage {
  /** Base64 of the bytes. */
  data: string;
  mimeType: string;
}

/** What a tool returns: a JSON value, and images beside it. */
export interface ToolOutput {
  value: unknown;
  images?: ToolImage[];
}

/** One tool. */
export interface ToolDef<S extends z.ZodObject = z.ZodObject> {
  name: string;
  /** What it does, its limits and what it returns, for the agent. */
  description: string;
  input: S;
  /** Whether it only reads; the MCP `readOnlyHint`. */
  readOnly: boolean;
  run: (deps: ToolDeps, args: z.infer<S>) => Promise<ToolOutput>;
}

/**
 * Keep a tool's argument type tied to its schema.
 * @param def - The tool.
 * @returns The same tool.
 */
export function defineTool<S extends z.ZodObject>(def: ToolDef<S>): ToolDef<S> {
  return def;
}

/**
 * Why collab refused a command: what was wrong, by which rule. The agent reads
 * these and decides what to do itself.
 */
const REFUSAL_TEXT: Record<AgentCommandRefusal, string> = {
  read_only: "The user can only view this project (viewer role), or the project publishes a document format this service cannot write yet; nothing was written.",
  no_access: "The user is not a member of this project, or the Space does not exist in it.",
  credential_revoked: "The user revoked this connection's access; authorize again.",
  rate_limited: "Too many commands this minute for this user in this Studio; nothing was written.",
  invalid_command: "The command's parameters do not match what this tool takes.",
  not_found: "A node, edge, block or thread the call names does not exist (it may have been deleted).",
  locked: "A node the call changes is locked; the user unlocks it, or unlock_canvas_nodes does.",
  handling: "A node the call changes has a task running (generating, uploading, understanding); it can be changed once the task ends.",
  not_yours: "The comment was written by someone else; only its author may change it.",
  cannot_connect: "The canvas does not allow this connection between these node types (same rule as dragging an edge in the browser).",
  reference_pool_full: "The target node already has as many references of this kind as it takes.",
  space_full: "The Space has reached its size limit; only deletions are accepted.",
  ambiguous_text: "The words to change appear more than once in the block; quote a longer, unique passage.",
  schema_mismatch: "The project's documents use a newer format than this service writes; nothing was written.",
  not_a_reference: "A prompt @-mentions a node that is not connected into this node as a reference.",
};

/**
 * The text of a refusal collab returned, its unknown reasons included.
 * @param reason - The refusal reason.
 * @returns What was wrong, for the agent.
 */
function refusalText(reason: string): string {
  const known = agentCommandRefusalSchema.safeParse(reason);
  return known.success ? REFUSAL_TEXT[known.data] : reason;
}

/** A call the tool could not do; the agent sees `reason` and `message`. */
export class ToolRefusal extends Error {
  /**
   * Record why.
   * @param reason - A stable code the agent can branch on.
   * @param message - What was wrong, for the agent.
   */
  constructor(
    readonly reason: string,
    message: string,
  ) {
    super(message);
    this.name = "ToolRefusal";
  }
}

/** The answer when a write's outcome is unknown: the agent reads again before deciding. */
export const UNFINISHED_TEXT = "The command did not finish before its deadline and may or may not have been applied; read the Space again before deciding what to do.";

/** A command the call sends, without what the call itself supplies. */
export interface CommandRequest<T extends AgentCommandType> {
  type: T;
  projectId: string;
  spaceId: string | null;
  params: AgentCommandParams<T>;
}

/** A command's outcome: its result, or the operation id to fetch it with later. */
export type CommandOutcome = { kind: "done"; result: unknown } | { kind: "pending"; operationId: string };

/**
 * When this call's commands stop being applied.
 * @param deps - The call.
 * @returns Epoch ms.
 */
function deadlineOf(deps: ToolDeps): number {
  return deps.call.startedAt + deps.config.call_timeout_ms;
}

/**
 * Build a command of this call.
 * @param deps - The call.
 * @param request - The command.
 * @returns The command, with a fresh call id.
 */
function commandOf<T extends AgentCommandType>(deps: ToolDeps, request: CommandRequest<T>): Parameters<CommandChannel["submit"]>[0] {
  const { call } = deps;
  return {
    callId: randomUUID(),
    type: request.type,
    userId: call.userId,
    connectionId: call.connectionId,
    credential: call.credential,
    projectId: request.projectId,
    spaceId: request.spaceId,
    params: request.params as Parameters<CommandChannel["submit"]>[0]["params"],
    submittedAt: Date.now(),
    deadlineAt: deadlineOf(deps),
  };
}

/**
 * Send a command and wait for its reply, up to `command_wait_ms` and never past the call's deadline.
 * @param deps - The call.
 * @param request - The command.
 * @returns The result, or the operation id when no reply came in the wait.
 * @throws {ToolRefusal} When collab refused it or it did not finish before its deadline.
 */
export async function runCommand<T extends AgentCommandType>(deps: ToolDeps, request: CommandRequest<T>): Promise<CommandOutcome> {
  const waitMs = Math.max(0, Math.min(deps.config.command_wait_ms, deadlineOf(deps) - Date.now()));
  const outcome = await deps.commands.submit(commandOf(deps, request), waitMs);
  if (outcome.kind === "submitted") return { kind: "pending", operationId: outcome.callId };
  return replyOutcome(outcome.reply);
}

/**
 * Read a reply the way every tool does.
 * @param reply - The reply.
 * @returns Its result.
 * @throws {ToolRefusal} When it is a refusal or did not finish.
 */
export function replyOutcome(reply: Extract<Awaited<ReturnType<CommandChannel["submit"]>>, { kind: "reply" }>["reply"]): { kind: "done"; result: unknown } {
  if (reply.status === "rejected") throw new ToolRefusal(reply.reason, refusalText(reply.reason));
  if (reply.status === "unfinished") throw new ToolRefusal("unfinished", UNFINISHED_TEXT);
  return { kind: "done", result: reply.result };
}

/**
 * Run a command whose result the tool needs before it can go on, as the
 * composite tools do (place nodes, then start the run).
 * @param deps - The call.
 * @param request - The command.
 * @returns Its result.
 * @throws {ToolRefusal} When it was refused, or no reply came inside the wait.
 */
export async function runCommandNow<T extends AgentCommandType>(deps: ToolDeps, request: CommandRequest<T>): Promise<unknown> {
  const outcome = await runCommand(deps, request);
  if (outcome.kind === "pending") {
    throw new ToolRefusal(
      "busy",
      `The project did not answer in time; this step may still be applied. Check it later with get_operation_result (operation id ${outcome.operationId}) or read the Space again before retrying.`,
    );
  }
  return outcome.result;
}

/**
 * The value an agent gets for a command that may still be running.
 * @param outcome - The outcome.
 * @returns The result, or where to fetch it.
 */
export function outcomeValue(outcome: CommandOutcome): unknown {
  if (outcome.kind === "done") return outcome.result;
  return {
    status: "pending",
    operationId: outcome.operationId,
    note: "The project has not answered yet. Fetch the outcome with get_operation_result; do not send the same change again.",
  };
}

/**
 * Keep the agent's presence on a Project fresh for a call that sends collab no other command (§19.2).
 * @param deps - The call.
 * @param projectId - The Project.
 * @param spaceId - The Space, when the call names one.
 * @param focus - The nodes it works on.
 */
export async function touchPresence(deps: ToolDeps, projectId: string, spaceId: string | null, focus?: string[]): Promise<void> {
  await deps.commands.send(
    commandOf(deps, { type: "touch_presence", projectId, spaceId, params: focus && focus.length > 0 ? { focus } : {} }),
  );
}

/**
 * A fresh idempotency key for one request a tool sends.
 * @returns The key.
 */
export function idempotencyKey(): string {
  return randomUUID();
}
