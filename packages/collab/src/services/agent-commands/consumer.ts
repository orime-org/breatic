// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

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

import { randomUUID } from "node:crypto";
import type { Hocuspocus } from "@hocuspocus/server";
import type * as Y from "yjs";
import {
  accountActivityRepo,
  agentAccessService,
  checkRateLimit,
  createLogger,
  createRedisClient,
  getCollabRedis,
  getMcpConfig,
  listedContentDocNames,
  projectAuthService,
  publishViewCaptureRequested,
  projectsRepo,
  type Redis,
} from "@breatic/core";
import {
  agentCommandSchema,
  DOCUMENT_SCHEMA_META_KEY,
  DOCUMENT_SCHEMA_VERSION,
  canvasSpaceDocName,
  documentSchemaDiffers,
  documentSpaceDocName,
  isAgentCommandType,
  mcpCaptureRequestKey,
  mcpCommandStreamKey,
  AGENT_COMMAND_FIELD,
  mcpDoneChannel,
  mcpReplyKey,
  projectMetaDocName,
  type AgentCommand,
  type AgentCommandType,
  type AgentReply,
  type ProjectRole,
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
import { measure, readDocSizeRecord } from "@collab/services/document-size.js";
import { getCollabConfig } from "@collab/config.js";
import { markAgentActive } from "@collab/hooks/presence.js";
import { sizeRefusalOf, type SpaceWriteKind } from "@breatic/shared/canvas-model";

const logger = createLogger("agent-commands");

/** Consumer group every collab instance that takes commands joins. */
export const AGENT_COMMANDS_GROUP = "collab-agent-commands";

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
  if (spec.space !== null && command.spaceId === null) return invalid;
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
  const space = commandSpec(item.type).space;
  if (space === "canvas") return canvasSpaceDocName(projectId, spaceId!);
  if (space === "document") return documentSpaceDocName(projectId, spaceId!);
  return projectMetaDocName(projectId);
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
 * Whether a Space document's size refuses a write of this kind, judged by
 * the browser's rule (shared `sizeRefusalOf`): at its limit only deletions
 * and removals run, past the hard ceiling only removals. The size record is
 * read when the document has one; otherwise the document is measured.
 * @param docName - The document.
 * @param doc - The loaded document.
 * @param kind - The write's size kind.
 * @returns True when the write is refused.
 * @throws {Error} When the collab YAML is missing or invalid.
 */
function refusedBySize(docName: string, doc: Y.Doc, kind: SpaceWriteKind): boolean {
  const cfg = getCollabConfig();
  if (cfg.max_document_bytes === 0) return false;
  const size = readDocSizeRecord(docName)?.current ?? measure(doc);
  const ceiling = cfg.max_document_bytes + cfg.document_size_delete_headroom_bytes;
  return sizeRefusalOf(size >= cfg.max_document_bytes, size >= ceiling, kind) !== null;
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
   * @param userId - Who reads, named in the connection's context.
   * @param read - What to read.
   * @returns What it read.
   * @throws {Error} When the document cannot be opened.
   */
  async function readDoc<T>(docName: string, userId: string, read: (doc: Y.Doc) => T): Promise<T> {
    const connection = await hocuspocus.openDirectConnection(docName, {
      context: { user: { id: userId }, source: SOURCE },
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
   * @returns The refusal, or the user's Project role when it may run.
   * @throws {Error} When the database or Redis read fails.
   */
  async function refusalOf(item: Item): Promise<{ refused: Answer } | { role: ProjectRole }> {
    const { command } = item;
    const spec = commandSpec(item.type);
    if (!(await agentAccessService.isCredentialUsable(command.credential))) {
      return { refused: { status: "rejected", reason: "credential_revoked" } };
    }
    const role = await projectAuthService.loadProjectRole(command.userId, command.projectId);
    const studioId = role === null ? undefined : await projectsRepo.findOwnerStudioId(command.projectId);
    if (role === null || studioId === undefined) return { refused: { status: "rejected", reason: "no_access" } };
    if (spec.write && role === "viewer") return { refused: { status: "rejected", reason: "read_only" } };
    if (spec.space !== null) {
      // The Space's document name carries its type, so a Space of another
      // type is not listed under it.
      const { listed, schemaDiffers } = await readDoc(projectMetaDocName(command.projectId), command.userId, (meta) => {
        const published = meta.getMap(DOCUMENT_SCHEMA_META_KEY);
        return {
          listed: listedContentDocNames(command.projectId, meta.getMap("spaces")).has(docNameOf(item)),
          schemaDiffers: documentSchemaDiffers(DOCUMENT_SCHEMA_VERSION, published.size === 0 ? undefined : published.toJSON()),
        };
      });
      if (!listed) return { refused: { status: "rejected", reason: "not_found" } };
      // As web's `use-document-schema-intercept.ts`: a build whose document
      // format is not the published one writes nothing; reads still run.
      if (spec.space === "document" && spec.write && schemaDiffers) {
        return { refused: { status: "rejected", reason: "schema_mismatch" } };
      }
    }
    if (!spec.counted) return { role };
    const verdict = await checkRateLimit(mcp, [
      {
        key: `mcp:rate:${command.userId}:${studioId}`,
        max: getMcpConfig().rate_limit.commands_per_minute,
        windowSeconds: 60,
      },
    ]);
    return verdict.allowed ? { role } : { refused: { status: "rejected", reason: "rate_limited" } };
  }

  /** Timers that answer a capture nobody uploaded, cleared on stop. */
  const captureTimers = new Set<NodeJS.Timeout>();

  /**
   * Ask the owner's browser for a capture (§19.1): register the request for
   * the upload route, ask the instance holding the owner's meta connections,
   * and answer "not watching" once `view_capture.timeout_ms` passes, unless
   * the upload answered first (both write the reply with SET NX).
   * @param item - The `view_user_screen` command.
   * @throws {Error} When Redis rejects the registration or the publish.
   */
  async function requestCapture(item: Item): Promise<void> {
    const { userId, projectId, callId } = item.command;
    const requestId = randomUUID();
    const { timeout_ms: timeoutMs } = getMcpConfig().view_capture;
    await mcp.set(mcpCaptureRequestKey(prefix, requestId), JSON.stringify({ userId, callId }), "PX", timeoutMs + 5000);
    await publishViewCaptureRequested(projectId, userId, requestId);
    const timer = setTimeout(() => {
      captureTimers.delete(timer);
      const body: AgentReply = { callId, status: "done", result: { watching: false } };
      mcp
        .set(mcpReplyKey(prefix, callId), JSON.stringify(body), "EX", getMcpConfig().reply_ttl_seconds, "NX")
        .then(async (written) => {
          if (written !== null) await mcp.publish(mcpDoneChannel(prefix), callId);
        })
        .catch((err: unknown) => logger.error({ err, ctx: { callId, requestId, projectId } }, "agent_capture_timeout_failed"));
    }, timeoutMs);
    timer.unref();
    captureTimers.add(timer);
    logger.info({ callId, requestId, userId, projectId }, "agent_capture_requested");
  }

  /**
   * Show the agent in the Project after a command it ran (§19.2): online, in
   * the command's Space, on the nodes or blocks the command named. A failure
   * is logged and does not fail the command, whose answer is already given.
   * @param item - The command that ran.
   * @param answer - Its answer, for the ids a create made.
   */
  async function recordPresence(item: Item, answer: Answer): Promise<void> {
    const { userId, connectionId, projectId, spaceId, callId } = item.command;
    try {
      const focus = commandSpec(item.type).focus(item.params, answer);
      const connection = await hocuspocus.openDirectConnection(projectMetaDocName(projectId), {
        context: { user: { id: userId }, source: SOURCE },
      });
      try {
        await connection.transact((meta) => markAgentActive({ document: meta, userId, connectionId, spaceId, focus, now: Date.now() }));
      } finally {
        // Not awaited, as in `readDoc`: the unload behind it waits about a
        // second for peers, and the record is already in the document.
        void connection.disconnect().catch((err: unknown) => {
          logger.warn({ err, projectId }, "agent_presence_disconnect_failed");
        });
      }
    } catch (err) {
      logger.error({ err, ctx: { operation: "record_agent_presence", callId, type: item.type, userId, projectId } }, "agent_presence_write_failed");
    }
  }

  /**
   * Answer a read command.
   * @param item - The command.
   * @returns The outcome of its entry.
   */
  async function runRead(item: Item): Promise<EntryOutcome> {
    const spec = commandSpec(item.type);
    try {
      // Past the deadline the answer is settled whatever the credential says
      // (§6, credential revocation row).
      if (Date.now() >= item.command.deadlineAt) {
        await reply(item.command.callId, { status: "unfinished" }, item);
        return "done";
      }
      const verdict = await refusalOf(item);
      if ("refused" in verdict) {
        await reply(item.command.callId, verdict.refused, item);
        return "done";
      }
      const answer = await readDoc(docNameOf(item), item.command.userId, (doc) =>
        spec.run(doc, item.params, item.command, verdict),
      );
      const watching = item.type === "view_user_screen" && answer.status === "done" && (answer.result as { watching?: unknown }).watching === true;
      if (watching) await requestCapture(item);
      else await reply(item.command.callId, answer, item);
      await recordPresence(item, answer);
      return "done";
    } catch (err) {
      logger.error({ err, ctx: { callId: item.command.callId, type: item.type, projectId: item.command.projectId } }, "agent_command_failed");
      return { failed: err };
    }
  }

  /**
   * Record a write as the user's edit of the Project, the account activity a
   * browser's sync records (`hooks/account-activity.ts`). A failure is logged
   * and does not fail the command, whose write is already stored.
   * @param item - The command that wrote.
   */
  async function recordEdit(item: Item): Promise<void> {
    const { userId, projectId, callId } = item.command;
    try {
      await accountActivityRepo.recordActivity({ userId, projectId, kind: "project_edit" });
    } catch (err) {
      logger.error({ err, ctx: { operation: "record_agent_edit", callId, type: item.type, userId, projectId } }, "agent_command_activity_failed");
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
    // The commands that ran, as opposed to refused or past their deadline.
    const ran = new Set<string>();
    const written = await lease.write(docName, stopping, async (connection, signal) => {
      const answers = new Map<string, Answer | { failed: unknown }>();
      for (const item of items) {
        if (stopping() || signal.aborted) break;
        try {
          // Past the deadline only `late` answers, whatever the credential
          // says (§6, credential revocation row).
          const verdict = Date.now() >= item.command.deadlineAt ? null : await refusalOf(item);
          if (verdict !== null && "refused" in verdict) {
            answers.set(item.entry.id, verdict.refused);
            continue;
          }
          const spec = commandSpec(item.type);
          let answer: Answer = { status: "unfinished" };
          // The write is the user's own edit, so the transaction names them.
          connection.context = { user: { id: item.command.userId }, source: SOURCE };
          // The deadline is compared inside the transaction, on every
          // delivery: past it, nothing is written (§6, gRPC deadlines).
          await connection.transact((doc) => {
            if (verdict === null || Date.now() >= item.command.deadlineAt) answer = spec.late(doc, item.params, item.command);
            else if (spec.size !== null && refusedBySize(docName, doc, typeof spec.size === "string" ? spec.size : spec.size(doc, item.params))) {
              answer = { status: "rejected", reason: "space_full" };
            }
            else {
              answer = spec.run(doc, item.params, item.command, verdict);
              ran.add(item.entry.id);
            }
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
          if (answer.status === "done") await recordEdit(item);
          if (ran.has(item.entry.id)) await recordPresence(item, answer);
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
    payloadField: AGENT_COMMAND_FIELD,
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
      for (const timer of captureTimers) clearTimeout(timer);
      captureTimers.clear();
      await consumer.stop();
      await mcp.quit().catch(() => mcp.disconnect());
    },
  };
}
