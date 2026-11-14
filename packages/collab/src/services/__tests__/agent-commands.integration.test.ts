// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

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

import { agentAccessService, db, getMcpConfig } from "@breatic/core";
import { callScopedId, mcpCommandStreamKey, mcpDoneChannel, mcpReplyKey } from "@breatic/shared";
import { getCollabConfig } from "@collab/config.js";
import {
  canvasNodes,
  consumeOn,
  harness,
  nameOf,
  nodeName,
  replyOf,
  seedWorld,
  send,
  useAgentCommandHarness,
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
