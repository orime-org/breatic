// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Each run-once entry does its work once for a press sent twice (inner#1490)
 * — real PG and Redis, through the real Hono app.
 *
 * The browser re-sends an unanswered press with the same `Idempotency-Key`.
 * For every entry below, the second arrival must come back as the first
 * answer replayed, and whatever the press writes or sends must have happened
 * exactly once. Generate and new-conversation carry the same pin in their own
 * suites (`storage-quota-routes`, `conversation-naming`).
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

vi.mock("@server/utils/send-best-effort-mail.js", () => ({
  sendBestEffortMail: async () => {},
}));

import crypto from "node:crypto";
import postgres from "postgres";
import {
  initCore,
  getRedis,
  setSession,
  sessionCookieName,
  loadLocales,
} from "@breatic/core";
import type { Hono } from "hono";
import { useCommerceApp } from "./commerce-harness.js";

/**
 * The suite's environment. The upscaler's provider needs a key to be served,
 * or the mini-tool press is refused with 503 before any row opens; no worker
 * runs here, so the queued job never reaches it.
 */
const SUITE_ENV = { ...process.env, WAVESPEED_API_KEY: "wavespeed-key-for-this-suite" };

let sql: ReturnType<typeof postgres>;
let app: Hono;
let seq = 0;

beforeAll(async () => {
  initCore(SUITE_ENV);
  loadLocales();
  initConfiguredProvider();
  sql = postgres(inject("DATABASE_URL"), {
    max: 2,
    prepare: false,
    connection: { application_name: "run-once-entries-test" },
  });
  const { createApp } = await import("@server/app.js");
  app = createApp();
});

afterAll(async () => {
  await sql?.end({ timeout: 1 });
  initCore(process.env);
});

/** A signed-in account. */
interface Account {
  userId: string;
  studioId: string;
  projectId: string;
  cookie: string;
}

/**
 * An account with a personal studio and a project it owns, signed in.
 * @returns The ids and a login cookie.
 */
async function seedAccount(): Promise<Account> {
  seq += 1;
  const stamp = `${Date.now()}-${seq}`;
  const [u] = await sql<{ id: string }[]>`
    INSERT INTO users (email, email_verified)
    VALUES (${`roe-${stamp}@example.test`}, true)
    RETURNING id
  `;
  const userId = u!.id;
  const [st] = await sql<{ id: string }[]>`
    INSERT INTO studios (created_by_user_id, slug, type, name)
    VALUES (${userId}, ${`roe-p-${stamp}`}, 'personal', 'Personal')
    RETURNING id
  `;
  const studioId = st!.id;
  await sql`
    INSERT INTO studio_members (studio_id, user_id, role)
    VALUES (${studioId}, ${userId}, 'admin')
  `;
  const slug = `roe-proj-${seq}`;
  const [p] = await sql<{ id: string }[]>`
    INSERT INTO projects (studio_id, created_by_user_id, name, slug)
    VALUES (${studioId}, ${userId}, ${`P ${slug}`}, ${slug})
    RETURNING id
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
 * Send the same press twice, as the browser re-sends an unanswered one.
 * @param path - The entry.
 * @param cookie - The caller's session cookie.
 * @param body - The request body.
 * @param target - The app to send it to.
 * @returns Both answers, in order.
 */
async function pressTwice(
  path: string,
  cookie: string,
  body: Record<string, unknown>,
  target: Hono = app,
): Promise<{ first: Response; again: Response }> {
  const press = {
    method: "POST",
    headers: { Cookie: cookie, "Content-Type": "application/json", "Idempotency-Key": crypto.randomUUID() },
    body: JSON.stringify(body),
  };
  const first = await target.request(path, press);
  const again = await target.request(path, press);
  return { first, again };
}

/**
 * Assert the second answer is the first one replayed.
 * @param first - The first answer.
 * @param again - The answer to the re-sent press.
 * @param status - The status the first answer must carry.
 * @returns Nothing.
 */
async function expectReplayed(first: Response, again: Response, status: number): Promise<void> {
  expect(first.status).toBe(status);
  expect(again.status).toBe(status);
  expect(first.headers.get("Idempotent-Replayed")).toBeNull();
  expect(again.headers.get("Idempotent-Replayed")).toBe("true");
  expect(await again.json()).toEqual(await first.json());
}

/**
 * How many task rows a project holds, and how many node rows a node holds.
 * @param projectId - The project.
 * @param nodeId - The node the run writes to.
 * @returns Both counts.
 */
async function taskCounts(projectId: string, nodeId: string): Promise<{ tasks: number; nodeTasks: number }> {
  const [tasks] = await sql<{ n: number }[]>`
    SELECT count(*)::int AS n FROM tasks WHERE project_id = ${projectId}
  `;
  const [nodeTasks] = await sql<{ n: number }[]>`
    SELECT count(*)::int AS n FROM node_tasks WHERE node_id = ${nodeId}
  `;
  return { tasks: tasks!.n, nodeTasks: nodeTasks!.n };
}

describe("canvas and project entries", () => {
  it("starts one reading for an understand press sent twice", async () => {
    const { cookie, projectId } = await seedAccount();
    const nodeId = crypto.randomUUID();

    const { first, again } = await pressTwice("/api/v1/canvas/understand", cookie, {
      project_id: projectId,
      space_id: crypto.randomUUID(),
      source_type: "image",
      source_url: "https://assets.invalid/image/a.png",
      node_ids: [nodeId],
    });

    await expectReplayed(first, again, 201);
    expect(await taskCounts(projectId, nodeId)).toEqual({ tasks: 1, nodeTasks: 1 });
  });

  // inner#856: the row this opens says "transcribe", which the column's own
  // CHECK has to allow.
  it("starts one transcription for a press sent twice", async () => {
    const { cookie, projectId } = await seedAccount();
    const nodeId = crypto.randomUUID();

    const { first, again } = await pressTwice("/api/v1/canvas/transcribe", cookie, {
      project_id: projectId,
      space_id: crypto.randomUUID(),
      source_type: "audio",
      source_url: "https://assets.invalid/audio/a.m4a",
      node_ids: [nodeId],
      keep_fillers: true,
    });

    await expectReplayed(first, again, 201);
    expect(await taskCounts(projectId, nodeId)).toEqual({ tasks: 1, nodeTasks: 1 });
  });

  it("starts one mini-tool run for a press sent twice", async () => {
    const { cookie, projectId } = await seedAccount();
    const nodeId = crypto.randomUUID();

    const { first, again } = await pressTwice("/api/v1/mini-tools", cookie, {
      tool: "image.upscale",
      project_id: projectId,
      space_id: crypto.randomUUID(),
      node_ids: [nodeId],
      source: { url: "https://assets.invalid/image/a.png" },
      params: { target_megapixels: 16, creativity: 2 },
      slots: {},
    });

    await expectReplayed(first, again, 201);
    expect(await taskCounts(projectId, nodeId)).toEqual({ tasks: 1, nodeTasks: 1 });
  });

  it("creates one project for a press sent twice", async () => {
    const { cookie, studioId } = await seedAccount();
    seq += 1;

    const { first, again } = await pressTwice("/api/v1/projects", cookie, {
      studioId,
      name: "Twice pressed",
      slug: `roe-new-${Date.now()}-${seq}`,
    });

    await expectReplayed(first, again, 201);
    const [row] = await sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM projects WHERE studio_id = ${studioId}
    `;
    // The seeded project plus the one this press made.
    expect(row!.n).toBe(2);
  });
});

describe("purchase and membership entries", () => {
  // These forward to the billing service; runOnce answers the re-sent press
  // before it is forwarded again (inner#1993 §3.2).
  const commerce = useCommerceApp("run-once-entries-commerce");

  it("forwards one membership checkout for a press sent twice", async () => {
    const { cookie } = await seedAccount();

    const { first, again } = await pressTwice(
      "/api/v1/account/subscription/checkout",
      cookie,
      { tier: "pro", period: "month", return_url: "https://app.example.test/back" },
      commerce.app,
    );

    await expectReplayed(first, again, 200);
    expect(commerce.received).toHaveLength(1);
  });

  it("forwards one membership change for a press sent twice", async () => {
    const { cookie } = await seedAccount();

    const { first, again } = await pressTwice(
      "/api/v1/account/subscription/change",
      cookie,
      { tier: "team", period: "month" },
      commerce.app,
    );

    await expectReplayed(first, again, 200);
    expect(commerce.received).toHaveLength(1);
  });

  it("forwards one credits checkout for a press sent twice", async () => {
    const { cookie } = await seedAccount();

    const { first, again } = await pressTwice(
      "/api/v1/payment/checkout",
      cookie,
      { price_cents: 1000, return_url: "https://app.example.test/s/mine", time_zone: "Asia/Shanghai", consented: true },
      commerce.app,
    );

    await expectReplayed(first, again, 200);
    expect(commerce.received).toHaveLength(1);
  });
});
