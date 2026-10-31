// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * `POST /assets/upload-ticket` in its batch form (inner#1303 §7): a browser
 * tool that cuts one picture into many asks for every tile's ticket in one
 * request, and each tile is answered on its own — a ticket, a dedup hit, or a
 * refusal.
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll, inject, vi } from "vitest";

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
// The storage notice's mail leg is not this file's subject.
vi.mock("@server/utils/send-best-effort-mail.js", () => ({
  sendBestEffortMail: async () => {},
}));
// The ingest Worker's `POST /uploads`, which the server now calls itself for
// every tile (inner#1595): counted and answered by a double.
vi.mock("@breatic/shared", async (importOriginal) =>
  (await import("../helpers/ingest-open-double.js")).sharedWithOpenDouble(importOriginal),
);

/** What the app logs, handed in because core's logger proxy cannot be spied on. */
const logged = vi.hoisted(() => {
  const record = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), fatal: vi.fn(), trace: vi.fn() };
  return { ...record, child: () => record };
});
vi.mock("@breatic/core", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  logger: logged,
}));

import crypto from "node:crypto";
import postgres from "postgres";
import {
  env,
  initCore,
  getRedis,
  setSession,
  sessionCookieName,
  loadLocales,
  getMembershipLimits,
} from "@breatic/core";
import { assetRepo } from "@breatic/domain";
import { signSessionToken, UploadHttpError } from "@breatic/shared";
import { MINI_TOOLS, mostOutputsOf } from "@breatic/shared/mini-tools";
import { openCalls, opensByKey, resetOpenDouble, setOpenMode } from "../helpers/ingest-open-double.js";
import { getRateLimit } from "@server/config/rate-limits.js";
import type { Hono } from "hono";

try {
  initCore(process.env);
} catch {
  // already initialised by a sibling suite in this worker — fine.
}
loadLocales();

let sql: ReturnType<typeof postgres>;
let app: Hono;

beforeAll(async () => {
  sql = postgres(inject("DATABASE_URL"), {
    max: 2,
    prepare: false,
    connection: { application_name: "upload-ticket-batch-test" },
  });
  const { createApp } = await import("@server/app.js");
  app = createApp();
});

beforeEach(() => {
  resetOpenDouble();
  vi.clearAllMocks();
});

afterAll(async () => {
  await sql?.end({ timeout: 1 });
});

/** The largest batch a grouped browser tool asks for, read the way the route reads it. */
const BATCH_MAX = Math.max(
  ...MINI_TOOLS.filter((spec) => spec.run.kind === "browser" && spec.groupOutputs === true).map(mostOutputsOf),
);

let seq = 0;
const TILE_BYTES = 4096;
const SPACE_ID = "22222222-2222-4222-9222-222222222222";

/**
 * A base-tier account with a personal studio and a project, holding `filledBytes`.
 * @param filledBytes - How full the account is before the test runs.
 * @returns The ids and a login cookie.
 */
async function account(filledBytes = 0): Promise<{
  userId: string;
  studioId: string;
  projectId: string;
  cookie: string;
}> {
  const [u] = await sql<{ id: string }[]>`
    INSERT INTO users (email, email_verified, membership_tier)
    VALUES (${`utb-${seq++}@example.test`}, true, 'base') RETURNING id
  `;
  const userId = u!.id;
  const [st] = await sql<{ id: string }[]>`
    INSERT INTO studios (created_by_user_id, slug, type, name)
    VALUES (${userId}, ${`utb-s-${seq++}`}, 'personal', 'Personal') RETURNING id
  `;
  const studioId = st!.id;
  await sql`INSERT INTO studio_members (studio_id, user_id, role) VALUES (${studioId}, ${userId}, 'admin')`;
  const slug = `utb-proj-${seq++}`;
  const [p] = await sql<{ id: string }[]>`
    INSERT INTO projects (studio_id, created_by_user_id, name, slug)
    VALUES (${studioId}, ${userId}, ${`P ${slug}`}, ${slug}) RETURNING id
  `;
  const projectId = p!.id;
  await sql`
    INSERT INTO project_members (project_id, user_id, role, added_by)
    VALUES (${projectId}, ${userId}, 'owner', null)
  `;
  if (filledBytes > 0) await register(studioId, userId, crypto.randomBytes(32).toString("hex"), filledBytes);
  const token = crypto.randomBytes(24).toString("hex");
  await setSession(getRedis(), token, userId);
  return { userId, studioId, projectId, cookie: `${sessionCookieName()}=${token}` };
}

/**
 * Put one picture in the studio's ledger so the dedup pass finds it.
 * @param studioId - The studio.
 * @param userId - Who produced it.
 * @param contentHash - Its hash.
 * @param sizeBytes - Its size.
 */
async function register(studioId: string, userId: string, contentHash: string, sizeBytes: number): Promise<void> {
  await assetRepo.registerWithDedup({
    studioId,
    producedByUserId: userId,
    contentHash,
    storageKey: `image/2026-10-12/${crypto.randomUUID()}.png`,
    fileUrl: `https://cdn/${crypto.randomUUID()}.png`,
    sizeBytes,
    mimeType: "image/png",
    kind: "image",
    source: "upload",
  });
}

/**
 * One tile's entry in a batch.
 * @param hash - Its content hash; random when absent.
 * @returns The entry.
 */
function tile(hash = crypto.randomBytes(32).toString("hex")): Record<string, unknown> {
  return {
    filename: "GRID.png",
    content_type: "image/png",
    size: TILE_BYTES,
    client_hash: hash,
    node_id: crypto.randomUUID(),
  };
}

/**
 * POST a batch.
 * @param cookie - The caller's session.
 * @param payload - The body.
 * @returns The response.
 */
async function batch(cookie: string, payload: Record<string, unknown>): Promise<Response> {
  return app.request("/api/v1/assets/upload-ticket", {
    method: "POST",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify(payload),
  });
}

/**
 * A batch body for the grid tool.
 * @param projectId - The project.
 * @param items - The tiles.
 * @param overrides - Fields to change.
 * @returns The body.
 */
function gridBody(
  projectId: string,
  items: Record<string, unknown>[],
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return { project_id: projectId, space_id: SPACE_ID, source: "mini_tool", tool_name: "image.grid", items, ...overrides };
}

type Item = {
  ticket?: string;
  uploadId?: string;
  token?: string;
  storageKey?: string;
  taskId?: string;
  alreadyExists?: boolean;
  refused?: { reason: string };
  openFailed?: { reason: string };
};

/**
 * Whether an item is a ticket in the shape inner#1595 answers: an opened
 * upload's id and first token, and no ticket.
 * @param item - The item.
 * @returns Whether it is.
 */
function isOpened(item: Item): boolean {
  return (
    typeof item.uploadId === "string" &&
    typeof item.token === "string" &&
    typeof item.taskId === "string" &&
    !("ticket" in item)
  );
}

describe("the batch form of the upload ticket", () => {
  it("T72: opens BATCH_MAX (64) tiles in one request, each once, counted once against the ticket limit", async () => {
    expect(BATCH_MAX).toBe(64);
    const a = await account();
    const items = Array.from({ length: BATCH_MAX }, () => tile());

    const res = await batch(a.cookie, gridBody(a.projectId, items));

    expect(res.status).toBe(200);
    const { data } = (await res.json()) as { data: { items: Item[] } };
    expect(data.items).toHaveLength(BATCH_MAX);
    expect(data.items.every(isOpened)).toBe(true);
    const opens = opensByKey();
    expect(opens.size).toBe(BATCH_MAX);
    expect([...opens.values()].every((n) => n === 1)).toBe(true);
    expect(await getRedis().zcard(`${env.ENV}:ratelimit:upload-ticket:${a.userId}`)).toBe(1);
  });

  it("answers each tile in the order it was asked", async () => {
    const a = await account();
    const hit = crypto.randomBytes(32).toString("hex");
    await register(a.studioId, a.userId, hit, TILE_BYTES);

    const res = await batch(a.cookie, gridBody(a.projectId, [tile(), tile(hit), tile()]));

    const { data } = (await res.json()) as { data: { items: Item[] } };
    expect(data.items.map((item) => (item.alreadyExists ? "hit" : item.uploadId ? "ticket" : "other"))).toEqual([
      "ticket",
      "hit",
      "ticket",
    ]);
  });

  it.each([
    ["more tiles than the grid can cut", (p: string) => gridBody(p, Array.from({ length: 65 }, () => tile()))],
    ["a tool that does not group its results", (p: string) => gridBody(p, [tile()], { tool_name: "image.crop" })],
    ["a studio id", (p: string) => gridBody(p, [tile()], { studio_id: crypto.randomUUID() })],
    ["a purpose", (p: string) => gridBody(p, [tile()], { purpose: "project_cover" })],
    [
      "two tiles on one node",
      (p: string) => {
        const one = tile();
        return gridBody(p, [one, { ...tile(), node_id: one.node_id }]);
      },
    ],
    [
      "a tile without a node",
      (p: string) => {
        const { node_id: _drop, ...rest } = tile();
        return gridBody(p, [rest]);
      },
    ],
  ])("refuses a batch carrying %s", async (_label, make) => {
    const a = await account();

    const res = await batch(a.cookie, make(a.projectId));

    expect(res.status).toBe(422);
  });

  it("settles every tile when storage is full and each one is already held", async () => {
    const a = await account(getMembershipLimits("base").storage_bytes);
    const hashes = [0, 1, 2].map(() => crypto.randomBytes(32).toString("hex"));
    for (const hash of hashes) await register(a.studioId, a.userId, hash, TILE_BYTES);

    const res = await batch(a.cookie, gridBody(a.projectId, hashes.map((hash) => tile(hash))));

    expect(res.status).toBe(200);
    const { data } = (await res.json()) as { data: { items: Item[] } };
    expect(data.items.every((item) => item.alreadyExists === true)).toBe(true);
  });

  it("refuses only the tiles that need room when storage is full", async () => {
    const a = await account(getMembershipLimits("base").storage_bytes);
    const held = crypto.randomBytes(32).toString("hex");
    await register(a.studioId, a.userId, held, TILE_BYTES);

    const res = await batch(a.cookie, gridBody(a.projectId, [tile(), tile(held), tile()]));

    expect(res.status).toBe(200);
    const { data } = (await res.json()) as { data: { items: Item[] } };
    expect(data.items).toEqual([
      { refused: { reason: "storage" } },
      expect.objectContaining({ alreadyExists: true }),
      { refused: { reason: "storage" } },
    ]);
  });

  it("T71: answers a failed open, a dedup hit and two opened uploads each on their own", async () => {
    const a = await account();
    const hit = crypto.randomBytes(32).toString("hex");
    await register(a.studioId, a.userId, hit, TILE_BYTES);
    const tiles = [tile(), tile(), tile(hit), tile()];
    // The key is minted inside the request, so the failing tile is found by
    // the node its grant was opened for.
    setOpenMode(async (key) => {
      const [row] = await sql<{ node_id: string | null }[]>`
        SELECT node_id FROM upload_grants WHERE storage_key = ${key}
      `;
      return row?.node_id === tiles[1]!.node_id ? new UploadHttpError(502, "store_failed") : "ok";
    });

    const res = await batch(a.cookie, gridBody(a.projectId, tiles));

    expect(res.status).toBe(200);
    const { data } = (await res.json()) as { data: { items: Item[] } };
    expect(data.items).toHaveLength(4);
    expect(isOpened(data.items[0]!)).toBe(true);
    expect(Object.keys(data.items[1]!).sort()).toEqual(["openFailed", "taskId"]);
    expect(data.items[1]!.openFailed).toEqual({ reason: "store_failed" });
    expect(typeof data.items[1]!.taskId).toBe("string");
    expect(data.items[2]!.alreadyExists).toBe(true);
    expect(isOpened(data.items[3]!)).toBe(true);

    const opens = opensByKey();
    expect(opens.size).toBe(3);
    expect([...opens.values()]).toEqual([1, 1, 1]);
    const grants = await sql<{ node_id: string; voided_at: Date | null; status: string }[]>`
      SELECT g.node_id, g.voided_at, t.status
      FROM upload_grants g JOIN node_tasks t ON t.storage_key = g.storage_key
      WHERE g.user_id = ${a.userId}
    `;
    const byNode = new Map(grants.map((g) => [g.node_id, g]));
    expect(byNode.get(tiles[1]!.node_id as string)).toMatchObject({ status: "failed" });
    expect(byNode.get(tiles[1]!.node_id as string)!.voided_at).not.toBeNull();
    expect(byNode.get(tiles[0]!.node_id as string)).toMatchObject({ status: "running", voided_at: null });
    expect(byNode.get(tiles[3]!.node_id as string)).toMatchObject({ status: "running", voided_at: null });
    expect(await getRedis().zcard(`${env.ENV}:ratelimit:upload-ticket:${a.userId}`)).toBe(1);
    expect(logged.error.mock.calls.filter((call) => call[1] === "upload_open_failed")).toHaveLength(1);
  });

  it("T73: opens a batch's uploads at the same time", async () => {
    const a = await account();
    // Each open answers only once all eight have arrived; opened one after
    // another, the first would wait out its five seconds and fail.
    setOpenMode(async () => {
      const until = Date.now() + 5000;
      while (openCalls().length < 8) {
        if (Date.now() > until) return new Error("the opens did not run at the same time");
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      return "ok";
    });

    const res = await batch(a.cookie, gridBody(a.projectId, Array.from({ length: 8 }, () => tile())));

    expect(res.status).toBe(200);
    const { data } = (await res.json()) as { data: { items: Item[] } };
    expect(data.items).toHaveLength(8);
    expect(data.items.every(isOpened)).toBe(true);
  });

  it("answers a caller who is not on the project as if it did not exist", async () => {
    const a = await account();
    const b = await account();

    const res = await batch(b.cookie, gridBody(a.projectId, [tile()]));

    expect(res.status).toBe(404);
  });
});

/**
 * Ask to finish one upload, holding a token the Worker would have given it.
 * The key has no grant, so a request the limit lets through answers 404.
 * @param cookie - The caller's session.
 * @param uploadId - The upload in the path.
 * @param signedFor - The upload the token was signed for.
 * @returns The response.
 */
async function finish(cookie: string, uploadId: string, signedFor = uploadId): Promise<Response> {
  const token = await signSessionToken(
    {
      storageKey: `image/2026-10-12/${signedFor}.png`,
      uploadId: signedFor,
      contentType: "image/png",
      expiresAt: Date.now() + 900_000,
      partSize: 8 * 1024 * 1024,
      totalParts: 1,
    },
    process.env.INGEST_SHARED_SECRET ?? "",
  );
  return app.request(`/api/v1/assets/uploads/${uploadId}/complete`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie, "x-upload-token": token },
    body: JSON.stringify({ parts: [{ partNumber: 1, etag: "etag-1" }] }),
  });
}

describe("finishing a batch's uploads", () => {
  it("finishes three 8x8 grids in a minute without meeting either limit", async () => {
    const a = await account();

    const statuses: number[] = [];
    for (let i = 0; i < 3 * 64; i++) statuses.push((await finish(a.cookie, crypto.randomUUID())).status);

    expect(statuses.filter((status) => status === 429)).toEqual([]);
  });

  it("limits finishing one upload over and over", async () => {
    const a = await account();
    const uploadId = crypto.randomUUID();

    const statuses: number[] = [];
    for (let i = 0; i < 30; i++) statuses.push((await finish(a.cookie, uploadId)).status);

    expect(statuses).toContain(429);
    // A finish the upload's own quota refuses takes no room in the person's.
    expect(await getRedis().zcard(`${env.ENV}:ratelimit:upload-complete-user:${a.userId}`)).toBe(
      getRateLimit("upload-complete").max,
    );
  });

  // Both quotas are judged in one step: a finish the person's quota refuses
  // takes no room in the upload's either.
  it("refuses a finish once the person's quota is full without counting it for the upload", async () => {
    const a = await account();
    const key = `${env.ENV}:ratelimit:upload-complete-user:${a.userId}`;
    const now = Date.now();
    const seeds = Array.from({ length: getRateLimit("upload-complete-user").max }, (_, i) => [now, `seed-${i}`]).flat();
    await getRedis().zadd(key, ...seeds);
    await getRedis().pexpire(key, 60_000);
    const uploadId = crypto.randomUUID();

    expect((await finish(a.cookie, uploadId)).status).toBe(429);
    expect(await getRedis().exists(`${env.ENV}:ratelimit:upload-complete:${a.userId}:${uploadId}`)).toBe(0);
  });

  // Every upload a person opens can be finished here under its own id, so a
  // person's finishes are also counted together: the most finishes one person
  // can send us is capped at the most uploads the ticket limit can sign.
  it("counts every upload a person finishes in one bucket for that person", async () => {
    const a = await account();

    for (let i = 0; i < 3; i++) await finish(a.cookie, crypto.randomUUID());

    expect(await getRedis().zcard(`${env.ENV}:ratelimit:upload-complete-user:${a.userId}`)).toBe(3);
  });

  // The limit is per upload, keyed by the id in the path: an id no token was
  // signed for is refused before it gets a bucket of its own.
  it("refuses an upload id its token was not signed for without counting it", async () => {
    const a = await account();
    const made = crypto.randomUUID();

    const res = await finish(a.cookie, made, crypto.randomUUID());

    expect(res.status).toBe(401);
    expect(await getRedis().exists(`${env.ENV}:ratelimit:upload-complete:${a.userId}:${made}`)).toBe(0);
  });
});
