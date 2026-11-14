// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * External-agent commands executed by collab (#1488 §6, §15.5), across two
 * collab instances that share Redis and Postgres the way production runs
 * them. The MCP service's side is played by the test: it appends a command to
 * the DB 4 stream and reads the reply key, exactly the two things the MCP
 * service does.
 *
 * Every case uses its own key prefix, so a reply, a rate counter or a pending
 * entry from one case is never seen by another.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { Server, type Hocuspocus } from "@hocuspocus/server";
import { Redis as RedisExtension } from "@hocuspocus/extension-redis";
import * as Y from "yjs";
import { sql as dsql, type SQL } from "drizzle-orm";

import { agentAccessService, createRedisClient, db, getMcpConfig, initCore, type Redis } from "@breatic/core";
import {
  agentReplySchema,
  callScopedId,
  canvasSpaceDocName,
  mcpCommandStreamKey,
  mcpDoneChannel,
  mcpReplyKey,
  projectMetaDocName,
  type AgentCommand,
  type AgentReply,
} from "@breatic/shared";
import { addNodeInDoc, createEmptyNode, readNodes } from "@breatic/shared/canvas-model";
import * as yjsRepo from "@collab/services/yjs-documents.repo.js";
import { createPersistenceExtension, staysLoaded, storeDocumentNow } from "@collab/services/persistence.js";
import { createUnloadGate } from "@collab/hooks/unload-gate.js";
import { createChangeTrackingExtension } from "@collab/services/change-tracking.js";
import { getCollabConfig } from "@collab/config.js";
import type { GroupConsumer } from "@collab/services/stream-group-consumer.js";
import {
  startAgentCommandConsumer,
  type AgentCommandSettings,
} from "@collab/services/agent-commands/consumer.js";

const SETTINGS: AgentCommandSettings = {
  maxHeld: 64,
  blockMs: 100,
  leaseRetryMs: 50,
  claimIntervalMs: 15_000,
  claimIdleMs: 60_000,
  retryMinMs: 50,
  retryMaxMs: 200,
  maxFailures: 3,
  stopDeadlineMs: 3000,
  forgetIdleConsumerMs: 24 * 60 * 60 * 1000,
  keyConcurrency: 4,
  docLeaseMs: 30_000,
  handoffPollMs: 20,
  handoffWaitMs: 200,
};

/**
 * Run a statement on the business database.
 * @param query - The statement.
 * @returns Its rows.
 */
async function run<T>(query: SQL): Promise<T[]> {
  return (await db.execute(query)) as unknown as T[];
}
let instanceA: Hocuspocus;
let instanceB: Hocuspocus;
let mcp: Redis;
const servers: Server[] = [];
const consumers: GroupConsumer[] = [];

/**
 * One collab server wired as production wires it: change tracking,
 * persistence, the Redis extension, and the unload gate that stores a
 * document before it leaves memory (persistence writes only when the timed
 * loop or the unload gate grants a store).
 * @param name - Distinguishes the server's Redis clients.
 * @returns Its Hocuspocus instance.
 */
async function startInstance(name: string): Promise<Hocuspocus> {
  const storeGate: { current?: ReturnType<typeof createUnloadGate> } = {};
  const server = new Server({
    port: 0,
    quiet: true,
    stopOnSignals: false,
    debounce: 50,
    unloadImmediately: true,
    extensions: [
      createChangeTrackingExtension(),
      createPersistenceExtension(),
      new RedisExtension({
        createClient: () => createRedisClient(process.env.REDIS_COLLAB_URL!, { name }),
        prefix: "itest:agent-commands",
      }),
      {
        beforeUnloadDocument: async (payload: { documentName: string; document: Y.Doc }): Promise<void> => {
          await storeGate.current?.beforeUnloadDocument(payload);
        },
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ] as any[],
  });
  storeGate.current = createUnloadGate({
    instanceId: name,
    encode: (document: Y.Doc): Uint8Array => Y.encodeStateAsUpdate(document),
    staysLoaded: (docName) => staysLoaded(server.hocuspocus, docName),
    storeNow: ({ name: docName }) => storeDocumentNow(server.hocuspocus, docName),
    writeRescue: async () => "itest-rescue",
    writeRescueNote: async () => {},
    alert: async () => {},
    retry: { windowMs: 1500, intervalMs: 100, rescueReserveMs: 0 },
    shutdownDeadline: () => undefined,
  });
  await server.listen();
  servers.push(server);
  return server.hocuspocus;
}

beforeAll(async () => {
  initCore(process.env);
  mcp = createRedisClient(process.env.REDIS_MCP_URL!, { name: "itest-agent-commands-mcp" });
  instanceA = await startInstance("itest-agent-a");
  instanceB = await startInstance("itest-agent-b");
});

afterEach(async () => {
  await Promise.all(consumers.splice(0).map((c) => c.stop()));
});

afterAll(async () => {
  for (const server of servers) server.httpServer.close();
  mcp.disconnect();
});

interface World {
  prefix: string;
  userId: string;
  studioId: string;
  projectId: string;
  spaceId: string;
  connectionId: string;
  credential: AgentCommand["credential"];
  tokenId: string;
}

let seq = 0;

/**
 * A user who owns a Project with one canvas Space holding one text node, and
 * a personal access token for their agent.
 * @param role - The user's role on the Project.
 * @returns The world and the seeded node's id.
 */
async function seedWorld(role: "owner" | "editor" | "viewer" = "owner"): Promise<World & { nodeId: string }> {
  const tag = `agent-cmd-${process.pid}-${seq++}`;
  const [owner] = await run<{ id: string }>(dsql`
    INSERT INTO users (email, email_verified) VALUES (${`${tag}-o@example.com`}, true) RETURNING id`);
  const [studio] = await run<{ id: string }>(dsql`
    INSERT INTO studios (created_by_user_id, slug, type, name) VALUES (${owner!.id}, ${tag}, 'team', ${tag}) RETURNING id`);
  await db.execute(dsql`INSERT INTO studio_members (studio_id, user_id, role) VALUES (${studio!.id}, ${owner!.id}, 'admin')`);
  const [project] = await run<{ id: string }>(dsql`
    INSERT INTO projects (studio_id, created_by_user_id, name, slug) VALUES (${studio!.id}, ${owner!.id}, ${tag}, ${tag}) RETURNING id`);
  await db.execute(dsql`INSERT INTO project_members (project_id, user_id, role, added_by) VALUES (${project!.id}, ${owner!.id}, 'owner', null)`);
  let userId = owner!.id;
  if (role !== "owner") {
    const [member] = await run<{ id: string }>(dsql`
      INSERT INTO users (email, email_verified) VALUES (${`${tag}-m@example.com`}, true) RETURNING id`);
    await db.execute(dsql`INSERT INTO studio_members (studio_id, user_id, role) VALUES (${studio!.id}, ${member!.id}, 'member')`);
    await db.execute(dsql`INSERT INTO project_members (project_id, user_id, role, added_by) VALUES (${project!.id}, ${member!.id}, ${role}, ${owner!.id})`);
    userId = member!.id;
  }
  const spaceId = randomUUID();
  const meta = new Y.Doc();
  const entry = new Y.Map<unknown>();
  meta.getMap("spaces").set(spaceId, entry);
  entry.set("type", "canvas");
  entry.set("name", "Board");
  entry.set("order", 0);
  await yjsRepo.upsertDocData(projectMetaDocName(project!.id), Y.encodeStateAsUpdate(meta));
  const canvas = new Y.Doc();
  const node = createEmptyNode("text", { x: 0, y: 0 }, userId);
  addNodeInDoc(canvas, node);
  await yjsRepo.upsertDocData(canvasSpaceDocName(project!.id, spaceId), Y.encodeStateAsUpdate(canvas));
  const created = await agentAccessService.createPersonalAccessToken({ userId, name: "Claude Code", expiresAt: null });
  if (!created.ok) throw new Error("cap");
  return {
    prefix: `itest-${tag}`,
    userId,
    studioId: studio!.id,
    projectId: project!.id,
    spaceId,
    connectionId: created.connectionId,
    credential: { type: "pat", tokenId: created.tokenId },
    tokenId: created.tokenId,
    nodeId: node.id,
  };
}

/**
 * Start the consumer on an instance for a world's prefix.
 * @param world - The world.
 * @param hocuspocus - The instance.
 * @param consume - Whether this instance takes commands.
 * @returns The consumer, or null when it takes none.
 */
function consumeOn(world: World, hocuspocus: Hocuspocus, consume = true): GroupConsumer | null {
  const consumer = startAgentCommandConsumer({
    hocuspocus,
    redisUrl: process.env.REDIS_MCP_URL!,
    prefix: world.prefix,
    consume,
    instanceId: `itest-${randomUUID()}`,
    settings: SETTINGS,
  });
  if (consumer) consumers.push(consumer);
  return consumer;
}

/**
 * Append a command the way the MCP service does.
 * @param world - Whose command.
 * @param type - Command type.
 * @param params - Its parameters.
 * @param over - Fields to replace.
 * @returns The command.
 */
async function send(world: World, type: string, params: unknown, over: Partial<AgentCommand> = {}): Promise<AgentCommand> {
  const now = Date.now();
  const command: AgentCommand = {
    callId: randomUUID(),
    type,
    userId: world.userId,
    connectionId: world.connectionId,
    credential: world.credential,
    projectId: world.projectId,
    spaceId: type === "list_spaces" ? null : world.spaceId,
    params: params as AgentCommand["params"],
    submittedAt: now,
    deadlineAt: now + getMcpConfig().call_timeout_ms,
    ...over,
  };
  await mcp.xadd(mcpCommandStreamKey(world.prefix), "MAXLEN", "~", "10000", "*", "command", JSON.stringify(command));
  return command;
}

/**
 * Wait for a command's reply.
 * @param world - Whose command.
 * @param callId - The command.
 * @param timeoutMs - How long to wait.
 * @returns The reply, or null when none arrived in time.
 */
async function replyOf(world: World, callId: string, timeoutMs = 5000): Promise<AgentReply | null> {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    const raw = await mcp.get(mcpReplyKey(world.prefix, callId));
    if (raw !== null) return agentReplySchema.parse(JSON.parse(raw));
    await new Promise((r) => setTimeout(r, 25));
  }
  return null;
}

/**
 * The canvas as a fresh direct connection reads it.
 * @param hocuspocus - Which instance reads.
 * @param world - Whose canvas.
 * @returns Its nodes.
 */
async function canvasNodes(hocuspocus: Hocuspocus, world: World): Promise<ReturnType<typeof readNodes>> {
  const conn = await hocuspocus.openDirectConnection(canvasSpaceDocName(world.projectId, world.spaceId), {});
  try {
    let nodes: ReturnType<typeof readNodes> = [];
    await conn.transact((doc) => {
      nodes = readNodes(doc);
    });
    return nodes;
  } finally {
    await conn.disconnect();
  }
}

/**
 * A node's name; stickies carry none.
 * @param node - A node as `readNodes` reads it.
 * @returns Its name, or undefined.
 */
function nameOf(node: ReturnType<typeof readNodes>[number]): string | undefined {
  return (node.data as { name?: string }).name;
}

/**
 * The name of one node, as an instance serves it.
 * @param hocuspocus - Which instance reads.
 * @param world - Whose canvas.
 * @param nodeId - The node.
 * @returns Its name, or undefined.
 */
async function nodeName(hocuspocus: Hocuspocus, world: World, nodeId: string): Promise<string | undefined> {
  const node = (await canvasNodes(hocuspocus, world)).find((n) => n.id === nodeId);
  return node ? nameOf(node) : undefined;
}

describe("configuration", () => {
  it("takes commands on every instance unless agent_commands.consume turns it off", () => {
    expect(getCollabConfig().agent_commands.consume).toBe(true);
  });

  it("starts no consumer on an instance with consume off, so its commands wait for another", async () => {
    const world = await seedWorld();
    expect(consumeOn(world, instanceA, false)).toBeNull();
    const { callId } = await send(world, "list_spaces", {});
    expect(await replyOf(world, callId, 800)).toBeNull();
    consumeOn(world, instanceB);
    expect(await replyOf(world, callId)).toMatchObject({ status: "done" });
  });
});

describe("reads", () => {
  it("lists the Project's Spaces and announces the reply on mcp:done", async () => {
    const world = await seedWorld();
    const sub = mcp.duplicate();
    const heard: string[] = [];
    await sub.subscribe(mcpDoneChannel(world.prefix));
    sub.on("message", (_c, m) => heard.push(m));
    try {
      consumeOn(world, instanceA);
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
    consumeOn(world, instanceA);
    const all = await replyOf(world, (await send(world, "read_canvas", {})).callId);
    expect(all).toMatchObject({ status: "done", result: { nodes: [{ id: world.nodeId, type: "text" }] } });
    const some = await replyOf(world, (await send(world, "read_canvas", { nodeIds: [randomUUID()] })).callId);
    expect(some).toMatchObject({ status: "done", result: { nodes: [] } });
  });

  it("keeps the reply for at most reply_ttl_seconds", async () => {
    const world = await seedWorld();
    consumeOn(world, instanceA);
    const { callId } = await send(world, "list_spaces", {});
    await replyOf(world, callId);
    const ttl = await mcp.ttl(mcpReplyKey(world.prefix, callId));
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(getMcpConfig().reply_ttl_seconds);
  });
});

describe("writes", () => {
  it("renames a node, and the change is in the document every instance serves", async () => {
    const world = await seedWorld();
    consumeOn(world, instanceA);
    const reply = await replyOf(world, (await send(world, "update_canvas_node", { nodeId: world.nodeId, name: "Hero shot" })).callId);
    expect(reply).toMatchObject({ status: "done" });
    await expect.poll(() => nodeName(instanceB, world, world.nodeId)).toBe("Hero shot");
  });

  it("creates nodes with ids derived from the call id", async () => {
    const world = await seedWorld();
    consumeOn(world, instanceA);
    const command = await send(world, "create_canvas_nodes", { nodes: [{ type: "text", name: "Script" }, { type: "image" }] });
    const reply = await replyOf(world, command.callId);
    const ids = [callScopedId(command.callId, "node:0"), callScopedId(command.callId, "node:1")];
    expect(reply).toMatchObject({ status: "done", result: { nodeIds: ids } });
    const nodes = await canvasNodes(instanceA, world);
    expect(nodes.filter((n) => ids.includes(n.id)).map((n) => n.type).sort()).toEqual(["image", "text"]);
  });

  it("executes a call id once, however many times it is delivered", async () => {
    const world = await seedWorld();
    consumeOn(world, instanceA);
    consumeOn(world, instanceB);
    const command = await send(world, "create_canvas_nodes", { nodes: [{ type: "text" }] });
    await replyOf(world, command.callId);
    await mcp.xadd(mcpCommandStreamKey(world.prefix), "*", "command", JSON.stringify(command));
    await new Promise((r) => setTimeout(r, 500));
    const nodes = await canvasNodes(instanceA, world);
    expect(nodes.filter((n) => n.id === callScopedId(command.callId, "node:0"))).toHaveLength(1);
    expect(nodes).toHaveLength(2);
  });

  it("lands both of two writes to one document taken by two instances", async () => {
    const world = await seedWorld();
    consumeOn(world, instanceA);
    consumeOn(world, instanceB);
    const first = await send(world, "create_canvas_nodes", { nodes: [{ type: "text", name: "One" }] });
    const second = await send(world, "create_canvas_nodes", { nodes: [{ type: "text", name: "Two" }] });
    expect(await replyOf(world, first.callId)).toMatchObject({ status: "done" });
    expect(await replyOf(world, second.callId)).toMatchObject({ status: "done" });
    await expect.poll(async () => (await canvasNodes(instanceA, world)).map(nameOf).sort()).toEqual(expect.arrayContaining(["One", "Two"]));
  });
});

describe("deadlines", () => {
  it("does not write a command whose deadline passed, and says it did not finish", async () => {
    const world = await seedWorld();
    const command = await send(world, "update_canvas_node", { nodeId: world.nodeId, name: "Too late" }, { deadlineAt: Date.now() - 1 });
    consumeOn(world, instanceA);
    expect(await replyOf(world, command.callId)).toEqual({ callId: command.callId, status: "unfinished" });
    expect(await nodeName(instanceA, world, world.nodeId)).not.toBe("Too late");
  });

  it("answers done for a late create whose nodes the first run already wrote", async () => {
    const world = await seedWorld();
    consumeOn(world, instanceA);
    const command = await send(world, "create_canvas_nodes", { nodes: [{ type: "text" }] });
    await replyOf(world, command.callId);
    await mcp.del(mcpReplyKey(world.prefix, command.callId));
    await mcp.xadd(mcpCommandStreamKey(world.prefix), "*", "command", JSON.stringify({ ...command, deadlineAt: Date.now() - 1 }));
    expect(await replyOf(world, command.callId)).toMatchObject({ status: "done" });
  });
});

describe("refusals", () => {
  it.each(["viewer"] as const)("lets a %s read and refuses their writes as read_only", async (role) => {
    const world = await seedWorld(role);
    consumeOn(world, instanceA);
    expect(await replyOf(world, (await send(world, "read_canvas", {})).callId)).toMatchObject({ status: "done" });
    expect(await replyOf(world, (await send(world, "update_canvas_node", { nodeId: world.nodeId, name: "x" })).callId)).toMatchObject({
      status: "rejected",
      reason: "read_only",
    });
  });

  it("refuses writes to an archived Project as read_only", async () => {
    const world = await seedWorld();
    await db.execute(dsql`UPDATE projects SET archived_at = now(), archived_by_user_id = ${world.userId} WHERE id = ${world.projectId}`);
    consumeOn(world, instanceA);
    expect(await replyOf(world, (await send(world, "update_canvas_node", { nodeId: world.nodeId, name: "x" })).callId)).toMatchObject({
      status: "rejected",
      reason: "read_only",
    });
  });

  it("refuses a user with no part in the Project as no_access", async () => {
    const world = await seedWorld();
    const stranger = await seedWorld();
    consumeOn(world, instanceA);
    const reply = await replyOf(world, (await send({ ...world, userId: stranger.userId, connectionId: stranger.connectionId, credential: stranger.credential }, "read_canvas", {})).callId);
    expect(reply).toMatchObject({ status: "rejected", reason: "no_access" });
  });

  it("refuses a command whose credential was revoked after it was sent, and does not write it", async () => {
    const world = await seedWorld();
    const command = await send(world, "update_canvas_node", { nodeId: world.nodeId, name: "After revoke" });
    await agentAccessService.disconnect(world.connectionId, world.userId);
    consumeOn(world, instanceA);
    expect(await replyOf(world, command.callId)).toMatchObject({ status: "rejected", reason: "credential_revoked" });
    expect(await nodeName(instanceA, world, world.nodeId)).not.toBe("After revoke");
  });

  it("refuses a command that does not match the command format as invalid_command", async () => {
    const world = await seedWorld();
    consumeOn(world, instanceA);
    const command = await send(world, "update_canvas_node", { nodeId: 42 });
    expect(await replyOf(world, command.callId)).toMatchObject({ status: "rejected", reason: "invalid_command" });
  });

  it("refuses commands past commands_per_minute per user per Studio as rate_limited, each Studio counted on its own", async () => {
    const world = await seedWorld();
    consumeOn(world, instanceA);
    const max = getMcpConfig().rate_limit.commands_per_minute;
    const calls: string[] = [];
    for (let i = 0; i < max; i++) calls.push((await send(world, "list_spaces", {})).callId);
    for (const callId of calls) expect(await replyOf(world, callId)).toMatchObject({ status: "done" });
    expect(await replyOf(world, (await send(world, "list_spaces", {})).callId)).toMatchObject({ status: "rejected", reason: "rate_limited" });
    const elsewhere = await seedWorld();
    consumeOn(elsewhere, instanceB);
    expect(await replyOf(elsewhere, (await send(elsewhere, "list_spaces", {})).callId)).toMatchObject({ status: "done" });
  });
});
