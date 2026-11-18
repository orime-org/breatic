// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The server side of external-agent access (#1488), driven through the real
 * app against real Postgres and Redis:
 *
 * - downstream tokens: the MCP service never passes the agent's own token on
 *   (MCP Security Considerations, "Access Token Privilege Restriction"); it
 *   trades it for a short-lived downstream token that only a whitelist of
 *   routes accepts (§5.1, §5.5)
 * - the external agent's counters live in Redis DB 4, per user per Studio on
 *   routes that name a Project, per user otherwise; people keep DB 0 (§6)
 * - `GET /canvas/node-tasks?ids=`: the agent's view of the tasks it started (§9)
 * - the settings page's connection and personal-access-token routes (§5.4, §5.6)
 * - the capture upload the owner's browser makes (§19.1)
 */

import { describe, it, expect, beforeAll, afterAll, inject } from "vitest";
import crypto from "node:crypto";
import postgres from "postgres";
import type { Hono } from "hono";
import {
  initCore,
  getConfig,
  getRedis,
  getMcpRedis,
  getMcpConfig,
  setSession,
  sessionCookieName,
  loadLocales,
  agentAccessService,
  type Redis,
} from "@breatic/core";
import type * as TokenStore from "@server/modules/agent-access/agent-token-store.js";
import type * as DownstreamRoutes from "@server/modules/agent-access/downstream-routes.js";
import { agentReplySchema, mcpCaptureRequestKey, mcpDoneChannel, mcpReplyKey, VIEW_CAPTURE_VIEW_MAX_BYTES } from "@breatic/shared";

try {
  initCore(process.env);
} catch {
  // already initialised in this worker
}
loadLocales();

let sql: ReturnType<typeof postgres>;
let app: Hono;
let tokens: typeof TokenStore;
let whitelist: typeof DownstreamRoutes;

beforeAll(async () => {
  sql = postgres(inject("DATABASE_URL"), { max: 4, prepare: false });
  const { createApp } = await import("@server/app.js");
  app = createApp();
  tokens = await import("@server/modules/agent-access/agent-token-store.js");
  whitelist = await import("@server/modules/agent-access/downstream-routes.js");
});

afterAll(async () => {
  await sql?.end({ timeout: 1 });
});

let seq = 0;

interface Owner {
  userId: string;
  studioId: string;
  projectId: string;
  cookie: string;
}

/**
 * Sign a user in.
 * @param userId - The user.
 * @returns A Cookie header value.
 */
async function loginCookie(userId: string): Promise<string> {
  const token = crypto.randomBytes(24).toString("hex");
  await setSession(getRedis(), token, userId);
  return `${sessionCookieName()}=${token}`;
}

/**
 * A signed-in owner of a team studio with one project.
 * @returns Their ids and session cookie.
 */
async function seedOwner(): Promise<Owner> {
  const tag = `agent-routes-${process.pid}-${seq++}`;
  const [user] = await sql<{ id: string }[]>`
    INSERT INTO users (email, email_verified) VALUES (${`${tag}@example.com`}, true) RETURNING id`;
  const [studio] = await sql<{ id: string }[]>`
    INSERT INTO studios (created_by_user_id, slug, type, name)
    VALUES (${user!.id}, ${`${tag}-s`}, 'team', ${tag}) RETURNING id`;
  await sql`INSERT INTO studio_members (studio_id, user_id, role) VALUES (${studio!.id}, ${user!.id}, 'admin')`;
  const projectId = await seedProject(user!.id, studio!.id);
  return { userId: user!.id, studioId: studio!.id, projectId, cookie: await loginCookie(user!.id) };
}

/**
 * A project the user owns in a studio.
 * @param userId - Owner.
 * @param studioId - Studio.
 * @returns The project id.
 */
async function seedProject(userId: string, studioId: string): Promise<string> {
  const tag = `agent-routes-p-${process.pid}-${seq++}`;
  const [project] = await sql<{ id: string }[]>`
    INSERT INTO projects (studio_id, created_by_user_id, name, slug)
    VALUES (${studioId}, ${userId}, ${tag}, ${tag}) RETURNING id`;
  await sql`INSERT INTO project_members (project_id, user_id, role, added_by) VALUES (${project!.id}, ${userId}, 'owner', null)`;
  return project!.id;
}

/**
 * A second studio of the same user, with one project.
 * @param userId - The user.
 * @returns The studio and project ids.
 */
async function seedSecondStudio(userId: string): Promise<{ studioId: string; projectId: string }> {
  const tag = `agent-routes-s2-${process.pid}-${seq++}`;
  const [studio] = await sql<{ id: string }[]>`
    INSERT INTO studios (created_by_user_id, slug, type, name)
    VALUES (${userId}, ${tag}, 'team', ${tag}) RETURNING id`;
  await sql`INSERT INTO studio_members (studio_id, user_id, role) VALUES (${studio!.id}, ${userId}, 'admin')`;
  return { studioId: studio!.id, projectId: await seedProject(userId, studio!.id) };
}

interface Agent {
  connectionId: string;
  tokenId: string;
  plaintext: string;
  downstream: string;
}

/**
 * A personal access token for the user, and a downstream token traded for it.
 * @param userId - The token's owner.
 * @param name - The token's name.
 * @returns The connection, the token and a downstream token.
 */
async function seedAgent(userId: string, name = "Claude Code"): Promise<Agent> {
  const created = await agentAccessService.createPersonalAccessToken({ userId, name, expiresAt: null });
  if (!created.ok) throw new Error("token cap reached while seeding");
  const downstream = await tokens.issueDownstreamToken({
    userId,
    credential: { type: "pat", tokenId: created.tokenId },
    connectionId: created.connectionId,
    clientName: name,
  }, getMcpConfig().downstream_token_ttl_seconds);
  return { connectionId: created.connectionId, tokenId: created.tokenId, plaintext: created.token, downstream };
}

/**
 * Call the app.
 * @param path - Path under the origin.
 * @param init - Method, headers, body; `bearer` and `cookie` become headers.
 * @returns The response.
 */
async function call(
  path: string,
  init: { method?: string; bearer?: string; cookie?: string; json?: unknown; body?: BodyInit } = {},
): Promise<Response> {
  const headers: Record<string, string> = {};
  if (init.bearer) headers.Authorization = `Bearer ${init.bearer}`;
  if (init.cookie) headers.Cookie = init.cookie;
  if (init.json !== undefined) headers["Content-Type"] = "application/json";
  return app.request(path, {
    method: init.method ?? "GET",
    headers,
    body: init.json !== undefined ? JSON.stringify(init.json) : init.body,
  });
}

/**
 * Every key in a Redis database.
 * @param redis - The database.
 * @returns Its keys.
 */
async function allKeys(redis: Redis): Promise<string[]> {
  const out: string[] = [];
  let cursor = "0";
  do {
    const [next, batch] = await redis.scan(cursor, "COUNT", 1000);
    out.push(...batch);
    cursor = next;
  } while (cursor !== "0");
  return out;
}

describe("downstream tokens", () => {
  it("resolves to the user, credential, connection and client name it was issued for", async () => {
    const owner = await seedOwner();
    const agent = await seedAgent(owner.userId, "Cursor");
    expect(await tokens.findDownstreamToken(agent.downstream)).toEqual({
      userId: owner.userId,
      credential: { type: "pat", tokenId: agent.tokenId },
      connectionId: agent.connectionId,
      clientName: "Cursor",
    });
  });

  it("writes only keys that expire within the downstream token lifetime", async () => {
    const owner = await seedOwner();
    const created = await agentAccessService.createPersonalAccessToken({ userId: owner.userId, name: "t", expiresAt: null });
    if (!created.ok) throw new Error("cap");
    const before = new Set(await allKeys(getRedis()));
    await tokens.issueDownstreamToken({
      userId: owner.userId,
      credential: { type: "pat", tokenId: created.tokenId },
      connectionId: created.connectionId,
      clientName: "t",
    }, getMcpConfig().downstream_token_ttl_seconds);
    const added = (await allKeys(getRedis())).filter((k) => !before.has(k));
    expect(added.length).toBeGreaterThan(0);
    for (const key of added) {
      const ttl = await getRedis().ttl(key);
      expect(ttl, key).toBeGreaterThan(0);
      expect(ttl, key).toBeLessThanOrEqual(getMcpConfig().downstream_token_ttl_seconds);
    }
  });

  it("stops resolving every token of a revoked credential and leaves other credentials alone", async () => {
    const owner = await seedOwner();
    const first = await seedAgent(owner.userId);
    const again = await tokens.issueDownstreamToken({
      userId: owner.userId,
      credential: { type: "pat", tokenId: first.tokenId },
      connectionId: first.connectionId,
      clientName: "Claude Code",
    }, getMcpConfig().downstream_token_ttl_seconds);
    const other = await seedAgent(owner.userId, "Codex");
    await tokens.revokeDownstreamTokens({ type: "pat", tokenId: first.tokenId });
    expect(await tokens.findDownstreamToken(first.downstream)).toBeNull();
    expect(await tokens.findDownstreamToken(again)).toBeNull();
    expect(await tokens.findDownstreamToken(other.downstream)).not.toBeNull();
  });

  it("does not resolve a token it never issued", async () => {
    expect(await tokens.findDownstreamToken(crypto.randomBytes(32).toString("base64url"))).toBeNull();
  });
});

describe("requireAuth with a downstream token", () => {
  it("lets a whitelisted route through as the token's user", async () => {
    const owner = await seedOwner();
    const agent = await seedAgent(owner.userId);
    const res = await call(`/api/v1/users?ids=${owner.userId}`, { bearer: agent.downstream });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: Array<{ id: string }> };
    expect(body.data.map((u) => u.id)).toEqual([owner.userId]);
  });

  it("answers 401 on a route outside the whitelist", async () => {
    const owner = await seedOwner();
    const agent = await seedAgent(owner.userId);
    expect((await call("/api/v1/auth/me", { bearer: agent.downstream })).status).toBe(401);
    expect((await call("/api/v1/agent-access/connections", { bearer: agent.downstream })).status).toBe(401);
    expect((await call("/api/v1/account/subscription/checkout", { method: "POST", bearer: agent.downstream, json: {} })).status).toBe(401);
  });

  it("answers 401 to a token it never issued and to a personal access token passed straight through", async () => {
    const owner = await seedOwner();
    const agent = await seedAgent(owner.userId);
    expect((await call(`/api/v1/users?ids=${owner.userId}`, { bearer: "not-a-token" })).status).toBe(401);
    expect((await call(`/api/v1/users?ids=${owner.userId}`, { bearer: agent.plaintext })).status).toBe(401);
  });

  it("reads the session cookie first when a request carries both", async () => {
    const cookieOwner = await seedOwner();
    const tokenOwner = await seedOwner();
    const agent = await seedAgent(tokenOwner.userId);
    const res = await call("/api/v1/studios", { cookie: cookieOwner.cookie, bearer: agent.downstream });
    expect(res.status).toBe(200);
    const text = JSON.stringify(await res.json());
    expect(text).toContain(cookieOwner.studioId);
    expect(text).not.toContain(tokenOwner.studioId);
  });

  it("refuses a downstream token once its connection is disconnected on the settings page", async () => {
    const owner = await seedOwner();
    const agent = await seedAgent(owner.userId);
    expect((await call(`/api/v1/users?ids=${owner.userId}`, { bearer: agent.downstream })).status).toBe(200);
    expect((await call(`/api/v1/agent-access/connections/${agent.connectionId}`, { method: "DELETE", cookie: owner.cookie })).status).toBe(200);
    expect((await call(`/api/v1/users?ids=${owner.userId}`, { bearer: agent.downstream })).status).toBe(401);
  });
});

describe("the downstream token whitelist", () => {
  const expected = [
    "GET /api/v1/studios",
    "GET /api/v1/studio/:slug/projects",
    "GET /api/v1/models",
    "GET /api/v1/models/:modelName/voices",
    "GET /api/v1/users",
    "POST /api/v1/canvas/tasks",
    "POST /api/v1/canvas/understand",
    "POST /api/v1/canvas/transcribe",
    "POST /api/v1/mini-tools",
    "GET /api/v1/canvas/nodes/:nodeId/history",
    "GET /api/v1/canvas/node-tasks",
    "POST /api/v1/canvas/node-tasks/:taskId/failure",
    "GET /api/v1/assets/upload-config",
    "POST /api/v1/assets/upload-ticket",
    "POST /api/v1/assets/uploads/:uploadId/complete",
    "GET /api/v1/assets/upload-status",
    "POST /api/v1/assets/ingest-url",
    "POST /api/v1/assets/deleted",
    "GET /api/v1/agent-access/connections/names",
  ];

  it("names exactly the routes the MCP tools and uploads use", () => {
    expect(whitelist.DOWNSTREAM_TOKEN_ROUTES.map((r) => `${r.method} ${r.path}`).sort()).toEqual([...expected].sort());
  });

  it("names only routes the app mounts", () => {
    const mounted = new Set(app.routes.filter((r) => r.method !== "ALL").map((r) => `${r.method} ${r.path}`));
    for (const route of whitelist.DOWNSTREAM_TOKEN_ROUTES) expect(mounted, `${route.method} ${route.path}`).toContain(`${route.method} ${route.path}`);
  });
});

describe("rate limits for downstream tokens", () => {
  it("counts a route without a Project per user in Redis DB 4 and nothing in DB 0", async () => {
    const owner = await seedOwner();
    const agent = await seedAgent(owner.userId);
    expect((await call(`/api/v1/agent-access/connections/names?ids=${agent.connectionId}`, { bearer: agent.downstream })).status).toBe(200);
    const mcpKeys = (await allKeys(getMcpRedis())).filter((k) => k.includes(owner.userId));
    expect(mcpKeys.some((k) => k.includes("mcp:rate:") && k.endsWith(`${owner.userId}:all`))).toBe(true);
    expect((await allKeys(getRedis())).filter((k) => k.includes("ratelimit") && k.includes(owner.userId))).toEqual([]);
  });

  it("counts a route that names a Project per user per Studio, each Studio on its own", async () => {
    const owner = await seedOwner();
    const second = await seedSecondStudio(owner.userId);
    const agent = await seedAgent(owner.userId);
    const node = crypto.randomUUID();
    for (const projectId of [owner.projectId, second.projectId]) {
      const res = await call(`/api/v1/canvas/nodes/${node}/history?project_id=${projectId}`, { bearer: agent.downstream });
      expect(res.status).toBe(200);
    }
    const keys = (await allKeys(getMcpRedis())).filter((k) => k.includes("mcp:rate:") && k.includes(owner.userId));
    expect(keys.some((k) => k.includes(owner.studioId))).toBe(true);
    expect(keys.some((k) => k.includes(second.studioId))).toBe(true);
  });

  it("leaves a cookie request's counters where they were", async () => {
    const owner = await seedOwner();
    const res = await call(`/api/v1/canvas/nodes/${crypto.randomUUID()}/history?project_id=${owner.projectId}`, { cookie: owner.cookie });
    expect(res.status).toBe(200);
    expect((await allKeys(getMcpRedis())).filter((k) => k.includes(owner.userId))).toEqual([]);
  });

  it("answers 429 with Retry-After once the user's total for the minute is spent", async () => {
    const owner = await seedOwner();
    const agent = await seedAgent(owner.userId);
    const path = `/api/v1/agent-access/connections/names?ids=${agent.connectionId}`;
    const total = getMcpConfig().rate_limit.user_total_per_minute;
    for (let i = 0; i < total; i++) {
      const res = await call(path, { bearer: agent.downstream });
      expect(res.status, `request ${i + 1}`).toBe(200);
    }
    const refused = await call(path, { bearer: agent.downstream });
    expect(refused.status).toBe(429);
    expect(Number(refused.headers.get("Retry-After"))).toBeGreaterThan(0);
  });
});

describe("GET /canvas/node-tasks?ids=", () => {
  /**
   * A generation job and the node task row it runs as.
   * @param owner - Who started it.
   * @param opts - Row status and timing.
   * @param opts.status - The row's status.
   * @param opts.startedAgoMs - How long ago it started.
   * @param opts.budgetMs - Its budget.
   * @param opts.content - The result URL a done row points at.
   * @param opts.errorMessage - The reason a failed row carries.
   * @returns The job id and the row's ids.
   */
  async function seedTask(
    owner: Owner,
    opts: { status: string; startedAgoMs?: number; budgetMs?: number; content?: string; errorMessage?: string; taskId?: string },
  ): Promise<{ taskId: string; spaceId: string; nodeId: string }> {
    const spaceId = crypto.randomUUID();
    const nodeId = crypto.randomUUID();
    const taskId =
      opts.taskId ??
      (
        await sql<{ id: string }[]>`
          INSERT INTO tasks (user_id, project_id, space_id, task_type, mode, status)
          VALUES (${owner.userId}, ${owner.projectId}, ${spaceId}, 'image', 'append', 'processing') RETURNING id`
      )[0]!.id;
    let historyId: string | null = null;
    if (opts.content) {
      const [entry] = await sql<{ id: string }[]>`
        INSERT INTO node_history (project_id, node_id, user_id, entry_type, status, content)
        VALUES (${owner.projectId}, ${nodeId}, ${owner.userId}, 'generation', 'success', ${opts.content}) RETURNING id`;
      historyId = entry!.id;
    }
    await sql`
      INSERT INTO node_tasks
        (project_id, space_id, node_id, kind, action, status, started_by_user_id, started_at, budget_ms, label,
         error_message, node_history_id, task_id, settled_at)
      VALUES
        (${owner.projectId}, ${spaceId}, ${nodeId}, 'generation', 'generate', ${opts.status}, ${owner.userId},
         now() - (${opts.startedAgoMs ?? 0} * interval '1 millisecond'), ${opts.budgetMs ?? 7_200_000}, 'model-x',
         ${opts.errorMessage ?? null}, ${historyId}, ${taskId},
         ${opts.status === "running" ? null : sql`now()`})`;
    return { taskId, spaceId, nodeId };
  }

  interface Item {
    taskId: string;
    projectId: string;
    spaceId: string;
    nodeId: string;
    status: string;
    content: string | null;
    errorMessage: string | null;
  }

  /**
   * Query tasks.
   * @param ids - Task ids.
   * @param auth - Cookie or downstream token.
   * @returns The response and its items.
   */
  async function query(ids: string[], auth: { cookie?: string; bearer?: string }): Promise<{ status: number; items: Item[] }> {
    const res = await call(`/api/v1/canvas/node-tasks?ids=${ids.join(",")}`, auth);
    const body = res.status === 200 ? ((await res.json()) as { data: Item[] }) : { data: [] };
    return { status: res.status, items: body.data };
  }

  it("returns where each of the caller's tasks landed and how it ended", async () => {
    const owner = await seedOwner();
    const agent = await seedAgent(owner.userId);
    const done = await seedTask(owner, { status: "done", content: "https://cdn.example/result.png" });
    const failed = await seedTask(owner, { status: "failed", errorMessage: "provider refused the prompt" });
    const running = await seedTask(owner, { status: "running" });
    const { status, items } = await query([done.taskId, failed.taskId, running.taskId], { bearer: agent.downstream });
    expect(status).toBe(200);
    const byTask = new Map(items.map((i) => [i.taskId, i]));
    expect(byTask.get(done.taskId)).toMatchObject({
      projectId: owner.projectId, spaceId: done.spaceId, nodeId: done.nodeId, status: "done", content: "https://cdn.example/result.png",
    });
    expect(byTask.get(failed.taskId)).toMatchObject({ status: "failed", errorMessage: "provider refused the prompt" });
    expect(byTask.get(running.taskId)).toMatchObject({ status: "running" });
  });

  it("answers another user's task exactly as a task that does not exist", async () => {
    const owner = await seedOwner();
    const stranger = await seedOwner();
    const theirs = await seedTask(owner, { status: "done", content: "https://cdn.example/secret.png" });
    const strangerAgent = await seedAgent(stranger.userId);
    const foreign = await query([theirs.taskId], { bearer: strangerAgent.downstream });
    const missing = await query([crypto.randomUUID()], { bearer: strangerAgent.downstream });
    expect(foreign).toEqual(missing);
    expect(foreign.items).toEqual([]);
  });

  it("judges a running row past its budget expired, in the answer and in the table", async () => {
    const owner = await seedOwner();
    const stale = await seedTask(owner, { status: "running", startedAgoMs: 120_000, budgetMs: 60_000 });
    const { items } = await query([stale.taskId], { cookie: owner.cookie });
    expect(items).toHaveLength(1);
    expect(items[0]!.status).toBe("expired");
    const [row] = await sql<{ status: string }[]>`SELECT status FROM node_tasks WHERE task_id = ${stale.taskId}`;
    expect(row!.status).toBe("expired");
  });

  it("returns one item per row when a job landed on two nodes", async () => {
    const owner = await seedOwner();
    const first = await seedTask(owner, { status: "done", content: "https://cdn.example/a.png" });
    await seedTask(owner, { status: "done", content: "https://cdn.example/b.png", taskId: first.taskId });
    const { items } = await query([first.taskId], { cookie: owner.cookie });
    expect(items.map((i) => i.content).sort()).toEqual(["https://cdn.example/a.png", "https://cdn.example/b.png"]);
  });

  it("refuses more ids than task_query_max_ids", async () => {
    const owner = await seedOwner();
    const ids = Array.from({ length: getMcpConfig().task_query_max_ids + 1 }, () => crypto.randomUUID());
    expect((await query(ids, { cookie: owner.cookie })).status).toBe(422);
  });
});

describe("settings page routes for external agents", () => {
  interface Row {
    id: string;
    kind: string;
    displayName: string;
    status: string;
    tokenPrefix?: string;
  }

  /**
   * The settings page's connection list.
   * @param cookie - Session.
   * @returns The rows.
   */
  async function list(cookie: string): Promise<Row[]> {
    const res = await call("/api/v1/agent-access/connections", { cookie });
    expect(res.status).toBe(200);
    return ((await res.json()) as { data: Row[] }).data;
  }

  it("lists only the signed-in user's own connections", async () => {
    const owner = await seedOwner();
    const other = await seedOwner();
    const mine = await seedAgent(owner.userId, "Claude Code");
    await seedAgent(other.userId, "Cursor");
    const rows = await list(owner.cookie);
    expect(rows.map((r) => r.id)).toEqual([mine.connectionId]);
    expect(rows[0]).toMatchObject({ kind: "pat", displayName: "Claude Code", status: "active", tokenPrefix: mine.plaintext.slice(0, 8) });
  });

  it("creates a personal access token, shows the plaintext once and lists its prefix", async () => {
    const owner = await seedOwner();
    const res = await call("/api/v1/agent-access/personal-access-tokens", {
      method: "POST", cookie: owner.cookie, json: { name: "DeepSeek Harness", expiresInDays: 90 },
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { data: { token: string; connectionId: string } };
    expect(body.data.token.startsWith("brt_")).toBe(true);
    const rows = await list(owner.cookie);
    expect(rows.find((r) => r.id === body.data.connectionId)).toMatchObject({ displayName: "DeepSeek Harness", tokenPrefix: body.data.token.slice(0, 8) });
    expect(JSON.stringify(rows)).not.toContain(body.data.token);
  });

  it.each([
    ["an expiry outside 30, 90, 365 days or never", { name: "x", expiresInDays: 7 }],
    ["a blank name", { name: "   ", expiresInDays: 30 }],
  ])("refuses a token with %s", async (_label, json) => {
    const owner = await seedOwner();
    expect((await call("/api/v1/agent-access/personal-access-tokens", { method: "POST", cookie: owner.cookie, json })).status).toBe(422);
  });

  it("refuses a new token once the user holds the configured number of live ones", async () => {
    const owner = await seedOwner();
    for (let i = 0; i < getMcpConfig().pat.max_active_per_user; i++) await seedAgent(owner.userId, `t${i}`);
    const res = await call("/api/v1/agent-access/personal-access-tokens", {
      method: "POST", cookie: owner.cookie, json: { name: "one more", expiresInDays: null },
    });
    expect(res.status).toBe(409);
  });

  it("renames a connection with the name trimmed", async () => {
    const owner = await seedOwner();
    const agent = await seedAgent(owner.userId);
    const res = await call(`/api/v1/agent-access/connections/${agent.connectionId}`, {
      method: "PATCH", cookie: owner.cookie, json: { name: "  Laptop Claude  " },
    });
    expect(res.status).toBe(200);
    expect((await list(owner.cookie))[0]!.displayName).toBe("Laptop Claude");
  });

  it.each([
    ["blank", "   "],
    ["65 characters long", "x".repeat(65)],
  ])("refuses a name that is %s", async (_label, name) => {
    const owner = await seedOwner();
    const agent = await seedAgent(owner.userId);
    const res = await call(`/api/v1/agent-access/connections/${agent.connectionId}`, { method: "PATCH", cookie: owner.cookie, json: { name } });
    expect(res.status).toBe(422);
  });

  it("answers 404 to renaming or disconnecting another user's connection, and leaves it alone", async () => {
    const owner = await seedOwner();
    const other = await seedOwner();
    const theirs = await seedAgent(other.userId, "Cursor");
    expect((await call(`/api/v1/agent-access/connections/${theirs.connectionId}`, { method: "PATCH", cookie: owner.cookie, json: { name: "mine" } })).status).toBe(404);
    expect((await call(`/api/v1/agent-access/connections/${theirs.connectionId}`, { method: "DELETE", cookie: owner.cookie })).status).toBe(404);
    expect((await list(other.cookie))[0]).toMatchObject({ id: theirs.connectionId, displayName: "Cursor" });
  });

  it("disconnects a connection: it leaves the list and its token stops working", async () => {
    const owner = await seedOwner();
    const agent = await seedAgent(owner.userId);
    expect((await call(`/api/v1/agent-access/connections/${agent.connectionId}`, { method: "DELETE", cookie: owner.cookie })).status).toBe(200);
    expect(await list(owner.cookie)).toEqual([]);
    expect(await agentAccessService.findPersonalAccessToken(agent.plaintext)).toBeNull();
  });

  it("names connections by id for a cookie and for a downstream token, deleted ones included", async () => {
    const owner = await seedOwner();
    const kept = await seedAgent(owner.userId, "Claude Code");
    const gone = await seedAgent(owner.userId, "Old Cursor");
    await call(`/api/v1/agent-access/connections/${gone.connectionId}`, { method: "DELETE", cookie: owner.cookie });
    for (const auth of [{ cookie: owner.cookie }, { bearer: kept.downstream }]) {
      const res = await call(`/api/v1/agent-access/connections/names?ids=${kept.connectionId},${gone.connectionId}`, auth);
      expect(res.status).toBe(200);
      const names = ((await res.json()) as { data: Array<{ id: string; name: string }> }).data;
      expect(names.sort((a, b) => a.name.localeCompare(b.name))).toEqual([
        { id: kept.connectionId, name: "Claude Code" },
        { id: gone.connectionId, name: "Old Cursor" },
      ]);
    }
  });
});

describe("POST /agent/view-captures/:requestId", () => {
  const prefix = (): string => getConfig().REDIS_KEY_PREFIX;

  /**
   * Register a capture request the way collab does.
   * @param userId - The owner whose browser is asked.
   * @returns The request id and the command's call id.
   */
  async function register(userId: string): Promise<{ requestId: string; callId: string }> {
    const requestId = crypto.randomUUID();
    const callId = crypto.randomUUID();
    await getMcpRedis().set(mcpCaptureRequestKey(prefix(), requestId), JSON.stringify({ userId, callId }), "EX", 30);
    return { requestId, callId };
  }

  /**
   * A capture body.
   * @param opts - What it carries.
   * @param opts.imageBytes - Image size; no image when absent.
   * @param opts.note - A note in place of an image.
   * @param opts.view - On-screen data.
   * @returns The multipart body.
   */
  function captureBody(opts: { imageBytes?: number; note?: string; view?: unknown }): FormData {
    const form = new FormData();
    if (opts.imageBytes !== undefined) form.set("image", new Blob([new Uint8Array(opts.imageBytes)], { type: "image/webp" }), "capture.webp");
    if (opts.note !== undefined) form.set("note", opts.note);
    form.set("view", JSON.stringify(opts.view ?? { spaceId: crypto.randomUUID(), kind: "canvas", visibleIds: ["n1"] }));
    return form;
  }

  /**
   * The reply the command's caller will read.
   * @param callId - The command.
   * @returns The parsed reply, or null.
   */
  async function reply(callId: string): Promise<unknown> {
    const raw = await getMcpRedis().get(mcpReplyKey(prefix(), callId));
    return raw === null ? null : JSON.parse(raw);
  }

  it("writes the capture as the command's reply, keeps it for reply_ttl_seconds and announces it", async () => {
    const owner = await seedOwner();
    const { requestId, callId } = await register(owner.userId);
    const sub = getMcpRedis().duplicate();
    const heard: string[] = [];
    await sub.subscribe(mcpDoneChannel(prefix()));
    sub.on("message", (_channel, message) => heard.push(message));
    try {
      const view = { spaceId: crypto.randomUUID(), kind: "canvas", visibleIds: ["n1", "n2"] };
      const res = await call(`/api/v1/agent/view-captures/${requestId}`, { method: "POST", cookie: owner.cookie, body: captureBody({ imageBytes: 2048, view }) });
      expect(res.status).toBe(200);
      const stored = agentReplySchema.parse(await reply(callId));
      expect(stored).toMatchObject({ callId, status: "done", result: { mimeType: "image/webp", view } });
      expect(Buffer.from((stored as unknown as { result: { imageBase64: string } }).result.imageBase64, "base64")).toHaveLength(2048);
      const ttl = await getMcpRedis().ttl(mcpReplyKey(prefix(), callId));
      expect(ttl).toBeGreaterThan(0);
      expect(ttl).toBeLessThanOrEqual(getMcpConfig().reply_ttl_seconds);
      await expect.poll(() => heard).toContain(callId);
    } finally {
      sub.disconnect();
    }
  });

  it("writes a note in place of an image when no Space is open", async () => {
    const owner = await seedOwner();
    const { requestId, callId } = await register(owner.userId);
    const res = await call(`/api/v1/agent/view-captures/${requestId}`, {
      method: "POST", cookie: owner.cookie, body: captureBody({ note: "no space open", view: { spaceId: null } }),
    });
    expect(res.status).toBe(200);
    expect(await reply(callId)).toMatchObject({ callId, status: "done", result: { note: "no space open" } });
  });

  it("answers 410 when the request is unknown or has expired", async () => {
    const owner = await seedOwner();
    const res = await call(`/api/v1/agent/view-captures/${crypto.randomUUID()}`, { method: "POST", cookie: owner.cookie, body: captureBody({ imageBytes: 16 }) });
    expect(res.status).toBe(410);
  });

  it("answers 403 to anyone but the owner the request was sent to, and writes nothing", async () => {
    const owner = await seedOwner();
    const other = await seedOwner();
    const { requestId, callId } = await register(owner.userId);
    const res = await call(`/api/v1/agent/view-captures/${requestId}`, { method: "POST", cookie: other.cookie, body: captureBody({ imageBytes: 16 }) });
    expect(res.status).toBe(403);
    expect(await reply(callId)).toBeNull();
  });

  it("keeps the first answer: a later upload does not replace a reply already written", async () => {
    const owner = await seedOwner();
    const { requestId, callId } = await register(owner.userId);
    const notWatching = { callId, status: "rejected", reason: "not_watching" };
    await getMcpRedis().set(mcpReplyKey(prefix(), callId), JSON.stringify(notWatching), "EX", 60);
    const res = await call(`/api/v1/agent/view-captures/${requestId}`, { method: "POST", cookie: owner.cookie, body: captureBody({ imageBytes: 16 }) });
    expect(res.status).toBe(409);
    expect(await reply(callId)).toEqual(notWatching);
  });

  it("refuses an image over view_capture.max_bytes and on-screen data over the view limit", async () => {
    const owner = await seedOwner();
    const big = await register(owner.userId);
    const tooBigImage = await call(`/api/v1/agent/view-captures/${big.requestId}`, {
      method: "POST", cookie: owner.cookie, body: captureBody({ imageBytes: getMcpConfig().view_capture.max_bytes + 1 }),
    });
    expect(tooBigImage.status).toBe(413);
    const wide = await register(owner.userId);
    const tooBigView = await call(`/api/v1/agent/view-captures/${wide.requestId}`, {
      method: "POST", cookie: owner.cookie, body: captureBody({ imageBytes: 16, view: { ids: "x".repeat(VIEW_CAPTURE_VIEW_MAX_BYTES) } }),
    });
    expect(tooBigView.status).toBe(413);
    expect(await reply(big.callId)).toBeNull();
    expect(await reply(wide.callId)).toBeNull();
  });

  it("answers 401 to a downstream token: only the owner's browser uploads", async () => {
    const owner = await seedOwner();
    const agent = await seedAgent(owner.userId);
    const { requestId } = await register(owner.userId);
    const res = await call(`/api/v1/agent/view-captures/${requestId}`, { method: "POST", bearer: agent.downstream, body: captureBody({ imageBytes: 16 }) });
    expect(res.status).toBe(401);
  });
});
