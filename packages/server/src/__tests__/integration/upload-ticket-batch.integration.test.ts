// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * Finishing many uploads in a row (inner#1303 §7). The batch form of
 * `POST /assets/upload-ticket` is gone (inner#1968): the grid is cut on the
 * server, so no browser tool asks for many tickets at once.
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
} from "@breatic/core";
import { signSessionToken } from "@breatic/shared";
import { resetOpenDouble } from "../helpers/ingest-open-double.js";
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

let seq = 0;

/**
 * A base-tier account with a personal studio and a project.
 * @returns The ids and a login cookie.
 */
async function account(): Promise<{
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
  const token = crypto.randomBytes(24).toString("hex");
  await setSession(getRedis(), token, userId);
  return { userId, studioId, projectId, cookie: `${sessionCookieName()}=${token}` };
}

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
