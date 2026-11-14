// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * What a region that does not hold the global data asks the global region
 * while serving Studio and Project requests (inner#1955, acceptance 2) — real
 * PG + Redis and a real HTTP stand-in for the global region.
 *
 * The suite runs as `sg`. Requests carry an identity token signed with a test
 * key, so `requireAuth` verifies them locally. The stand-in records every call
 * the region makes; each must be one of the global interfaces the design
 * lists (section 6), so a region path that still reaches for global data
 * directly, or through a name nobody agreed on, shows up here.
 *
 * The pins:
 *
 *   1. Opening a Studio, listing its members, creating a Project in it and
 *      opening that Project all succeed in the region.
 *   2. Every call they make to the global region is a listed interface.
 *   3. A storage refusal tells the admin, reading the admin's account from
 *      the global region.
 */

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

import crypto, { generateKeyPairSync } from "node:crypto";
import postgres from "postgres";
import { identityCookieName, getMembershipLimits, initCore, loadLocales, signIdentityToken } from "@breatic/core";
import type { Hono } from "hono";
import { withPeer } from "../helpers/peer.js";
import { startRegionStandIn, type RegionStandIn } from "./region-harness.js";
import { assetRepo } from "@breatic/domain";
import { precheckCredits } from "@server/modules/payment/credit-precheck.service.js";
import { assertStudioStorageAllowance } from "@server/modules/asset/storageQuota.service.js";

loadLocales();

/** The global interfaces of design section 6, by the name the region calls. */
const LISTED = new Set([
  "findAccountByEmail",
  "getAccounts",
  "getProfiles",
  "getAgentModel",
  "setAgentModel",
  "getLimitsForStudio",
  "reserveCredits",
  "getSpendableCredits",
  "releaseHold",
  "settleCharge",
  "readStudioCredits",
  "listStudioLedger",
  "getCreditPosition",
  "hasActiveDesignationsTo",
  "getStorageBudget",
  "recordRegionUsage",
  "transferAdmin",
  "reserveSlug",
  "releaseSlug",
  "checkSessions",
  "applyRegionEvent",
  "enqueueAdsConversion",
  "claimAccountMilestone",
  "getUnassignedCredits",
  "getGrantedCredits",
  "getStudioDebt",
]);

const keys = generateKeyPairSync("ed25519");
const PRIVATE_KEY = keys.privateKey.export({ type: "pkcs8", format: "pem" }).toString();
const PUBLIC_KEY = keys.publicKey.export({ type: "spki", format: "pem" }).toString();

let sql: ReturnType<typeof postgres>;
let app: Hono;
let global: RegionStandIn;

/**
 * Answer the reads a region makes while serving these requests.
 * @param stand - The stand-in to teach.
 */
function answerReads(stand: RegionStandIn): void {
  stand.answers.getLimitsForStudio = () => getMembershipLimits("team");
  stand.answers.getProfiles = () => ({});
  stand.answers.getAccounts = () => [];
  stand.answers.claimAccountMilestone = () => ({ claimed: false });
  stand.answers.readStudioCredits = () => ({
    spendable: "0.000000", debt: "0.000000", held: "0.000000", available: "0.000000", lots: [], ledger: [],
  });
}

beforeAll(async () => {
  global = await startRegionStandIn();
  answerReads(global);
  initCore({
    ...process.env,
    REGION: "sg",
    GLOBAL_REGION: "us-west",
    GLOBAL_API_URL: global.url,
    IDENTITY_PUBLIC_KEYS: JSON.stringify({ t1: PUBLIC_KEY }),
    INTERNAL_API_SECRET: "region-global-calls-test-secret",
    PAYMENT_ENABLED: "true",
    STRIPE_SECRET_KEY: "sk_test_unused_by_this_suite",
    STRIPE_WEBHOOK_SECRET: "whsec_unused_by_this_suite",
  });
  sql = postgres(inject("DATABASE_URL"), {
    max: 2,
    prepare: false,
    connection: { application_name: "region-global-calls-test" },
  });
  const { createApp } = await import("@server/app.js");
  app = withPeer(createApp());
});

afterAll(async () => {
  initCore(process.env);
  await global.close();
  await sql?.end({ timeout: 5 });
});

/**
 * A team Studio in this region whose admin is a fresh account.
 * @returns The admin, the Studio and a cookie carrying the admin's identity.
 */
async function regionStudio(): Promise<{ userId: string; studioId: string; slug: string; cookie: string }> {
  const email = `global-calls-${Date.now()}@example.test`;
  const [user] = await sql<{ id: string }[]>`
    INSERT INTO users (email, email_verified, membership_tier) VALUES (${email}, true, 'team') RETURNING id
  `;
  const slug = `gc-${crypto.randomBytes(5).toString("hex")}`;
  const [studio] = await sql<{ id: string }[]>`
    INSERT INTO studios (created_by_user_id, slug, type, name) VALUES (${user!.id}, ${slug}, 'team', 'Far') RETURNING id
  `;
  await sql`INSERT INTO studio_members (studio_id, user_id, role) VALUES (${studio!.id}, ${user!.id}, 'admin')`;
  const token = signIdentityToken(
    { sub: user!.id, sid: crypto.randomBytes(32).toString("hex"), email, tier: "team", locale: "en", personalStudio: null },
    { kid: "t1", privateKey: PRIVATE_KEY },
    Math.floor(Date.now() / 1000),
  );
  return { userId: user!.id, studioId: studio!.id, slug, cookie: `${identityCookieName()}=${token}` };
}

describe("serving Studio and Project requests in a region", () => {
  it("succeeds and asks the global region only through listed interfaces", async () => {
    const { studioId, slug, cookie } = await regionStudio();
    const headers = { cookie, "Content-Type": "application/json" };

    const studioPage = await app.request(`/api/v1/studio/${slug}`, { headers });
    const members = await app.request(`/api/v1/studio/${slug}/members`, { headers });
    const created = await app.request("/api/v1/projects", {
      method: "POST",
      headers: { ...headers, "Idempotency-Key": crypto.randomUUID() },
      body: JSON.stringify({ studioId, name: "Far project", slug: `far-${crypto.randomBytes(4).toString("hex")}` }),
    });
    const projectId = ((await created.json()) as { data?: { id?: string } }).data?.id;
    const project = await app.request(`/api/v1/projects/${projectId}`, { headers });
    const credits = await app.request(`/api/v1/studio/${slug}/credits?amountFormat=decimal-v1`, { headers });

    expect([studioPage.status, members.status, created.status, project.status, credits.status]).toEqual([200, 200, 201, 200, 200]);
    expect(global.received.map((call) => call.fn)).toContain("readStudioCredits");
    expect(global.received.length).toBeGreaterThan(0);
    for (const call of global.received) {
      expect(call.side).toBe("global");
      expect(call.signed).toBe(true);
      expect([...LISTED], `unlisted global call ${call.fn}`).toContain(call.fn);
    }
  });

  it("explains a refused run with account figures read from the global region", async () => {
    const { userId, studioId } = await regionStudio();
    const [project] = await sql<{ id: string }[]>`
      INSERT INTO projects (studio_id, created_by_user_id, slug, name)
      VALUES (${studioId}, ${userId}, ${`gc-p-${crypto.randomBytes(4).toString("hex")}`}, 'Far') RETURNING id
    `;
    global.answers.getSpendableCredits = "0.000000";
    global.answers.getUnassignedCredits = "5.000000";
    global.received.length = 0;

    const refused = await precheckCredits(project!.id, userId, 1).then(() => null, (err: unknown) => err);

    expect(refused).toMatchObject({ statusCode: 402 });
    expect(global.received.map((call) => call.fn)).toEqual(["getSpendableCredits", "getUnassignedCredits"]);
  });

  it("reads the admin's account from the global region to mail a storage refusal", async () => {
    const { userId, studioId } = await regionStudio();
    await assetRepo.registerWithDedup({
      studioId,
      producedByUserId: userId,
      contentHash: crypto.randomBytes(32).toString("hex"),
      storageKey: `image/2026-11-14/${crypto.randomUUID()}.png`,
      fileUrl: `https://cdn/${crypto.randomUUID()}.png`,
      sizeBytes: 10,
      mimeType: "image/png",
      kind: "image",
      source: "upload",
    });
    global.answers.getStorageBudget = { adminUserId: userId, storageBytes: 1, elsewhereBytes: 0 };
    global.received.length = 0;

    await expect(assertStudioStorageAllowance(studioId, "upload")).rejects.toMatchObject({ statusCode: 507 });

    await vi.waitFor(() => expect(global.received.map((call) => call.fn)).toContain("getAccounts"));
    const accounts = global.received.find((call) => call.fn === "getAccounts");
    expect(accounts?.args).toEqual([[userId]]);
  });
});
