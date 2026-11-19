// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Commands to collab over Redis DB 4, and their replies (breatic#1488 §6).
 *
 * A call registers its call id, appends the command with its submission
 * record, then waits for collab's announcement on the done channel and reads
 * the reply key. One subscription per process serves every waiting call.
 * Pub/sub delivers at most once and drops what arrives while the subscriber
 * reconnects, so each confirmed subscription after the first reads every
 * waiting call's reply key, and every wait reads its key once more when it
 * ends.
 */

import { createLogger, type Redis } from "@breatic/core";
import {
  AGENT_COMMAND_FIELD,
  AGENT_COMMAND_STREAM_MAXLEN,
  agentCommandParamsSchemas,
  agentCommandSchema,
  agentReplySchema,
  isAgentCommandType,
  mcpCommandStreamKey,
  mcpDoneChannel,
  mcpOperationKey,
  mcpReplyKey,
  type AgentCommand,
  type AgentReply,
} from "@breatic/shared";
import { z } from "zod";

const logger = createLogger("command-channel");

/** What a submitted command left behind for `get_operation_result`. */
const operationRecordSchema = z.object({
  type: z.string(),
  submittedAt: z.number(),
  deadlineAt: z.number(),
  connectionId: z.string(),
  projectId: z.string(),
  spaceId: z.string().nullable(),
});

/** How one submit ended. */
export type SubmitOutcome = { kind: "reply"; reply: AgentReply } | { kind: "submitted"; callId: string };

/** Where an earlier command ran: its Project and Space. */
export interface OperationPlace {
  projectId: string;
  spaceId: string | null;
}

/** Where an earlier call stands. `type` lets the caller word an unfinished capture. */
export type OperationOutcome =
  | { kind: "reply"; reply: AgentReply; type: string; place: OperationPlace }
  | { kind: "running"; type: string; place: OperationPlace }
  | { kind: "unfinished"; type: string; place: OperationPlace }
  | { kind: "expired" };

/** The command channel one process holds. */
export interface CommandChannel {
  /** Send a command and wait up to `waitMs` for its reply. */
  submit: (command: AgentCommand, waitMs: number) => Promise<SubmitOutcome>;
  /** Send a command nobody waits on. */
  send: (command: AgentCommand) => Promise<void>;
  /** Look up an earlier call of this connection, without waiting. */
  operationResult: (callId: string, connectionId: string) => Promise<OperationOutcome>;
  /** Stop listening; calls still waiting read their reply key and return. */
  close: () => Promise<void>;
}

/** What the channel runs on. */
export interface CommandChannelDeps {
  /** Writes commands and reads replies. */
  redis: Redis;
  /** A connection of its own for the done channel; the channel takes it over. */
  subscriber: Redis;
  /** The deployment's Redis key prefix. */
  prefix: string;
  /** How long a submission record lives: `call_timeout_ms` plus `reply_ttl_seconds`. */
  operationTtlSeconds: number;
}

/**
 * Check a command against the shared format before it reaches the stream.
 * @param command - The command.
 * @returns The command.
 * @throws {z.ZodError} When the command or its parameters do not match.
 */
function validated(command: AgentCommand): AgentCommand {
  agentCommandSchema.parse(command);
  if (!isAgentCommandType(command.type)) {
    throw new z.ZodError([{ code: "custom", path: ["type"], message: `unknown command type ${command.type}`, input: command.type }]);
  }
  agentCommandParamsSchemas[command.type].parse(command.params);
  return command;
}

/**
 * Open the channel and subscribe to the done channel.
 * @param deps - What it runs on.
 * @returns The channel, once the subscription is confirmed.
 */
export async function createCommandChannel(deps: CommandChannelDeps): Promise<CommandChannel> {
  const { redis, subscriber, prefix, operationTtlSeconds } = deps;
  const doneChannel = mcpDoneChannel(prefix);
  const streamKey = mcpCommandStreamKey(prefix);
  const waiters = new Map<string, () => void>();

  /**
   * Read one call's reply.
   * @param callId - The call.
   * @returns The reply, or null when none is written.
   */
  const readReply = async (callId: string): Promise<AgentReply | null> => {
    const raw = await redis.get(mcpReplyKey(prefix, callId));
    return raw === null ? null : agentReplySchema.parse(JSON.parse(raw));
  };

  /** Wake every waiting call whose reply is already written. */
  const recheck = async (): Promise<void> => {
    const ids = [...waiters.keys()];
    if (ids.length === 0) return;
    const raws = await redis.mget(ids.map((id) => mcpReplyKey(prefix, id)));
    ids.forEach((id, i) => {
      if (raws[i] !== null) waiters.get(id)?.();
    });
  };

  subscriber.on("message", (from: string, callId: string) => {
    if (from === doneChannel) waiters.get(callId)?.();
  });
  await subscriber.subscribe(doneChannel);
  subscriber.on("ready", () => {
    subscriber.subscribe(doneChannel).then(recheck, (err: unknown) => {
      logger.error({ err }, "mcp_done_resubscribe_failed");
    });
  });

  return {
    async submit(command, waitMs) {
      const c = validated(command);
      const woken = new Promise<void>((resolve) => waiters.set(c.callId, resolve));
      let timer: NodeJS.Timeout | undefined;
      try {
        const record = {
          type: c.type,
          submittedAt: c.submittedAt,
          deadlineAt: c.deadlineAt,
          connectionId: c.connectionId,
          projectId: c.projectId,
          spaceId: c.spaceId,
        };
        const results = await redis
          .multi()
          .set(mcpOperationKey(prefix, c.callId), JSON.stringify(record), "EX", operationTtlSeconds)
          .xadd(streamKey, "MAXLEN", "~", String(AGENT_COMMAND_STREAM_MAXLEN), "*", AGENT_COMMAND_FIELD, JSON.stringify(c))
          .exec();
        const failed = results?.find(([err]) => err !== null)?.[0];
        if (results === null || failed) throw failed ?? new Error("command transaction was discarded");
        await Promise.race([woken, new Promise<void>((resolve) => (timer = setTimeout(resolve, waitMs)))]);
        const reply = await readReply(c.callId);
        return reply === null ? { kind: "submitted", callId: c.callId } : { kind: "reply", reply };
      } finally {
        clearTimeout(timer);
        waiters.delete(c.callId);
      }
    },

    async send(command) {
      const c = validated(command);
      await redis.xadd(streamKey, "MAXLEN", "~", String(AGENT_COMMAND_STREAM_MAXLEN), "*", AGENT_COMMAND_FIELD, JSON.stringify(c));
    },

    async operationResult(callId, connectionId) {
      const raw = await redis.get(mcpOperationKey(prefix, callId));
      const record = raw === null ? null : operationRecordSchema.parse(JSON.parse(raw));
      // The submission record outlives the reply, so a call without one is
      // past both, or was never this connection's.
      if (record === null || record.connectionId !== connectionId) return { kind: "expired" };
      const place = { projectId: record.projectId, spaceId: record.spaceId };
      const reply = await readReply(callId);
      if (reply !== null) return { kind: "reply", reply, type: record.type, place };
      return { kind: Date.now() < record.deadlineAt ? "running" : "unfinished", type: record.type, place };
    },

    async close() {
      for (const wake of waiters.values()) wake();
      subscriber.removeAllListeners("ready");
      await subscriber.unsubscribe(doneChannel).catch(() => {});
      await subscriber.quit().catch(() => {});
    },
  };
}
