// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * `GET /api/v1/projects/:id/key-plan` (inner#1953): what a Project's generation panel needs to know about the keys
 * its Studio's payer brought: whether language-model calls run on the payer's OpenRouter key, which upstream each
 * media model was pointed at with the availability the payer's keys give it, and whether that payer is the caller or
 * the Studio's admin. Every member of the Project may read it; it carries no key, no sealed text and no hint.
 *
 * Also the three reads behind it: `studioProviderKey`, `providerKeyById` and `studioKeyPlan`.
 */

import { describe, it, expect, beforeAll, afterAll, inject, vi } from "vitest";

// `ai` is stubbed: the real SDK is replaced with a double that reaches no
// network, so this suite needs no API key and the SDK stays out of its
// module graph.
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

import crypto, { randomBytes } from "node:crypto";
import postgres from "postgres";
import {
  accountModelUpstreamsRepo,
  accountProviderKeysRepo,
  getRedis,
  initCore,
  loadLocales,
  sealProviderKey,
  sessionCookieName,
  setSession,
} from "@breatic/core";
import { initProvider } from "@breatic/domain";
import { providerKeyById, studioKeyPlan, studioProviderKey } from "../../../../domain/src/provider/account-keys.service.js";
// The source module reads its own provider instance, apart from the built package the app runs on.
import { initProvider as initSourceProvider } from "../../../../domain/src/provider/instance.js";
import type { Hono } from "hono";

const SECRET = randomBytes(32);
const RING = { current: "t1", keys: { t1: SECRET } };
/** A media model bound on WaveSpeed, fal and SandBase. */
const MODEL = "gpt-image-2.5-sunburst-text-to-image";
/** A model only WaveSpeed runs. */
const WAVESPEED_ONLY = "ideogram-v3-quality";

let sql: ReturnType<typeof postgres>;
let app: Hono;

beforeAll(async () => {
  initCore({ ...process.env, PROVIDER_KEY_SECRET_ID: "t1", PROVIDER_KEY_SECRETS: JSON.stringify({ t1: SECRET.toString("hex") }) });
  loadLocales();
  initProvider();
  initSourceProvider();
  sql = postgres(inject("DATABASE_URL"), { max: 4, prepare: false, connection: { application_name: "byok-key-plan-test" } });
  const { createApp } = await import("@server/app.js");
  app = createApp();
});

afterAll(async () => {
  await sql?.end({ timeout: 5 });
});

/**
 * A fresh verified account, signed in.
 * @returns Its id and a Cookie header for it.
 */
async function signedIn(): Promise<{ userId: string; cookie: string }> {
  const [user] = await sql<{ id: string }[]>`
    INSERT INTO users (email, email_verified) VALUES (${`byok-plan-${crypto.randomUUID().slice(0, 8)}@test.local`}, true) RETURNING id
  `;
  const token = crypto.randomBytes(24).toString("hex");
  await setSession(getRedis(), token, user!.id);
  return { userId: user!.id, cookie: `${sessionCookieName()}=${token}` };
}

/**
 * A Studio administered by an account, with one Project the admin owns.
 * @param adminUserId - Its admin.
 * @param type - Personal or team.
 * @returns The Studio's and the Project's ids.
 */
async function seedStudio(adminUserId: string, type: "personal" | "team"): Promise<{ studioId: string; projectId: string }> {
  const tag = crypto.randomUUID().slice(0, 8);
  const [studio] = await sql<{ id: string }[]>`
    INSERT INTO studios (created_by_user_id, slug, type, name) VALUES (${adminUserId}, ${`plan-${tag}`}, ${type}, 'Plan') RETURNING id
  `;
  await sql`INSERT INTO studio_members (studio_id, user_id, role) VALUES (${studio!.id}, ${adminUserId}, 'admin')`;
  const [project] = await sql<{ id: string }[]>`
    INSERT INTO projects (studio_id, created_by_user_id, slug, name) VALUES (${studio!.id}, ${adminUserId}, ${`plan-p-${tag}`}, 'P') RETURNING id
  `;
  await sql`INSERT INTO project_members (project_id, user_id, role, added_by) VALUES (${project!.id}, ${adminUserId}, 'owner', null)`;
  return { studioId: studio!.id, projectId: project!.id };
}

/**
 * Add an account to a team Studio, and to its Project when given.
 * @param studioId - The Studio.
 * @param userId - The account.
 * @param projectId - The Project to add it to, if any.
 * @returns Once added.
 */
async function addMember(studioId: string, userId: string, projectId?: string): Promise<void> {
  await sql`INSERT INTO studio_members (studio_id, user_id, role) VALUES (${studioId}, ${userId}, 'maintainer')`;
  if (projectId !== undefined) {
    await sql`INSERT INTO project_members (project_id, user_id, role, added_by) VALUES (${projectId}, ${userId}, 'editor', null)`;
  }
}

/**
 * Save an account's key the way the settings route does, sealed with this deployment's ring.
 * @param userId - The account.
 * @param upstream - The upstream.
 * @param key - The key.
 * @returns The row's id, its sealed text and the hint the account sees.
 */
async function saveKey(userId: string, upstream: string, key: string): Promise<{ id: string; ciphertext: string; hint: string }> {
  const ciphertext = sealProviderKey(key, RING);
  const hint = `${key.slice(0, 6)}…${key.slice(-4)}`;
  const saved = await accountProviderKeysRepo.saveKey({ userId, upstream, ciphertext, displayHint: hint });
  return { id: saved.id, ciphertext, hint };
}

/** The plan as the panel reads it. */
interface KeyPlan {
  payer: "self" | "admin";
  payerUserId: string | null;
  llm: { usesAccountKey: boolean };
  models: Record<string, { upstream: string; availability: { upstreams: { upstream: string; configured: boolean }[] } }>;
  upstreamNames: Record<string, string>;
}

/**
 * Read a Project's key plan.
 * @param cookie - The caller's Cookie header.
 * @param projectId - The Project.
 * @returns The response's status, plan and raw text.
 */
async function keyPlan(cookie: string | null, projectId: string): Promise<{ status: number; plan: KeyPlan | undefined; text: string }> {
  const res = await app.request(`/api/v1/projects/${projectId}/key-plan`, { headers: cookie === null ? {} : { Cookie: cookie } });
  const text = await res.text();
  const plan = res.status === 200 ? (JSON.parse(text) as { data: KeyPlan }).data : undefined;
  return { status: res.status, plan, text };
}

/**
 * That a text holds none of a key's traces.
 * @param text - What was answered.
 * @param saved - The keys and their stored forms.
 */
function expectNoKeyTrace(text: string, saved: { key: string; ciphertext: string; hint: string }[]): void {
  for (const { key, ciphertext, hint } of saved) {
    expect(text).not.toContain(key);
    expect(text).not.toContain(ciphertext);
    expect(text).not.toContain(hint);
  }
  expect(text).not.toMatch(/ciphertext|display_?hint/i);
}

describe("GET /api/v1/projects/:id/key-plan", () => {
  it("refuses an unauthenticated request", async () => {
    const { userId } = await signedIn();
    const { projectId } = await seedStudio(userId, "personal");

    expect((await keyPlan(null, projectId)).status).toBe(401);
  });

  it("tells the owner of a personal Studio that their own keys pay, with no trace of any key", async () => {
    const { userId, cookie } = await signedIn();
    const { projectId } = await seedStudio(userId, "personal");
    const or = { key: `sk-or-v1-${crypto.randomBytes(12).toString("hex")}` };
    const fal = { key: `fal-${crypto.randomBytes(12).toString("hex")}` };
    const saved = [{ ...or, ...(await saveKey(userId, "openrouter", or.key)) }, { ...fal, ...(await saveKey(userId, "fal", fal.key)) }];
    await accountModelUpstreamsRepo.setModelUpstream(userId, MODEL, "fal");

    const { status, plan, text } = await keyPlan(cookie, projectId);

    expect(status).toBe(200);
    expect(plan!.payer).toBe("self");
    expect(plan!.llm.usesAccountKey).toBe(true);
    expect(plan!.models[MODEL]!.upstream).toBe("fal");
    expect(plan!.models[MODEL]!.availability.upstreams.filter((u) => u.configured).map((u) => u.upstream)).toEqual(["fal"]);
    expectNoKeyTrace(text, saved);
  });

  it("leaves out a choice whose upstream no longer runs the model, so the panel prices it on the deployment's keys", async () => {
    const { userId, cookie } = await signedIn();
    const { projectId } = await seedStudio(userId, "personal");
    await saveKey(userId, "fal", `fal-${crypto.randomBytes(12).toString("hex")}`);
    await accountModelUpstreamsRepo.setModelUpstream(userId, WAVESPEED_ONLY, "fal");

    const { status, plan } = await keyPlan(cookie, projectId);

    expect(status).toBe(200);
    expect(plan!.models).toEqual({});
  });

  it("answers an account with no keys: the deployment's keys pay for everything", async () => {
    const { userId, cookie } = await signedIn();
    const { projectId } = await seedStudio(userId, "personal");

    const { status, plan } = await keyPlan(cookie, projectId);

    expect(status).toBe(200);
    expect(plan!.llm.usesAccountKey).toBe(false);
    expect(plan!.models).toEqual({});
  });

  it("tells a team member the admin's keys pay, ignoring the member's own", async () => {
    const admin = await signedIn();
    const member = await signedIn();
    const { studioId, projectId } = await seedStudio(admin.userId, "team");
    await addMember(studioId, member.userId, projectId);
    const fal = { key: `fal-${crypto.randomBytes(12).toString("hex")}` };
    const memberOr = { key: `sk-or-v1-${crypto.randomBytes(12).toString("hex")}` };
    const saved = [{ ...fal, ...(await saveKey(admin.userId, "fal", fal.key)) }, { ...memberOr, ...(await saveKey(member.userId, "openrouter", memberOr.key)) }];
    await accountModelUpstreamsRepo.setModelUpstream(admin.userId, MODEL, "fal");

    const asMember = await keyPlan(member.cookie, projectId);
    expect(asMember.status).toBe(200);
    expect(asMember.plan!.payer).toBe("admin");
    expect(asMember.plan!.payerUserId).toBe(admin.userId);
    expect(asMember.plan!.llm.usesAccountKey).toBe(false);
    expect(asMember.plan!.models[MODEL]!.upstream).toBe("fal");
    expectNoKeyTrace(asMember.text, saved);

    const asAdmin = await keyPlan(admin.cookie, projectId);
    expect(asAdmin.plan!.payer).toBe("self");
  });

  it("names every upstream as the provider configuration does, so a key failure can say which one", async () => {
    const { userId, cookie } = await signedIn();
    const { projectId } = await seedStudio(userId, "personal");

    const { status, plan } = await keyPlan(cookie, projectId);

    expect(status).toBe(200);
    expect(plan!.upstreamNames).toMatchObject({ openrouter: "OpenRouter", wavespeed: "WaveSpeed", sandbase: "SandBase", fal: "fal" });
  });

  it("answers 404 to an account that is not on the Project, Studio member or not", async () => {
    const admin = await signedIn();
    const studioOnly = await signedIn();
    const outsider = await signedIn();
    const { studioId, projectId } = await seedStudio(admin.userId, "team");
    await addMember(studioId, studioOnly.userId);

    expect((await keyPlan(studioOnly.cookie, projectId)).status).toBe(404);
    expect((await keyPlan(outsider.cookie, projectId)).status).toBe(404);
    expect((await keyPlan(outsider.cookie, crypto.randomUUID())).status).toBe(404);
    // The same route answers the Project's own members.
    expect((await keyPlan(admin.cookie, projectId)).status).toBe(200);
  });
});

describe("the BYOK reads behind key resolution and the key plan", () => {


  it("studioProviderKey answers the payer, the key row and its sealed text for the purpose, or null", async () => {
    const admin = await signedIn();
    const member = await signedIn();
    const { studioId } = await seedStudio(admin.userId, "team");
    await addMember(studioId, member.userId);
    const or = await saveKey(admin.userId, "openrouter", "sk-or-v1-admin-plan-key");
    const fal = await saveKey(admin.userId, "fal", "fal-admin-plan-key");
    await saveKey(member.userId, "wavespeed", "ws-member-plan-key");
    await accountModelUpstreamsRepo.setModelUpstream(admin.userId, MODEL, "fal");

    expect(await studioProviderKey(studioId, { kind: "llm" })).toMatchObject({
      payerUserId: admin.userId, keyId: or.id, upstream: "openrouter", ciphertext: or.ciphertext,
    });
    expect(await studioProviderKey(studioId, { kind: "media", model: MODEL })).toMatchObject({
      payerUserId: admin.userId, keyId: fal.id, upstream: "fal", ciphertext: fal.ciphertext,
    });
    expect(await studioProviderKey(studioId, { kind: "media", model: "ideogram-v3-quality" })).toBeNull();
  });

  it("providerKeyById answers a live row's sealed text, a retired row's upstream without it, and null for no row", async () => {
    const { userId } = await signedIn();
    const old = await saveKey(userId, "fal", "fal-first-plan-key");
    const replacing = await saveKey(userId, "fal", "fal-second-plan-key");

    expect(await providerKeyById(old.id)).toEqual({ id: old.id, userId, upstream: "fal", ciphertext: null });
    expect(await providerKeyById(replacing.id)).toMatchObject({ id: replacing.id, userId, upstream: "fal", ciphertext: replacing.ciphertext });

    await accountProviderKeysRepo.deleteKey(userId, "fal");
    expect(await providerKeyById(replacing.id)).toEqual({ id: replacing.id, userId, upstream: "fal", ciphertext: null });
    expect(await providerKeyById(crypto.randomUUID())).toBeNull();
  });

  it("studioKeyPlan answers upstream names and model choices without any sealed text", async () => {
    const { userId } = await signedIn();
    const { studioId } = await seedStudio(userId, "personal");
    const keys = { openrouter: "sk-or-v1-plan-global-key", fal: "fal-plan-global-key" };
    const saved = [];
    for (const [upstream, key] of Object.entries(keys)) saved.push({ key, ...(await saveKey(userId, upstream, key)) });
    await accountModelUpstreamsRepo.setModelUpstream(userId, MODEL, "fal");

    const answer = await studioKeyPlan(studioId);
    const text = JSON.stringify(answer);

    expect(text).toContain("openrouter");
    expect(text).toContain(MODEL);
    expectNoKeyTrace(text, saved);
    expect(text).not.toContain("v1:t1:");
  });
});
