// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * External-agent commands executed by collab (#1488 §6, §15.5), across two
 * collab instances that share Redis and Postgres the way production runs
 * them. The MCP service's side is played by the test: it appends a command to
 * the DB 4 stream and reads the reply key, exactly the two things the MCP
 * service does.
 */

import { describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { sql as dsql } from "drizzle-orm";

import { agentAccessService, db, env, getMcpConfig, getStreamRedis } from "@breatic/core";
import * as Y from "yjs";
import {
  agentPresenceKey,
  agentPresenceRecordSchema,
  callScopedId,
  mcpCaptureRequestKey,
  mcpCaptureRequestSchema,
  mcpCommandStreamKey,
  mcpDoneChannel,
  mcpReplyKey,
  projectMetaDocName,
  viewCaptureRequestedChannel,
} from "@breatic/shared";
import { markOnline } from "@collab/hooks/presence.js";
import { getCollabConfig } from "@collab/config.js";
import {
  call,
  canvasNodes,
  consumeOn,
  harness,
  nameOf,
  nodeName,
  replyOf,
  seedWorld,
  send,
  useAgentCommandHarness,
  type World,
} from "@collab/services/__tests__/agent-command-harness.js";

useAgentCommandHarness();

describe("configuration", () => {
  it("takes commands on every instance unless agent_commands.consume turns it off", () => {
    expect(getCollabConfig().agent_commands.consume).toBe(true);
  });

  it("starts no consumer on an instance with consume off, so its commands wait for another", async () => {
    const world = await seedWorld();
    expect(consumeOn(world, harness.instanceA, false)).toBeNull();
    const { callId } = await send(world, "list_spaces", {});
    expect(await replyOf(world, callId, 800)).toBeNull();
    consumeOn(world, harness.instanceB);
    expect(await replyOf(world, callId)).toMatchObject({ status: "done" });
  });
});

describe("reads", () => {
  it("lists the Project's Spaces and announces the reply on mcp:done", async () => {
    const world = await seedWorld();
    const sub = harness.mcp.duplicate();
    const heard: string[] = [];
    await sub.subscribe(mcpDoneChannel(world.prefix));
    sub.on("message", (_c, m) => heard.push(m));
    try {
      consumeOn(world, harness.instanceA);
      const { callId } = await send(world, "list_spaces", {});
      const reply = await replyOf(world, callId);
      expect(reply).toMatchObject({ callId, status: "done", result: { spaces: [{ id: world.spaceId, type: "canvas", name: "Board" }] } });
      await expect.poll(() => heard).toContain(callId);
    } finally {
      sub.disconnect();
    }
  });

  it("reads the canvas nodes, or only the ones asked for", async () => {
    const world = await seedWorld();
    consumeOn(world, harness.instanceA);
    const all = await replyOf(world, (await send(world, "read_canvas", {})).callId);
    expect(all).toMatchObject({ status: "done", result: { nodes: [{ id: world.nodeId, type: "text" }] } });
    const some = await replyOf(world, (await send(world, "read_canvas", { nodeIds: [randomUUID()] })).callId);
    expect(some).toMatchObject({ status: "done", result: { nodes: [] } });
  });

  it("keeps the reply for at most reply_ttl_seconds", async () => {
    const world = await seedWorld();
    consumeOn(world, harness.instanceA);
    const { callId } = await send(world, "list_spaces", {});
    await replyOf(world, callId);
    const ttl = await harness.mcp.ttl(mcpReplyKey(world.prefix, callId));
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(getMcpConfig().reply_ttl_seconds);
  });
});

describe("writes", () => {
  it("renames a node, and the change is in the document every instance serves", async () => {
    const world = await seedWorld();
    consumeOn(world, harness.instanceA);
    const reply = await replyOf(world, (await send(world, "update_canvas_node", { nodeId: world.nodeId, name: "Hero shot" })).callId);
    expect(reply).toMatchObject({ status: "done" });
    await expect.poll(() => nodeName(harness.instanceB, world, world.nodeId)).toBe("Hero shot");
  });

  it("creates nodes with ids derived from the call id", async () => {
    const world = await seedWorld();
    consumeOn(world, harness.instanceA);
    const command = await send(world, "create_canvas_nodes", { nodes: [{ type: "text", name: "Script" }, { type: "image" }] });
    const reply = await replyOf(world, command.callId);
    const ids = [callScopedId(command.callId, "node:0"), callScopedId(command.callId, "node:1")];
    expect(reply).toMatchObject({ status: "done", result: { nodeIds: ids } });
    const nodes = await canvasNodes(harness.instanceA, world);
    expect(nodes.filter((n) => ids.includes(n.id)).map((n) => n.type).sort()).toEqual(["image", "text"]);
  });

  it("executes a call id once, however many times it is delivered", async () => {
    const world = await seedWorld();
    consumeOn(world, harness.instanceA);
    consumeOn(world, harness.instanceB);
    const command = await send(world, "create_canvas_nodes", { nodes: [{ type: "text" }] });
    await replyOf(world, command.callId);
    await harness.mcp.xadd(mcpCommandStreamKey(world.prefix), "*", "command", JSON.stringify(command));
    await new Promise((r) => setTimeout(r, 500));
    const nodes = await canvasNodes(harness.instanceA, world);
    expect(nodes.filter((n) => n.id === callScopedId(command.callId, "node:0"))).toHaveLength(1);
    expect(nodes).toHaveLength(2);
  });

  it("lands both of two writes to one document taken by two instances", async () => {
    const world = await seedWorld();
    consumeOn(world, harness.instanceA);
    consumeOn(world, harness.instanceB);
    const first = await send(world, "create_canvas_nodes", { nodes: [{ type: "text", name: "One" }] });
    const second = await send(world, "create_canvas_nodes", { nodes: [{ type: "text", name: "Two" }] });
    expect(await replyOf(world, first.callId)).toMatchObject({ status: "done" });
    expect(await replyOf(world, second.callId)).toMatchObject({ status: "done" });
    await expect.poll(async () => (await canvasNodes(harness.instanceA, world)).map(nameOf).sort()).toEqual(expect.arrayContaining(["One", "Two"]));
  });
});

describe("deadlines", () => {
  it("does not write a command whose deadline passed, and says it did not finish", async () => {
    const world = await seedWorld();
    const command = await send(world, "update_canvas_node", { nodeId: world.nodeId, name: "Too late" }, { deadlineAt: Date.now() - 1 });
    consumeOn(world, harness.instanceA);
    expect(await replyOf(world, command.callId)).toEqual({ callId: command.callId, status: "unfinished" });
    expect(await nodeName(harness.instanceA, world, world.nodeId)).not.toBe("Too late");
  });

  it.each([
    ["read_canvas", {}],
    ["update_canvas_node", { name: "Late and revoked" }],
  ] as const)("answers %s past its deadline as unfinished even when its credential was revoked", async (type, params) => {
    const world = await seedWorld();
    const command = await send(world, type, type === "read_canvas" ? params : { nodeId: world.nodeId, ...params }, { deadlineAt: Date.now() - 1 });
    await agentAccessService.disconnect(world.connectionId, world.userId);
    consumeOn(world, harness.instanceA);
    expect(await replyOf(world, command.callId)).toEqual({ callId: command.callId, status: "unfinished" });
    expect(await nodeName(harness.instanceA, world, world.nodeId)).not.toBe("Late and revoked");
  });

  it("answers done for a late create whose nodes the first run already wrote", async () => {
    const world = await seedWorld();
    consumeOn(world, harness.instanceA);
    const command = await send(world, "create_canvas_nodes", { nodes: [{ type: "text" }] });
    await replyOf(world, command.callId);
    await harness.mcp.del(mcpReplyKey(world.prefix, command.callId));
    await harness.mcp.xadd(mcpCommandStreamKey(world.prefix), "*", "command", JSON.stringify({ ...command, deadlineAt: Date.now() - 1 }));
    expect(await replyOf(world, command.callId)).toMatchObject({ status: "done" });
  });
});

describe("refusals", () => {
  it.each(["viewer"] as const)("lets a %s read and refuses their writes as read_only", async (role) => {
    const world = await seedWorld(role);
    consumeOn(world, harness.instanceA);
    expect(await replyOf(world, (await send(world, "read_canvas", {})).callId)).toMatchObject({ status: "done" });
    expect(await replyOf(world, (await send(world, "update_canvas_node", { nodeId: world.nodeId, name: "x" })).callId)).toMatchObject({
      status: "rejected",
      reason: "read_only",
    });
  });

  it("refuses writes to an archived Project as read_only", async () => {
    const world = await seedWorld();
    await db.execute(dsql`UPDATE projects SET archived_at = now(), archived_by_user_id = ${world.userId} WHERE id = ${world.projectId}`);
    consumeOn(world, harness.instanceA);
    expect(await replyOf(world, (await send(world, "update_canvas_node", { nodeId: world.nodeId, name: "x" })).callId)).toMatchObject({
      status: "rejected",
      reason: "read_only",
    });
  });

  it("refuses a user with no part in the Project as no_access", async () => {
    const world = await seedWorld();
    const stranger = await seedWorld();
    consumeOn(world, harness.instanceA);
    const reply = await replyOf(world, (await send({ ...world, userId: stranger.userId, connectionId: stranger.connectionId, credential: stranger.credential }, "read_canvas", {})).callId);
    expect(reply).toMatchObject({ status: "rejected", reason: "no_access" });
  });

  it("refuses a command whose credential was revoked after it was sent, and does not write it", async () => {
    const world = await seedWorld();
    const command = await send(world, "update_canvas_node", { nodeId: world.nodeId, name: "After revoke" });
    await agentAccessService.disconnect(world.connectionId, world.userId);
    consumeOn(world, harness.instanceA);
    expect(await replyOf(world, command.callId)).toMatchObject({ status: "rejected", reason: "credential_revoked" });
    expect(await nodeName(harness.instanceA, world, world.nodeId)).not.toBe("After revoke");
  });

  it("refuses a command that does not match the command format as invalid_command", async () => {
    const world = await seedWorld();
    consumeOn(world, harness.instanceA);
    const command = await send(world, "update_canvas_node", { nodeId: 42 });
    expect(await replyOf(world, command.callId)).toMatchObject({ status: "rejected", reason: "invalid_command" });
  });

  it("refuses commands past commands_per_minute per user per Studio as rate_limited, each Studio counted on its own", async () => {
    const world = await seedWorld();
    consumeOn(world, harness.instanceA);
    const max = getMcpConfig().rate_limit.commands_per_minute;
    const calls: string[] = [];
    for (let i = 0; i < max; i++) calls.push((await send(world, "list_spaces", {})).callId);
    for (const callId of calls) expect(await replyOf(world, callId)).toMatchObject({ status: "done" });
    expect(await replyOf(world, (await send(world, "list_spaces", {})).callId)).toMatchObject({ status: "rejected", reason: "rate_limited" });
    const elsewhere = await seedWorld();
    consumeOn(elsewhere, harness.instanceB);
    expect(await replyOf(elsewhere, (await send(elsewhere, "list_spaces", {})).callId)).toMatchObject({ status: "done" });
  });
});

/**
 * The agent's presence record in the Project's meta document.
 * @param world - Whose agent.
 * @returns The record, or undefined when none was written.
 */
async function agentPresence(world: World): Promise<Record<string, unknown> | undefined> {
  const conn = await harness.instanceB.openDirectConnection(projectMetaDocName(world.projectId), {});
  try {
    const entry = conn.document!.getMap("users").get(agentPresenceKey(world.userId, world.connectionId));
    return entry instanceof Y.Map ? entry.toJSON() : undefined;
  } finally {
    await conn.disconnect();
  }
}

/**
 * Wait until the agent's record satisfies a check.
 * @param world - Whose agent.
 * @param check - What the record must show.
 * @returns The record.
 */
async function presenceWhen(world: World, check: (record: Record<string, unknown> | undefined) => boolean): Promise<Record<string, unknown> | undefined> {
  const deadline = Date.now() + 5000;
  for (;;) {
    const record = await agentPresence(world);
    if (check(record) || Date.now() > deadline) return record;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

describe("presence (§19.2)", () => {
  it("records the agent online in its Space with the nodes a command named, beside its owner", async () => {
    const world = await seedWorld();
    consumeOn(world, harness.instanceA);
    await call(world, "update_canvas_node", { nodeId: world.nodeId, name: "Seen" });
    const record = await presenceWhen(world, (r) => r !== undefined);
    expect(record).toMatchObject({ id: world.userId, online: true, agent: { connectionId: world.connectionId, spaceId: world.spaceId, focus: [world.nodeId] } });
    expect(agentPresenceRecordSchema.safeParse(record).success).toBe(true);
  });

  it("keeps the last focus across a whole-canvas read, and moves it to the nodes a create made", async () => {
    const world = await seedWorld();
    consumeOn(world, harness.instanceA);
    await call(world, "read_canvas", { nodeIds: [world.nodeId] });
    await presenceWhen(world, (r) => r !== undefined);
    await call(world, "read_canvas", {});
    expect(await agentPresence(world)).toMatchObject({ agent: { focus: [world.nodeId] } });
    const created = await send(world, "create_canvas_nodes", { nodes: [{ type: "text" }, { type: "text" }] });
    await replyOf(world, created.callId);
    const ids = [callScopedId(created.callId, "node:0"), callScopedId(created.callId, "node:1")];
    expect(await presenceWhen(world, (r) => JSON.stringify((r?.agent as { focus?: unknown })?.focus) === JSON.stringify(ids))).toMatchObject({ agent: { focus: ids } });
  });

  it("refreshes presence with touch_presence without counting it against commands_per_minute", async () => {
    const world = await seedWorld();
    consumeOn(world, harness.instanceA);
    const max = getMcpConfig().rate_limit.commands_per_minute;
    for (let i = 0; i < max; i++) await send(world, "touch_presence", i === 0 ? { focus: [world.nodeId] } : {});
    expect(await replyOf(world, (await send(world, "list_spaces", {})).callId, 20_000)).toMatchObject({ status: "done" });
    expect(await agentPresence(world)).toMatchObject({ online: true, agent: { spaceId: world.spaceId, focus: [world.nodeId] } });
  });

  it("writes no presence for a command it refused", async () => {
    const world = await seedWorld();
    const stranger = await seedWorld();
    consumeOn(world, harness.instanceA);
    const outsider = { ...world, userId: stranger.userId, connectionId: stranger.connectionId, credential: stranger.credential };
    expect(await call(outsider, "read_canvas", {})).toMatchObject({ status: "rejected", reason: "no_access" });
    expect(await agentPresence(outsider)).toBeUndefined();
  });
});

describe("view_user_screen (§19.1)", () => {
  /**
   * Mark the owner online in the project's meta document, as a browser connecting does.
   * @param world - Whose project.
   */
  async function ownerOnline(world: World): Promise<void> {
    const conn = await harness.instanceA.openDirectConnection(projectMetaDocName(world.projectId), {});
    try {
      await conn.transact((meta) => markOnline({ document: meta, userId: world.userId, now: Date.now() }));
    } finally {
      await conn.disconnect();
    }
  }

  it("answers not watching at once when the owner has the project open nowhere", async () => {
    const world = await seedWorld();
    consumeOn(world, harness.instanceA);
    expect(await call(world, "view_user_screen", {})).toMatchObject({ status: "done", result: { watching: false } });
  });

  it("asks the owner's browser for a capture, and answers not watching once view_capture.timeout_ms passes with no upload", async () => {
    const world = await seedWorld();
    await ownerOnline(world);
    const subscriber = getStreamRedis().duplicate();
    const heard: Array<Record<string, unknown>> = [];
    subscriber.on("message", (_channel: string, message: string) => heard.push(JSON.parse(message) as Record<string, unknown>));
    await subscriber.subscribe(viewCaptureRequestedChannel(env.REDIS_KEY_PREFIX, world.projectId));
    try {
      consumeOn(world, harness.instanceA);
      const command = await send(world, "view_user_screen", {});
      await waitUntil(() => heard.length > 0);
      const requestId = heard[0]!.requestId as string;
      expect(heard[0]).toMatchObject({ type: "project-view-capture:requested", projectId: world.projectId, userId: world.userId, requestId });
      expect(mcpCaptureRequestSchema.parse(JSON.parse((await harness.mcp.get(mcpCaptureRequestKey(world.prefix, requestId)))!))).toEqual({ userId: world.userId, callId: command.callId });
      expect(await harness.mcp.get(mcpReplyKey(world.prefix, command.callId))).toBeNull();
      expect(await replyOf(world, command.callId, getMcpConfig().view_capture.timeout_ms + 3000)).toMatchObject({ status: "done", result: { watching: false } });
    } finally {
      await subscriber.quit();
    }
  }, 30_000);
});

/**
 * Wait until a check holds.
 * @param check - The check.
 */
async function waitUntil(check: () => boolean): Promise<void> {
  const deadline = Date.now() + 5000;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("timed out");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}
