// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * Invitations whose Studio lives in another region (inner#1955, acceptances 7
 * and 10) — real PG + Redis and a real HTTP stand-in for the region `sg`.
 *
 * A token issued in another region starts with that region's code and a dot;
 * the global region forwards its preview there. A token with no prefix was
 * issued here, which is where every existing invitation lives. Signing in
 * claims email invitations in this region before answering, and hands the
 * other regions' claims to a worker job, so a slow or absent region never
 * slows sign-in.
 *
 * The pins:
 *
 *   1. A prefixed token's preview is answered by its region.
 *   2. A token with no prefix is answered here and asks no region.
 *   3. A region that does not answer turns the preview into 503
 *      region_unavailable within the timeout.
 *   4. Signing in answers at once while the other region hangs, and leaves
 *      a claim job for that region.
 */

import { describe, it, expect, beforeAll, afterAll, afterEach, inject, vi } from "vitest";

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

import crypto from "node:crypto";
import postgres from "postgres";
import { GLOBAL_REGION_SETTINGS } from "./global-region-env.js";
import { createQueue, initCore, loadLocales } from "@breatic/core";
import type { Hono } from "hono";
import { hashPassword } from "@server/modules/auth/auth.service.js";
import { withPeer } from "../helpers/peer.js";
import { startRegionStandIn, type RegionStandIn } from "./region-harness.js";

loadLocales();

let sql: ReturnType<typeof postgres>;
let app: Hono;
let sg: RegionStandIn;
let seq = 0;

beforeAll(async () => {
  sg = await startRegionStandIn();
  initCore({
    ...process.env,
    REGION: "us-west",
    GLOBAL_REGION: "us-west",
    REGION_API_URLS: JSON.stringify({ sg: sg.url }),
    ...GLOBAL_REGION_SETTINGS,
    INTERNAL_API_SECRET: "invitation-regions-test-secret",
  });
  sql = postgres(inject("DATABASE_URL"), {
    max: 2,
    prepare: false,
    connection: { application_name: "invitation-regions-test" },
  });
  const { createApp } = await import("@server/app.js");
  app = withPeer(createApp());
});

afterEach(() => {
  sg.reset();
});

afterAll(async () => {
  initCore(process.env);
  await sg.close();
  await sql?.end({ timeout: 5 });
});

/**
 * Preview an invitation and time it.
 * @param token - The token from the link.
 * @returns The status, body and elapsed milliseconds.
 */
async function preview(token: string): Promise<{ status: number; body: Record<string, unknown>; ms: number }> {
  const started = Date.now();
  const res = await app.request(`/api/v1/auth/invitation?token=${encodeURIComponent(token)}`);
  return { status: res.status, body: (await res.json()) as Record<string, unknown>, ms: Date.now() - started };
}

describe("previewing an invitation", () => {
  it("asks the region a prefixed token names", async () => {
    const token = `sg.${crypto.randomBytes(20).toString("hex")}`;
    const answer = { kind: "studio", targetName: "Far", inviterName: "Ann", inviteeEmail: "x@example.test", role: "maintainer" };
    sg.answers.previewInvitation = answer;

    const { status, body } = await preview(token);

    expect(status).toBe(200);
    expect(body.data).toEqual(answer);
    expect(sg.received).toEqual([{ side: "region", fn: "previewInvitation", args: [token], signed: true }]);
  });

  it("answers a token with no prefix here and asks no region", async () => {
    await preview(crypto.randomBytes(20).toString("hex"));

    expect(sg.received).toEqual([]);
  });

  it("answers 503 region_unavailable within the timeout when the region does not answer", async () => {
    sg.mode = "hang";

    const { status, body, ms } = await preview(`sg.${crypto.randomBytes(20).toString("hex")}`);

    expect(status).toBe(503);
    expect((body.error as { reason?: string }).reason).toBe("region_unavailable");
    expect(ms).toBeLessThan(5_000);
  });
});

describe("signing in", () => {
  it("answers at once while another region hangs and leaves a claim job for it", async () => {
    sg.mode = "hang";
    const email = `invite-claim-${Date.now()}-${seq++}@example.test`;
    const password = "correct horse battery staple";
    const [user] = await sql<{ id: string }[]>`
      INSERT INTO users (email, email_verified, hashed_password)
      VALUES (${email}, true, ${await hashPassword(password)}) RETURNING id
    `;
    const slug = `ir-${crypto.randomBytes(5).toString("hex")}`;
    const [studio] = await sql<{ id: string }[]>`
      INSERT INTO studios (created_by_user_id, slug, type, name) VALUES (${user!.id}, ${slug}, 'personal', 'Me') RETURNING id
    `;
    await sql`INSERT INTO studio_members (studio_id, user_id, role) VALUES (${studio!.id}, ${user!.id}, 'admin')`;
    await sql`
      INSERT INTO studio_directory (studio_id, slug, region, type, name, admin_user_id, created_by_user_id, state)
      VALUES (${studio!.id}, ${slug}, NULL, 'personal', 'Me', ${user!.id}, ${user!.id}, 'live')
    `;

    const started = Date.now();
    const res = await app.request("/api/v1/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password }),
    });

    expect(res.status).toBe(200);
    expect(Date.now() - started).toBeLessThan(3_000);
    const jobs = await createQueue("invitation-claim-forward").getJobs(["waiting", "delayed", "active"]);
    const job = jobs.find((queued) => queued.data?.region === "sg" && queued.data?.userId === user!.id);
    expect(job).toBeDefined();
    // Retried and cleaned up like every other job.
    expect(job!.opts.attempts).toBeGreaterThan(1);
    expect(job!.opts.removeOnComplete).toBeTruthy();
    expect(job!.opts.removeOnFail).toBeTruthy();
  });
});
