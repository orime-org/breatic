// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * What each operation entry answers once the month's operations are used up
 * and the studio cannot pay 0.5 for one more, and how an entry gives back an
 * admission it did not use (inner#1968, test spec area D: D-05, D-14 to D-19,
 * D-21; 5.1 resolutions #8, #11, #12). Real Postgres and Redis, through the
 * real Hono app, with payments on.
 *
 * The refusal is `402 { error: { code, message, reason: "operations_exhausted" } }`
 * with `message = t("server.operation.exhausted", { credits })` and `credits`
 * from `operations.overage_credits` (0.5). It comes before any row opens, so
 * no ledger row stays reserved, no `operation:` hold is held, and no task,
 * node task, grant, queue item or execution is written. When both spend
 * limits are reached the refusal names the studio's (`scope: "studio"`).
 *
 * Operation keys a browser chooses (an upload's or an address's
 * `Idempotency-Key`, a chat message id) must be UUIDs; anything else is a
 * `request_shape` refusal.
 *
 * The account is a pro admin whose live subscription anchors the period a
 * minute ago, with 4000 operations counted in it and 0.4 spendable. The chat
 * cases set the conversation's active run first, so a send is queued rather
 * than opening a run.
 */

import { initConfiguredProvider } from "@breatic/integration-tests/provider";
import { describe, it, expect, beforeAll, afterAll, inject, vi } from "vitest";

vi.mock("ai", () => ({
  generateText: async () => ({ text: "", steps: [], usage: { totalTokens: 0 } }),
  streamText: () => ({
    fullStream: (async function* () {})(),
    text: Promise.resolve(""),
    usage: Promise.resolve({ totalTokens: 0 }),
  }),
  stepCountIs: (_n: number) => () => false,
  tool: (config: Record<string, unknown>) => config,
}));

vi.mock("@breatic/shared", async (importOriginal) =>
  (await import("../helpers/ingest-open-double.js")).sharedWithOpenDouble(importOriginal),
);

vi.mock("@server/utils/send-best-effort-mail.js", () => ({
  sendBestEffortMail: async () => {},
}));

import crypto from "node:crypto";
import postgres from "postgres";
import type { Hono } from "hono";
import { getMembershipLimits, getRedis, initCore, loadLocales, sessionCookieName, setSession } from "@breatic/core";
import { seedDesignatedLot } from "./studio-credit-fixtures.js";
import { keysOf } from "./chat-run-harness.js";

const ALLOWANCE = 4000;
const T23D = "tripo-h3.1-t23d";
const SUITE_ENV = {
  ...process.env,
  PAYMENT_ENABLED: "true",
  STRIPE_SECRET_KEY: "sk_test_unused_by_this_suite",
  STRIPE_WEBHOOK_SECRET: "whsec_unused_by_this_suite",
  WAVESPEED_API_KEY: "unused_by_this_suite",
};

let sql: ReturnType<typeof postgres>;
let app: Hono;

beforeAll(async () => {
  initCore(SUITE_ENV);
  loadLocales();
  initConfiguredProvider();
  sql = postgres(inject("DATABASE_URL"), { max: 4, prepare: false, connection: { application_name: "operations-exhausted-routes-test" } });
  const { createApp } = await import("@server/app.js");
  app = createApp();
});

afterAll(async () => {
  await sql?.end({ timeout: 1 });
  initCore(process.env);
});

interface Account {
  userId: string;
  studioId: string;
  projectId: string;
  spaceId: string;
  cookie: string;
}

interface Options {
  /** Operations counted this period. */
  used?: number;
  /** The studio's spendable balance. */
  credits?: number;
  /** The project's first Space type. */
  spaceType?: "canvas" | "timeline";
}

/**
 * A signed-in pro admin of a team studio with a project, its period anchored a
 * minute ago by a live subscription.
 * @param options - What is counted, what the studio holds, the Space type.
 * @returns The ids and the cookie.
 */
async function account(options: Options = {}): Promise<Account> {
  const { used = ALLOWANCE, credits = 0.4, spaceType = "canvas" } = options;
  const [clock] = await sql<{ now: Date }[]>`select date_trunc('milliseconds', statement_timestamp()) as now`;
  const now = clock!.now;
  const periodStart = new Date(now.getTime() - 60_000);
  const userId = crypto.randomUUID();
  const studioId = crypto.randomUUID();
  const projectId = crypto.randomUUID();
  await sql`insert into users(id, email, email_verified, membership_tier, created_at) values (${userId}, ${`${userId}@example.test`}, true, 'pro', ${new Date(now.getTime() - 200 * 86_400_000)})`;
  await sql`insert into studios(id, created_by_user_id, slug, type, name) values (${studioId}, ${userId}, ${`oxr-${studioId}`}, 'team', 'Exhausted')`;
  await sql`insert into studio_members(studio_id, user_id, role) values (${studioId}, ${userId}, 'admin')`;
  await sql`insert into projects(id, studio_id, created_by_user_id, slug, name, initial_space_type) values (${projectId}, ${studioId}, ${userId}, ${`oxr-${projectId}`}, 'Exhausted', ${spaceType})`;
  await sql`insert into project_members(project_id, user_id, role, added_by) values (${projectId}, ${userId}, 'owner', null)`;
  await sql`insert into subscriptions(user_id, stripe_subscription_id, tier, period, status, current_period_end, cancel_at_period_end, billing_cycle_anchor)
    values (${userId}, ${`sub_${crypto.randomUUID()}`}, 'pro', 'month', 'active', ${new Date(now.getTime() + 30 * 86_400_000)}, false, ${periodStart})`;
  if (used > 0) {
    await sql`insert into operation_ledger(operation_key, kind, account_user_id, studio_id, project_id, actor_user_id, status, admitted_as, slot, period_start, counted_at, expires_at, created_at)
      select 'task:' || gen_random_uuid(), 'generation', ${userId}, ${studioId}, ${projectId}, ${userId}, 'counted', 'covered', 'allowance', ${periodStart}, ${periodStart}, ${periodStart}::timestamptz + interval '2 hours', ${periodStart}
      from generate_series(1, ${used})`;
  }
  if (credits > 0) {
    const lot = await seedDesignatedLot(sql, { userId, studioId, projectId }, Math.max(1, Math.ceil(credits)));
    await sql`update credit_lots set remaining_credits = ${credits} where id = ${lot}`;
  }
  const token = crypto.randomBytes(24).toString("hex");
  await setSession(getRedis(), token, userId);
  return { userId, studioId, projectId, spaceId: crypto.randomUUID(), cookie: `${sessionCookieName()}=${token}` };
}

/**
 * Send one JSON request as the account.
 * @param a - Who sends.
 * @param method - The HTTP method.
 * @param path - The path under /api/v1.
 * @param body - The JSON body.
 * @param headers - Extra headers; a fresh `Idempotency-Key` is sent unless one is given.
 * @returns The response.
 */
function call(a: Account, method: string, path: string, body: unknown, headers: Record<string, string> = {}): Promise<Response> {
  return Promise.resolve(app.request(`/api/v1${path}`, {
    method,
    headers: { Cookie: a.cookie, "Content-Type": "application/json", "Idempotency-Key": crypto.randomUUID(), ...headers },
    body: JSON.stringify(body),
  }));
}

/**
 * Open the project's conversation and mark a run as holding it, so a send queues.
 * @param a - Whose project.
 * @returns The conversation id.
 */
async function busyConversation(a: Account): Promise<string> {
  const opened = await app.request("/api/v1/chat/open", {
    method: "POST",
    headers: { Cookie: a.cookie, "Content-Type": "application/json" },
    body: JSON.stringify({ project_id: a.projectId }),
  });
  const conversationId = ((await opened.json()) as { data: { current: { conversation: { id: string } } } }).data.current.conversation.id;
  await getRedis().set(keysOf(conversationId).active, "R-running");
  return conversationId;
}

/**
 * Send one chat message.
 * @param a - Who sends.
 * @param conversationId - Where.
 * @param id - The message id.
 * @returns The response.
 */
function sendMessage(a: Account, conversationId: string, id: string = crypto.randomUUID()): Promise<Response> {
  return call(a, "POST", "/chat/message", { id, message: "hello", project_id: a.projectId, conversation_id: conversationId }, { "Idempotency-Key": id });
}

/**
 * Each operation entry with a well-formed request.
 * @param a - Who asks.
 * @returns The entry names and how to send each.
 */
function entries(a: Account): Array<[string, () => Promise<Response>]> {
  const at = { project_id: a.projectId, space_id: a.spaceId };
  return [
    ["generation", () => call(a, "POST", "/canvas/tasks", { ...at, task_type: "image", params: { prompt: "a cat" }, model: "flux-schnell", source: "task", mode: "append" })],
    ["3D generation", () => call(a, "POST", `/projects/${a.projectId}/three-d/${a.spaceId}/generations`, { mode: "t23d", model: T23D, prompt: "a red barn lamp", params: { texture: true }, origin: "space" })],
    ["server mini-tool", () => call(a, "POST", "/mini-tools", { ...at, tool: "image.upscale", node_ids: [crypto.randomUUID()], source: { url: "https://assets.invalid/image/a.png" }, params: { target_megapixels: 16, creativity: 2 }, slots: {} })],
    ["understand", () => call(a, "POST", "/canvas/understand", { ...at, source_type: "image", source_url: "https://assets.invalid/image/a.png", node_ids: [crypto.randomUUID()] })],
    ["transcribe", () => call(a, "POST", "/canvas/transcribe", { ...at, source_type: "audio", source_url: "https://assets.invalid/audio/a.m4a", node_ids: [crypto.randomUUID()], keep_fillers: true })],
    ["upload ticket", () => call(a, "POST", "/assets/upload-ticket", { filename: "photo.png", content_type: "image/png", project_id: a.projectId, size: 4096, client_hash: crypto.randomBytes(32).toString("hex") })],
    ["canvas address", () => call(a, "POST", "/canvas/ingest-url", { ...at, url: "https://cdn.test.invalid/clip.mp4", node_id: crypto.randomUUID() })],
    ["document address", () => call(a, "POST", "/assets/ingest-url", { ...at, url: "https://cdn.test.invalid/picture.jpg" })],
    ["text tool", () => call(a, "POST", "/mini-tools/text", { tool: "polish", document: "Hello", selection: "Hello", project_id: a.projectId })],
  ];
}

/**
 * What an entry left behind for the account and its project.
 * @param a - The account.
 * @returns Live ledger rows, held operation holds, tasks, node tasks, grants and executions.
 */
async function sideEffects(a: Account): Promise<Record<string, number>> {
  const n = async (query: Promise<{ n: number }[]>): Promise<number> => (await query)[0]!.n;
  return {
    liveLedger: await n(sql`select count(*)::int as n from operation_ledger where account_user_id = ${a.userId} and status in ('reserved', 'deferred')`),
    operationHolds: await n(sql`select count(*)::int as n from credit_holds where studio_id = ${a.studioId} and reference_id like 'operation:%' and status = 'held'`),
    tasks: await n(sql`select count(*)::int as n from tasks where project_id = ${a.projectId}`),
    nodeTasks: await n(sql`select count(*)::int as n from node_tasks where project_id = ${a.projectId}`),
    grants: await n(sql`select count(*)::int as n from upload_grants where project_id = ${a.projectId}`),
    executions: await n(sql`select count(*)::int as n from timeline_executions where project_id = ${a.projectId}`),
  };
}

const NOTHING = { liveLedger: 0, operationHolds: 0, tasks: 0, nodeTasks: 0, grants: 0, executions: 0 };

/**
 * The refusal body of a response.
 * @param res - The response.
 * @returns Its `error` object.
 */
async function refusal(res: Response): Promise<Record<string, unknown>> {
  return ((await res.json()) as { error: Record<string, unknown> }).error;
}

/**
 * The ledger rows written under one key.
 * @param key - The operation key.
 * @returns Their statuses.
 */
async function statusesOf(key: string): Promise<string[]> {
  return (await sql<{ status: string }[]>`select status from operation_ledger where operation_key = ${key}`).map((r) => r.status);
}

describe("an entry once the operations are used up and 0.4 is left", () => {
  it("D-05 a generation is refused 402 operations_exhausted with the sentence naming 0.5, and writes nothing", async () => {
    const a = await account();
    const res = await call(a, "POST", "/canvas/tasks", { project_id: a.projectId, space_id: a.spaceId, task_type: "image", params: { prompt: "a cat" }, model: "flux-schnell", source: "task", mode: "append" }, { "Accept-Language": "zh-CN" });
    expect(res.status).toBe(402);
    expect(await refusal(res)).toMatchObject({ code: 402, reason: "operations_exhausted", message: "本月操作次数已用完，积分不足 0.5。充值后可继续。" });
    expect(await sideEffects(a)).toEqual(NOTHING);
  });

  it("D-14 every metered entry is refused 402 operations_exhausted before it writes anything", async () => {
    const a = await account();
    const answers: Record<string, unknown> = {};
    for (const [name, send] of entries(a)) {
      const res = await send();
      answers[name] = res.status === 402 ? (await refusal(res)).reason : res.status;
    }
    expect(answers).toEqual(Object.fromEntries(entries(a).map(([name]) => [name, "operations_exhausted"])));
    expect(await sideEffects(a)).toEqual(NOTHING);
  });

  it("D-14 a Timeline execution is refused 402 operations_exhausted and no execution row is written", async () => {
    const a = await account({ spaceType: "timeline" });
    const res = await call(a, "POST", "/timeline/executions", {
      projectId: a.projectId,
      spaceId: a.spaceId,
      actionId: crypto.randomUUID(),
      prompt: "A red square slides in from the left",
      engine: "deepseek",
      aspect: "16:9",
      durationSeconds: 4,
      fps: { num: 24, den: 1 },
    });
    expect(res.status).toBe(402);
    expect((await refusal(res)).reason).toBe("operations_exhausted");
    expect(await sideEffects(a)).toEqual(NOTHING);
  });

  it("D-14 / D-21 a chat message sent while a run holds the conversation is refused 402 and is not queued", async () => {
    const a = await account();
    const conversationId = await busyConversation(a);
    const id = crypto.randomUUID();
    const res = await sendMessage(a, conversationId, id);
    expect(res.status).toBe(402);
    expect((await refusal(res)).reason).toBe("operations_exhausted");
    expect(await getRedis().lrange(keysOf(conversationId).queue, 0, -1)).toEqual([]);
    expect(await getRedis().sismember(keysOf(conversationId).ids, id)).toBe(0);
    expect(await sideEffects(a)).toEqual(NOTHING);
    await getRedis().del(...Object.values(keysOf(conversationId)));
  });
});

describe("an admission an entry does not use is given back", () => {
  it("D-15 a generation whose estimate the balance cannot hold after the 0.5 is refused, and its ledger row is released with no operation hold left", async () => {
    const a = await account({ credits: 0.5 });
    const res = await call(a, "POST", "/canvas/tasks", { project_id: a.projectId, space_id: a.spaceId, task_type: "image", params: { prompt: "a cat" }, model: "flux-schnell", source: "task", mode: "append" });
    expect(res.status).toBe(402);
    const rows = await sql<{ status: string; admitted_as: string }[]>`select status, admitted_as from operation_ledger where account_user_id = ${a.userId} and created_at > now() - interval '10 minutes' and status <> 'counted'`;
    expect(rows).toEqual([{ status: "released", admitted_as: "held" }]);
    expect((await sideEffects(a)).operationHolds).toBe(0);
  });

  it("D-16 a full studio's upload ticket answers 507 and writes no ledger row: storage is judged before the admission", async () => {
    const a = await account({ used: 0, credits: 0 });
    const key = crypto.randomUUID();
    await sql`insert into studio_assets(studio_id, produced_by_user_id, content_hash, storage_key, file_url, mime_type, kind, source, size_bytes)
      values (${a.studioId}, ${a.userId}, ${key}, ${key}, ${`https://example.test/${key}.png`}, 'image/png', 'image', 'upload', ${getMembershipLimits("pro").storage_bytes})`;
    const res = await call(a, "POST", "/assets/upload-ticket", { filename: "photo.png", content_type: "image/png", project_id: a.projectId, size: 4096, client_hash: crypto.randomBytes(32).toString("hex") }, { "Idempotency-Key": key });
    expect(res.status).toBe(507);
    expect(await sql`select 1 from operation_ledger where account_user_id = ${a.userId}`).toEqual([]);
  });

  it("D-17 a message the full queue turns away has its ledger row released", async () => {
    const a = await account({ used: 0, credits: 100 });
    const conversationId = await busyConversation(a);
    const queued = Array.from({ length: 10 }, () => crypto.randomUUID());
    await getRedis().rpush(keysOf(conversationId).queue, ...queued.map((id) => JSON.stringify({ id, sentAt: new Date().toISOString(), userId: a.userId, acceptLanguage: "en", message: "m", attached_chips: [] })));
    const id = crypto.randomUUID();
    await sendMessage(a, conversationId, id);
    expect(await getRedis().sismember(keysOf(conversationId).ids, id)).toBe(0);
    expect(await statusesOf(`chat:${a.userId}:${id}`)).toEqual(["released"]);
    await getRedis().del(...Object.values(keysOf(conversationId)));
  });

  it("D-18 deleting a conversation with three queued messages releases each one's ledger row", async () => {
    const a = await account({ used: 0, credits: 100 });
    const conversationId = await busyConversation(a);
    const ids = [crypto.randomUUID(), crypto.randomUUID(), crypto.randomUUID()];
    for (const id of ids) expect((await sendMessage(a, conversationId, id)).status).toBe(200);
    for (const id of ids) expect(await statusesOf(`chat:${a.userId}:${id}`)).toEqual(["reserved"]);
    const deleted = await app.request(`/api/v1/chat/conversations/${conversationId}`, { method: "DELETE", headers: { Cookie: a.cookie } });
    expect(deleted.status).toBe(200);
    for (const id of ids) expect(await statusesOf(`chat:${a.userId}:${id}`)).toEqual(["released"]);
    await getRedis().del(...Object.values(keysOf(conversationId)));
  });

  it("D-19 a queued message taken back releases its ledger row", async () => {
    const a = await account({ used: 0, credits: 100 });
    const conversationId = await busyConversation(a);
    const id = crypto.randomUUID();
    expect((await sendMessage(a, conversationId, id)).status).toBe(200);
    const taken = await app.request(`/api/v1/chat/conversations/${conversationId}/queue/${id}`, {
      method: "DELETE",
      headers: { Cookie: a.cookie, "Content-Type": "application/json" },
      body: JSON.stringify({ project_id: a.projectId }),
    });
    expect(taken.status).toBe(200);
    expect(await statusesOf(`chat:${a.userId}:${id}`)).toEqual(["released"]);
    await getRedis().del(...Object.values(keysOf(conversationId)));
  });
});

describe("5.1 #8 an operation key chosen by the browser is a UUID", () => {
  it.each([
    ["/assets/upload-ticket", (a: Account) => ({ filename: "photo.png", content_type: "image/png", project_id: a.projectId, size: 4096, client_hash: "c".repeat(64) })],
    ["/canvas/ingest-url", (a: Account) => ({ project_id: a.projectId, space_id: a.spaceId, url: "https://cdn.test.invalid/clip.mp4", node_id: crypto.randomUUID() })],
    ["/assets/ingest-url", (a: Account) => ({ project_id: a.projectId, space_id: a.spaceId, url: "https://cdn.test.invalid/picture.jpg" })],
  ])("%s refuses a key that is not a UUID as request_shape, and writes no ledger row", async (path, body) => {
    const a = await account({ used: 0, credits: 0 });
    const res = await call(a, "POST", path, body(a), { "Idempotency-Key": "press-1-not-a-uuid" });
    expect(res.status).toBe(400);
    expect((await refusal(res)).reason).toBe("request_shape");
    expect(await sql`select 1 from operation_ledger where account_user_id = ${a.userId}`).toEqual([]);
  });
});

describe("5.1 #12 both spend limits reached at the overage hold", () => {
  it("the refusal names the studio's limit", async () => {
    const a = await account({ credits: 100 });
    await sql`insert into studio_spend_limits(studio_id, member_default_credits, studio_monthly_credits, updated_by_user_id) values (${a.studioId}, 0, 0, ${a.userId})`;
    const res = await call(a, "POST", "/assets/upload-ticket", { filename: "photo.png", content_type: "image/png", project_id: a.projectId, size: 4096, client_hash: crypto.randomBytes(32).toString("hex") });
    expect(res.status).toBe(402);
    expect(await refusal(res)).toMatchObject({ reason: "spend_cap_reached", scope: "studio" });
    expect(await sideEffects(a)).toEqual(NOTHING);
  });
});
