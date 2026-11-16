// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The harness every external-agent command test runs on (#1488 §6): two
 * collab instances wired the way production wires them, sharing Redis and
 * Postgres, and the two things the MCP service does — append a command to the
 * DB 4 stream and read its reply key.
 *
 * Every world gets its own key prefix, so a reply, a rate counter or a pending
 * entry from one case is never seen by another.
 */

import { afterAll, afterEach, beforeAll } from "vitest";
import { randomUUID } from "node:crypto";
import { Server, type Hocuspocus } from "@hocuspocus/server";
import { Redis as RedisExtension } from "@hocuspocus/extension-redis";
import * as Y from "yjs";
import { sql as dsql, type SQL } from "drizzle-orm";

import { agentAccessService, createRedisClient, db, getMcpConfig, initCore, type Redis } from "@breatic/core";
import {
  agentReplySchema,
  canvasSpaceDocName,
  mcpCommandStreamKey,
  mcpReplyKey,
  projectMetaDocName,
  type AgentCommand,
  type AgentReply,
} from "@breatic/shared";
import { addNodeInDoc, createEmptyNode, readEdges, readNodes } from "@breatic/shared/canvas-model";
import * as yjsRepo from "@collab/services/yjs-documents.repo.js";
import { createPersistenceExtension, staysLoaded, storeDocumentNow } from "@collab/services/persistence.js";
import { createUnloadGate } from "@collab/hooks/unload-gate.js";
import { createChangeTrackingExtension } from "@collab/services/change-tracking.js";
import type { GroupConsumer } from "@collab/services/stream-group-consumer.js";
import {
  startAgentCommandConsumer,
  type AgentCommandSettings,
} from "@collab/services/agent-commands/consumer.js";

export const SETTINGS: AgentCommandSettings = {
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
export async function run<T>(query: SQL): Promise<T[]> {
  return (await db.execute(query)) as unknown as T[];
}

/** The two instances and the MCP side's Redis client, set once the harness has started. */
export const harness: { instanceA: Hocuspocus; instanceB: Hocuspocus; mcp: Redis } = {} as never;
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

/** Register the harness's lifecycle hooks in the calling test file. */
export function useAgentCommandHarness(): void {
  beforeAll(async () => {
    initCore(process.env);
    harness.mcp = createRedisClient(process.env.REDIS_MCP_URL!, { name: "itest-agent-commands-mcp" });
    harness.instanceA = await startInstance("itest-agent-a");
    harness.instanceB = await startInstance("itest-agent-b");
  });

  afterEach(async () => {
    await Promise.all(consumers.splice(0).map((c) => c.stop()));
  });

  afterAll(async () => {
    for (const server of servers.splice(0)) server.httpServer.close();
    harness.mcp.disconnect();
  });
}

export interface World {
  prefix: string;
  userId: string;
  ownerId: string;
  studioId: string;
  projectId: string;
  spaceId: string;
  connectionId: string;
  credential: AgentCommand["credential"];
  tokenId: string;
}

/**
 * A user who belongs to a Project with one canvas Space holding one text node
 * at the origin, and a personal access token for their agent.
 * @param role - The user's role on the Project.
 * @param seed - Writes more into the canvas before it is stored; gets the
 *   user's id, the Project owner's id and the text node's id.
 * @returns The world and the seeded text node's id.
 */
export async function seedWorld(
  role: "owner" | "editor" | "viewer" = "owner",
  seed?: (canvas: Y.Doc, userId: string, ownerId: string, textNodeId: string) => void,
): Promise<World & { nodeId: string }> {
  // Random, not a counter: test files share one process and each starts its
  // own module copy, so a counter would repeat the previous file's emails.
  const tag = `agent-cmd-${randomUUID().slice(0, 12)}`;
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
  seed?.(canvas, userId, owner!.id, node.id);
  await yjsRepo.upsertDocData(canvasSpaceDocName(project!.id, spaceId), Y.encodeStateAsUpdate(canvas));
  const created = await agentAccessService.createPersonalAccessToken({ userId, name: "Claude Code", expiresAt: null });
  if (!created.ok) throw new Error("cap");
  return {
    prefix: `itest-${tag}`,
    userId,
    ownerId: owner!.id,
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
export function consumeOn(world: World, hocuspocus: Hocuspocus, consume = true): GroupConsumer | null {
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
export async function send(world: World, type: string, params: unknown, over: Partial<AgentCommand> = {}): Promise<AgentCommand> {
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
  await harness.mcp.xadd(mcpCommandStreamKey(world.prefix), "MAXLEN", "~", "10000", "*", "command", JSON.stringify(command));
  return command;
}

/**
 * Wait for a command's reply.
 * @param world - Whose command.
 * @param callId - The command.
 * @param timeoutMs - How long to wait.
 * @returns The reply, or null when none arrived in time.
 */
export async function replyOf(world: World, callId: string, timeoutMs = 5000): Promise<AgentReply | null> {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    const raw = await harness.mcp.get(mcpReplyKey(world.prefix, callId));
    if (raw !== null) return agentReplySchema.parse(JSON.parse(raw));
    await new Promise((r) => setTimeout(r, 25));
  }
  return null;
}

/**
 * Send a command and wait for its reply.
 * @param world - Whose command.
 * @param type - Command type.
 * @param params - Its parameters.
 * @returns The reply, or null when none arrived in time.
 */
export async function call(world: World, type: string, params: unknown): Promise<AgentReply | null> {
  return replyOf(world, (await send(world, type, params)).callId);
}

/**
 * The result of a reply that must be done.
 * @param reply - The reply.
 * @returns Its result, typed as the caller reads it.
 * @throws {Error} When the reply is missing or not done.
 */
export function resultOf<T>(reply: AgentReply | null): T {
  if (reply?.status !== "done") throw new Error(`expected a done reply, got ${JSON.stringify(reply)}`);
  return reply.result as unknown as T;
}

/**
 * Read a canvas through a fresh direct connection.
 * @param hocuspocus - Which instance reads.
 * @param world - Whose canvas.
 * @param read - What to read from it.
 * @returns What it read.
 */
export async function readCanvas<T>(hocuspocus: Hocuspocus, world: World, read: (doc: Y.Doc) => T): Promise<T> {
  const conn = await hocuspocus.openDirectConnection(canvasSpaceDocName(world.projectId, world.spaceId), {});
  try {
    let out: T | undefined;
    await conn.transact((doc) => {
      out = read(doc);
    });
    return out as T;
  } finally {
    await conn.disconnect();
  }
}

/**
 * The canvas nodes as a fresh direct connection reads them.
 * @param hocuspocus - Which instance reads.
 * @param world - Whose canvas.
 * @returns Its nodes.
 */
export async function canvasNodes(hocuspocus: Hocuspocus, world: World): Promise<ReturnType<typeof readNodes>> {
  return readCanvas(hocuspocus, world, readNodes);
}

/**
 * The canvas edges as a fresh direct connection reads them.
 * @param hocuspocus - Which instance reads.
 * @param world - Whose canvas.
 * @returns Its edges.
 */
export async function canvasEdges(hocuspocus: Hocuspocus, world: World): Promise<ReturnType<typeof readEdges>> {
  return readCanvas(hocuspocus, world, readEdges);
}

/**
 * A node's name; stickies carry none.
 * @param node - A node as `readNodes` reads it.
 * @returns Its name, or undefined.
 */
export function nameOf(node: ReturnType<typeof readNodes>[number]): string | undefined {
  return (node.data as { name?: string }).name;
}

/**
 * The name of one node, as an instance serves it.
 * @param hocuspocus - Which instance reads.
 * @param world - Whose canvas.
 * @param nodeId - The node.
 * @returns Its name, or undefined.
 */
export async function nodeName(hocuspocus: Hocuspocus, world: World, nodeId: string): Promise<string | undefined> {
  const node = (await canvasNodes(hocuspocus, world)).find((n) => n.id === nodeId);
  return node ? nameOf(node) : undefined;
}
