// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * External-agent commands, from the MCP service's stream into the Space
 * documents (breatic#1488 §6, §15.5).
 *
 * Data path:
 *   MCP service → DB 4 stream → consumer group → per command: parse, skip if
 *   already answered, re-check credential, role, Space and rate → read on a
 *   direct connection, or write under the document lease the task listener
 *   takes → reply key (SET NX EX) → `mcp:done` → acknowledge
 *
 * Delivery is at least once, so a command can arrive twice: the reply key is
 * checked first, created nodes take ids derived from the call id and are
 * skipped when they exist, and setting a field twice sets it once. A command
 * whose deadline has passed is never written, on any delivery.
 *
 * Writes to one document share a round key, so one instance runs them in
 * stream order; reads each run on their own key.
 */

import type { Hocuspocus } from "@hocuspocus/server";
import type * as Y from "yjs";
import {
  agentAccessService,
  checkRateLimit,
  createLogger,
  createRedisClient,
  getCollabRedis,
  getMcpConfig,
  listedContentDocNames,
  projectAuthService,
  projectsRepo,
  type Redis,
} from "@breatic/core";
import {
  agentCommandSchema,
  canvasSpaceDocName,
  isAgentCommandType,
  mcpCommandStreamKey,
  mcpDoneChannel,
  mcpReplyKey,
  projectMetaDocName,
  type AgentCommand,
  type AgentCommandType,
  type AgentReply,
} from "@breatic/shared";
import { createDocLease, type DocLeaseSettings } from "@collab/services/doc-lease.js";
import {
  startGroupConsumer,
  type EntryOutcome,
  type GroupConsumer,
  type GroupConsumerSettings,
  type StreamEntry,
} from "@collab/services/stream-group-consumer.js";
import { commandSpec, type Answer } from "@collab/services/agent-commands/commands.js";

const logger = createLogger("agent-commands");

/** Consumer group every collab instance that takes commands joins. */
export const AGENT_COMMANDS_GROUP = "collab-agent-commands";

/** Stream field the MCP service writes a command's JSON under. */
const COMMAND_FIELD = "command";

/** Names the writer in a direct connection's context. */
const SOURCE = "agent-commands";

/** Settings of the command consumer: the consumer group's, plus the document lease's. */
export interface AgentCommandSettings extends GroupConsumerSettings, DocLeaseSettings {}

/** What the consumer needs. */
export interface AgentCommandConsumerDeps {
  /** The running Hocuspocus server. */
  hocuspocus: Hocuspocus;
  /** `REDIS_MCP_URL`, the external-agent database (DB 4). */
  redisUrl: string;
  /** `REDIS_KEY_PREFIX`. */
  prefix: string;
  /** `agent_commands.consume`: whether this instance takes commands. */
  consume: boolean;
  /** This process's consumer name. */
  instanceId: string;
  /** Timing and limits. */
  settings: AgentCommandSettings;
}

/** One parsed command and the stream entry it came from. */
interface Item {
  entry: StreamEntry;
  command: AgentCommand;
  type: AgentCommandType;
  params: unknown;
  startedAt: number;
}

/**
 * Read one entry: the command, or the reply it gets without running.
 * @param entry - The stream entry.
 * @returns The item; a refusal for the call id it names; or null when it names none.
 */
function readEntry(entry: StreamEntry): Item | { callId: string; refused: Answer } | null {
  let raw: unknown;
  try {
    raw = JSON.parse(entry.payload ?? "");
  } catch {
    return null;
  }
  const callId = (raw as { callId?: unknown } | null)?.callId;
  const named = typeof callId === "string" && agentCommandSchema.shape.callId.safeParse(callId).success ? callId : null;
  const invalid = named ? { callId: named, refused: { status: "rejected", reason: "invalid_command" } as const } : null;
  const parsed = agentCommandSchema.safeParse(raw);
  if (!parsed.success) return invalid;
  const command = parsed.data;
  if (!isAgentCommandType(command.type)) return invalid;
  const spec = commandSpec(command.type);
  if (spec.space === "canvas" && command.spaceId === null) return invalid;
  const params = spec.params.safeParse(command.params);
  if (!params.success) return invalid;
  return { entry, command, type: command.type, params: params.data, startedAt: Date.now() };
}

/**
 * The document a command reads or writes.
 * @param item - The command.
 * @returns The document name.
 */
function docNameOf(item: Item): string {
  const { projectId, spaceId } = item.command;
  return commandSpec(item.type).space === "canvas" ? canvasSpaceDocName(projectId, spaceId!) : projectMetaDocName(projectId);
}

/**
 * The round key of an entry: the document of a write, so writes to one
 * document run in order on one instance; the entry itself otherwise.
 * @param entry - The stream entry.
 * @returns The key.
 */
function keyOf(entry: StreamEntry): string {
  const read = readEntry(entry);
  if (read && "command" in read && commandSpec(read.type).write) return docNameOf(read);
  return `entry:${entry.id}`;
}

/**
 * Start taking external-agent commands, unless this instance is set not to.
 * @param deps - Server, database, names, switch and settings.
 * @returns The running consumer, or null when `consume` is off.
 */
export function startAgentCommandConsumer(deps: AgentCommandConsumerDeps): GroupConsumer | null {
  if (!deps.consume) return null;
  const { hocuspocus, prefix, settings } = deps;
  const mcp: Redis = createRedisClient(deps.redisUrl, { name: "collab-agent-commands" });
  mcp.on("error", (err) => logger.error({ err, client: "collab-agent-commands" }, "redis_error"));
  const lease = createDocLease({
    hocuspocus,
    coordination: getCollabRedis(),
    keyPrefix: prefix,
    instanceId: deps.instanceId,
    settings,
    source: SOURCE,
    logTag: "agent",
  });

  /**
   * Run a read on a document without the lease.
   * @param docName - The document.
   * @param read - What to read.
   * @returns What it read.
   * @throws {Error} When the document cannot be opened.
   */
  async function readDoc<T>(docName: string, read: (doc: Y.Doc) => T): Promise<T> {
    const connection = await hocuspocus.openDirectConnection(docName, {
      context: { user: { id: "system" }, source: SOURCE },
    });
    try {
      return read(connection.document!);
    } finally {
      // Not awaited: the unload behind it waits about a second for peers
      // (`@hocuspocus/extension-redis` `disconnectDelay`), and a read has
      // nothing to store, so the answer need not wait for it.
      void connection.disconnect().catch((err: unknown) => {
        logger.warn({ err, docName }, "agent_read_disconnect_failed");
      });
    }
  }

  /**
   * Write a command's reply once, announce it, and log what was done.
   * @param callId - The call.
   * @param answer - The reply.
   * @param item - The command, when it was read; for the log line.
   * @throws {Error} When Redis rejects the write; the entry is retried.
   */
  async function reply(callId: string, answer: Answer, item?: Item): Promise<void> {
    const body: AgentReply = { callId, ...answer };
    await mcp.set(mcpReplyKey(prefix, callId), JSON.stringify(body), "EX", getMcpConfig().reply_ttl_seconds, "NX");
    await mcp.publish(mcpDoneChannel(prefix), callId);
    logger.info(
      {
        callId,
        type: item?.type,
        userId: item?.command.userId,
        connectionId: item?.command.connectionId,
        projectId: item?.command.projectId,
        spaceId: item?.command.spaceId,
        outcome: answer.status === "rejected" ? `rejected:${answer.reason}` : answer.status,
        durationMs: item ? Date.now() - item.startedAt : undefined,
      },
      "agent_command_executed",
    );
  }

  /**
   * Whether the user may run this command now; counts it against the rate
   * limit when every other check passes.
   * @param item - The command.
   * @returns The refusal, or null when it may run.
   * @throws {Error} When the database or Redis read fails.
   */
  async function refusalOf(item: Item): Promise<Answer | null> {
    const { command } = item;
    const spec = commandSpec(item.type);
    if (!(await agentAccessService.isCredentialUsable(command.credential))) {
      return { status: "rejected", reason: "credential_revoked" };
    }
    const role = await projectAuthService.loadProjectRole(command.userId, command.projectId);
    const studioId = role === null ? undefined : await projectsRepo.findOwnerStudioId(command.projectId);
    if (role === null || studioId === undefined) return { status: "rejected", reason: "no_access" };
    if (spec.write && role === "viewer") return { status: "rejected", reason: "read_only" };
    if (spec.space === "canvas") {
      const listed = await readDoc(projectMetaDocName(command.projectId), (meta) =>
        listedContentDocNames(command.projectId, meta.getMap("spaces")).has(docNameOf(item)),
      );
      if (!listed) return { status: "rejected", reason: "not_found" };
    }
    const verdict = await checkRateLimit(mcp, [
      {
        key: `mcp:rate:${command.userId}:${studioId}`,
        max: getMcpConfig().rate_limit.commands_per_minute,
        windowSeconds: 60,
      },
    ]);
    return verdict.allowed ? null : { status: "rejected", reason: "rate_limited" };
  }

  /**
   * Answer a read command.
   * @param item - The command.
   * @returns The outcome of its entry.
   */
  async function runRead(item: Item): Promise<EntryOutcome> {
    const spec = commandSpec(item.type);
    try {
      const refused = await refusalOf(item);
      if (refused) {
        await reply(item.command.callId, refused, item);
        return "done";
      }
      if (Date.now() >= item.command.deadlineAt) {
        await reply(item.command.callId, { status: "unfinished" }, item);
        return "done";
      }
      const answer = await readDoc(docNameOf(item), (doc) => spec.run(doc, item.params, item.command));
      await reply(item.command.callId, answer, item);
      return "done";
    } catch (err) {
      logger.error({ err, ctx: { callId: item.command.callId, type: item.type, projectId: item.command.projectId } }, "agent_command_failed");
      return { failed: err };
    }
  }

  /**
   * Run one document's write commands under its lease, then reply to each.
   * @param docName - The document.
   * @param items - Its commands, in stream order.
   * @param stopping - True once the consumer is stopping.
   * @returns The outcome of every entry.
   */
  async function runWrites(docName: string, items: Item[], stopping: () => boolean): Promise<Map<string, EntryOutcome>> {
    const outcomes = new Map<string, EntryOutcome>();
    const written = await lease.write(docName, stopping, async (connection, signal) => {
      const answers = new Map<string, Answer | { failed: unknown }>();
      for (const item of items) {
        if (stopping() || signal.aborted) break;
        try {
          const refused = await refusalOf(item);
          if (refused) {
            answers.set(item.entry.id, refused);
            continue;
          }
          const spec = commandSpec(item.type);
          let answer: Answer = { status: "unfinished" };
          // The deadline is compared inside the transaction, on every
          // delivery: past it, nothing is written (§6, gRPC deadlines).
          await connection.transact((doc) => {
            answer = Date.now() >= item.command.deadlineAt
              ? spec.late(doc, item.params, item.command)
              : spec.run(doc, item.params, item.command);
          });
          answers.set(item.entry.id, answer);
        } catch (err) {
          logger.error({ err, ctx: { callId: item.command.callId, type: item.type, docName } }, "agent_command_failed");
          answers.set(item.entry.id, { failed: err });
        }
      }
      return { value: answers };
    });
    if (written === "wait" || "failed" in written) {
      for (const item of items) outcomes.set(item.entry.id, written);
      return outcomes;
    }
    // Replies go out once the document is stored and handed over, so an
    // agent told "done" reads its change from any instance.
    for (const item of items) {
      const answer = written.value.get(item.entry.id);
      if (answer === undefined) {
        outcomes.set(item.entry.id, "wait");
      } else if ("failed" in answer) {
        outcomes.set(item.entry.id, answer);
      } else {
        try {
          await reply(item.command.callId, answer, item);
          outcomes.set(item.entry.id, "done");
        } catch (err) {
          logger.error({ err, ctx: { callId: item.command.callId, type: item.type, docName } }, "agent_command_reply_failed");
          outcomes.set(item.entry.id, { failed: err });
        }
      }
    }
    return outcomes;
  }

  /**
   * Handle one round: answer what needs no running, skip what is answered
   * already, then run the reads or the document's writes.
   * @param entries - One key's entries, in the order taken.
   * @param stopping - True once the consumer is stopping.
   * @returns The outcome of every entry.
   */
  async function runRound(entries: StreamEntry[], stopping: () => boolean): Promise<Map<string, EntryOutcome>> {
    const outcomes = new Map<string, EntryOutcome>();
    const writes: Item[] = [];
    for (const entry of entries) {
      const read = readEntry(entry);
      try {
        if (read === null) {
          logger.warn({ id: entry.id, raw: entry.payload }, "agent_command_unreadable_skipped");
          outcomes.set(entry.id, "done");
        } else if (!("command" in read)) {
          await reply(read.callId, read.refused);
          outcomes.set(entry.id, "done");
        } else if ((await mcp.exists(mcpReplyKey(prefix, read.command.callId))) === 1) {
          outcomes.set(entry.id, "done");
        } else if (commandSpec(read.type).write) {
          writes.push(read);
        } else {
          outcomes.set(entry.id, await runRead(read));
        }
      } catch (err) {
        logger.error({ err, ctx: { id: entry.id } }, "agent_command_failed");
        outcomes.set(entry.id, { failed: err });
      }
    }
    if (writes.length > 0 && !stopping()) {
      for (const [id, outcome] of await runWrites(docNameOf(writes[0]!), writes, stopping)) outcomes.set(id, outcome);
    }
    return outcomes;
  }

  const consumer = startGroupConsumer({
    streamUrl: deps.redisUrl,
    streamKey: mcpCommandStreamKey(prefix),
    group: AGENT_COMMANDS_GROUP,
    consumer: deps.instanceId,
    payloadField: COMMAND_FIELD,
    failuresKey: `${prefix}:mcp:command-failures`,
    coordination: mcp,
    settings,
    keyOf,
    // A command that kept failing is answered as not finished (§6).
    onDeadLettered: async (entry) => {
      const read = readEntry(entry);
      if (read === null) return;
      await reply("command" in read ? read.command.callId : read.callId, { status: "unfinished" }, "command" in read ? read : undefined);
    },
    process: (entries, control) => runRound(entries, control.stopping),
  });

  return {
    stop: async (): Promise<void> => {
      await consumer.stop();
      await mcp.quit().catch(() => mcp.disconnect());
    },
  };
}
