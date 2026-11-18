// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only
import { randomUUID } from "node:crypto";
import { createRedisClient, type Redis } from "@breatic/core";
import {
  AGENT_COMMAND_FIELD,
  agentCommandSchema,
  mcpCommandStreamKey,
  mcpDoneChannel,
  mcpOperationKey,
  mcpReplyKey,
  type AgentCommand,
  type AgentReply,
} from "@breatic/shared";
import { afterAll, afterEach, beforeAll, describe, expect, inject, it } from "vitest";
import { createCommandChannel, type CommandChannel } from "@mcp/command-channel.js";

const OPERATION_TTL_SECONDS = 645;
let redis: Redis;
let subscriber: Redis;
let channel: CommandChannel;
let prefix: string;

beforeAll(async () => {
  redis = createRedisClient(inject("REDIS_MCP_URL"), { name: "mcp-test" });
  await redis.connect();
});
afterAll(async () => {
  await redis.quit();
});
afterEach(async () => {
  await channel.close();
});

/**
 * A fresh prefix and a channel on it, so suites never see each other's keys.
 * @returns The channel.
 */
async function openChannel(): Promise<CommandChannel> {
  prefix = `mcp-test-${randomUUID().slice(0, 8)}`;
  subscriber = createRedisClient(inject("REDIS_MCP_URL"), { name: "mcp-test-sub" });
  channel = await createCommandChannel({ redis, subscriber, prefix, operationTtlSeconds: OPERATION_TTL_SECONDS });
  return channel;
}

/**
 * A command as a tool would build it.
 * @param over - Fields to replace.
 * @returns The command.
 */
function commandOf(over: Partial<AgentCommand> = {}): AgentCommand {
  const now = Date.now();
  return {
    callId: randomUUID(),
    type: "read_canvas",
    userId: randomUUID(),
    connectionId: randomUUID(),
    credential: { type: "oauth", grantId: "grant-1" },
    projectId: randomUUID(),
    spaceId: randomUUID(),
    params: {},
    submittedAt: now,
    deadlineAt: now + 45_000,
    ...over,
  };
}

/**
 * Every command in the stream, as collab would read them.
 * @returns The commands.
 */
async function streamed(): Promise<AgentCommand[]> {
  const entries = await redis.xrange(mcpCommandStreamKey(prefix), "-", "+");
  return entries.map(([, fields]) => {
    const at = fields.indexOf(AGENT_COMMAND_FIELD);
    return agentCommandSchema.parse(JSON.parse(fields[at + 1]!));
  });
}

/**
 * Answer a command the way collab does.
 * @param reply - The reply.
 * @param announce - Whether to publish it on the done channel.
 */
async function answer(reply: AgentReply, announce = true): Promise<void> {
  await redis.set(mcpReplyKey(prefix, reply.callId), JSON.stringify(reply), "EX", 600);
  if (announce) await redis.publish(mcpDoneChannel(prefix), reply.callId);
}

/**
 * Answer a command as soon as it reaches the stream.
 * @param callId - The command.
 * @param reply - The reply.
 * @param announce - Whether to publish it.
 */
async function answerWhenStreamed(callId: string, reply: AgentReply, announce = true): Promise<void> {
  for (let i = 0; i < 200; i++) {
    if ((await streamed()).some((c) => c.callId === callId)) return answer(reply, announce);
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error(`command ${callId} never reached the stream`);
}

describe("submit", () => {
  it("writes the command collab reads and returns the reply it publishes", async () => {
    await openChannel();
    const command = commandOf({ params: { nodeIds: ["n1"] } });
    const reply: AgentReply = { callId: command.callId, status: "done", result: { ok: 1 } };
    const [outcome] = await Promise.all([channel.submit(command, 5_000), answerWhenStreamed(command.callId, reply)]);
    expect(outcome).toEqual({ kind: "reply", reply });
    expect(await streamed()).toEqual([command]);
  });

  it("returns the call id when no reply arrives in the wait, and keeps the submission record", async () => {
    await openChannel();
    const command = commandOf({ type: "view_user_screen" });
    const started = Date.now();
    expect(await channel.submit(command, 300)).toEqual({ kind: "submitted", callId: command.callId });
    expect(Date.now() - started).toBeGreaterThanOrEqual(290);
    const key = mcpOperationKey(prefix, command.callId);
    expect(JSON.parse((await redis.get(key))!)).toEqual({
      type: "view_user_screen",
      submittedAt: command.submittedAt,
      deadlineAt: command.deadlineAt,
      connectionId: command.connectionId,
      projectId: command.projectId,
      spaceId: command.spaceId,
    });
    const ttl = await redis.ttl(key);
    expect(ttl).toBeGreaterThan(OPERATION_TTL_SECONDS - 5);
    expect(ttl).toBeLessThanOrEqual(OPERATION_TTL_SECONDS);
  });

  it("reads the reply key when its announcement never came", async () => {
    await openChannel();
    const command = commandOf();
    const reply: AgentReply = { callId: command.callId, status: "rejected", reason: "locked" };
    const [outcome] = await Promise.all([channel.submit(command, 400), answerWhenStreamed(command.callId, reply, false)]);
    expect(outcome).toEqual({ kind: "reply", reply });
  });

  it("picks up replies written while the subscriber was reconnecting", async () => {
    await openChannel();
    const command = commandOf();
    const reply: AgentReply = { callId: command.callId, status: "done", result: null };
    const started = Date.now();
    const pending = channel.submit(command, 10_000);
    for (let i = 0; i < 200 && (await streamed()).length === 0; i++) await new Promise((r) => setTimeout(r, 10));
    subscriber.disconnect(true);
    await answer(reply);
    expect(await pending).toEqual({ kind: "reply", reply });
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it("gives each of many concurrent calls its own reply over one subscription", async () => {
    await openChannel();
    const commands = Array.from({ length: 40 }, () => commandOf());
    const outcomes = Promise.all(commands.map((c) => channel.submit(c, 10_000)));
    await Promise.all(commands.map((c) => answerWhenStreamed(c.callId, { callId: c.callId, status: "done", result: c.callId })));
    expect((await outcomes).map((o) => (o.kind === "reply" && o.reply.status === "done" ? o.reply.result : null))).toEqual(commands.map((c) => c.callId));
    const [, subscribers] = (await redis.pubsub("NUMSUB", mcpDoneChannel(prefix))) as [string, number];
    expect(subscribers).toBe(1);
  });

  it("refuses a command that does not match the shared format and writes nothing", async () => {
    await openChannel();
    await expect(channel.submit(commandOf({ type: "no_such_command" }), 100)).rejects.toThrow();
    await expect(channel.submit(commandOf({ type: "touch_presence", params: { focus: [] } }), 100)).rejects.toThrow();
    expect(await streamed()).toEqual([]);
  });
});

describe("send", () => {
  it("writes a light command without a submission record", async () => {
    await openChannel();
    const command = commandOf({ type: "touch_presence", params: {} });
    await channel.send(command);
    expect(await streamed()).toEqual([command]);
    expect(await redis.exists(mcpOperationKey(prefix, command.callId))).toBe(0);
  });
});

describe("operationResult", () => {
  it("answers each state of an earlier call in the design's order", async () => {
    await openChannel();
    const done = commandOf();
    const running = commandOf();
    const late = commandOf({ deadlineAt: Date.now() - 1 });
    for (const c of [done, running, late]) await channel.submit(c, 1);
    const reply: AgentReply = { callId: done.callId, status: "done", result: 7 };
    await answer(reply);

    expect(await channel.operationResult(done.callId, done.connectionId)).toEqual({ kind: "reply", reply });
    expect(await channel.operationResult(running.callId, running.connectionId)).toEqual({ kind: "running" });
    expect(await channel.operationResult(late.callId, late.connectionId)).toEqual({ kind: "unfinished", type: "read_canvas" });
    expect(await channel.operationResult(randomUUID(), done.connectionId)).toEqual({ kind: "expired" });
  });

  it("treats another connection's call as one it never made", async () => {
    await openChannel();
    const command = commandOf();
    await channel.submit(command, 1);
    await answer({ callId: command.callId, status: "done", result: 1 });
    expect(await channel.operationResult(command.callId, randomUUID())).toEqual({ kind: "expired" });
  });
});
