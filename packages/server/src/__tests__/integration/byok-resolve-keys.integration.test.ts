// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Which keys a call runs on (inner#1953), against the testcontainer Postgres.
 *
 * Whoever pays for a Studio supplies the keys: a personal Studio's own account, a team Studio's current admin (who
 * changes with a transfer). A language-model call runs on that account's OpenRouter key when it has one; a media call
 * runs on the upstream the account chose for that model, while that upstream's key is live; anything else runs on the
 * deployment's keys. A soft-deleted account's keys are never used. The answer names key rows by id and never holds a
 * key in its serialisable part.
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

import { randomBytes } from "node:crypto";
import fc from "fast-check";
import postgres from "postgres";
import { accountModelUpstreamsRepo, accountProviderKeysRepo, initCore, sealProviderKey } from "@breatic/core";
import { resolveKeys } from "@breatic/domain";
import { mirrorInDirectory } from "./directory-fixtures.js";

const SECRET = randomBytes(32);
const RING = { current: "t1", keys: { t1: SECRET } };

initCore({
  ...process.env,
  PROVIDER_KEY_SECRET_ID: "t1",
  PROVIDER_KEY_SECRETS: JSON.stringify({ t1: SECRET.toString("hex") }),
});

/** A media model bound on WaveSpeed and fal in `config/provider/media/image.yaml`. */
const MODEL = "gpt-image-2.5-sunburst-text-to-image";
const LLM = { kind: "llm" } as const;
const MEDIA = { kind: "media", model: MODEL } as const;

let sql: ReturnType<typeof postgres>;

beforeAll(() => {
  sql = postgres(inject("DATABASE_URL"), { max: 4, prepare: false });
});

afterAll(async () => {
  await sql?.end({ timeout: 1 });
});

/**
 * A fresh account.
 * @returns Its id.
 */
async function seedUser(): Promise<string> {
  const [user] = await sql<{ id: string }[]>`
    INSERT INTO users (email, email_verified) VALUES (${`resolve-${crypto.randomUUID().slice(0, 8)}@test.local`}, true) RETURNING id
  `;
  return user!.id;
}

/**
 * A Studio administered by an account, with its directory rows and a project.
 * @param adminUserId - Its admin.
 * @param type - Personal or team.
 * @returns The Studio's and the project's ids.
 */
async function seedStudio(adminUserId: string, type: "personal" | "team"): Promise<{ studioId: string; projectId: string }> {
  const tag = crypto.randomUUID().slice(0, 8);
  const [studio] = await sql<{ id: string }[]>`
    INSERT INTO studios (created_by_user_id, slug, type, name) VALUES (${adminUserId}, ${`resolve-${tag}`}, ${type}, 'Resolve') RETURNING id
  `;
  await sql`INSERT INTO studio_members (studio_id, user_id, role) VALUES (${studio!.id}, ${adminUserId}, 'admin')`;
  await mirrorInDirectory(sql, studio!.id);
  const [project] = await sql<{ id: string }[]>`
    INSERT INTO projects (studio_id, created_by_user_id, slug, name) VALUES (${studio!.id}, ${adminUserId}, ${`resolve-p-${tag}`}, 'P') RETURNING id
  `;
  return { studioId: studio!.id, projectId: project!.id };
}

/**
 * Add a member to a team Studio, in the region and in the directory.
 * @param studioId - The Studio.
 * @param userId - The member.
 * @returns Once added.
 */
async function addMember(studioId: string, userId: string): Promise<void> {
  await sql`INSERT INTO studio_members (studio_id, user_id, role) VALUES (${studioId}, ${userId}, 'maintainer')`;
  await sql`INSERT INTO studio_directory_members (studio_id, user_id, role) VALUES (${studioId}, ${userId}, 'maintainer')`;
}

/**
 * The state an accepted transfer leaves: the new admin in the region and in the directory, the old one a maintainer.
 * @param studioId - The Studio.
 * @param from - The admin until now.
 * @param to - The new admin.
 * @returns Once moved.
 */
async function transferAdmin(studioId: string, from: string, to: string): Promise<void> {
  await sql.begin(async (tx) => {
    await tx`UPDATE studio_members SET role = 'maintainer' WHERE studio_id = ${studioId} AND user_id = ${from}`;
    await tx`UPDATE studio_members SET role = 'admin' WHERE studio_id = ${studioId} AND user_id = ${to}`;
    await tx`UPDATE studio_directory_members SET role = 'maintainer' WHERE studio_id = ${studioId} AND user_id = ${from}`;
    await tx`UPDATE studio_directory_members SET role = 'admin' WHERE studio_id = ${studioId} AND user_id = ${to}`;
    await tx`UPDATE studio_directory SET admin_user_id = ${to} WHERE studio_id = ${studioId}`;
  });
}

/**
 * Save an account's key the way the settings route will: sealed with this deployment's ring.
 * @param userId - The account.
 * @param upstream - The upstream.
 * @param key - The key itself.
 * @returns The key row's id.
 */
async function saveKey(userId: string, upstream: string, key: string): Promise<string> {
  const saved = await accountProviderKeysRepo.saveKey({ userId, upstream, ciphertext: sealProviderKey(key, RING), displayHint: "hint" });
  return saved.id;
}

/** A key: printable ASCII, long and distinct enough never to occur in an answer by chance. */
const keyArb: fc.Arbitrary<string> = fc
  .array(fc.integer({ min: 0x21, max: 0x7e }), { minLength: 20, maxLength: 60 })
  .map((codes) => `k~${String.fromCharCode(...codes)}`);

describe("resolveKeys: whose keys", () => {
  it("runs a personal Studio on its own account's key", async () => {
    const userId = await seedUser();
    const { studioId, projectId } = await seedStudio(userId, "personal");
    const keyId = await saveKey(userId, "openrouter", "sk-or-v1-personal-key");

    for (const payer of [{ studioId }, { projectId }]) {
      const resolved = await resolveKeys(payer, LLM);
      expect(resolved.keys.owner).toBe("account");
      expect(resolved.keyId).toBe(keyId);
      expect(resolved.keys.keyOf("openrouter")).toBe("sk-or-v1-personal-key");
    }
  });

  it("runs a team Studio on its current admin's key, not the member's who started the call", async () => {
    const admin = await seedUser();
    const member = await seedUser();
    const { studioId } = await seedStudio(admin, "team");
    await addMember(studioId, member);
    const adminKey = await saveKey(admin, "openrouter", "sk-or-v1-admin-key");
    await saveKey(member, "openrouter", "sk-or-v1-member-key");

    const resolved = await resolveKeys({ studioId }, LLM);
    expect(resolved.keyId).toBe(adminKey);
    expect(resolved.keys.keyOf("openrouter")).toBe("sk-or-v1-admin-key");
  });

  it("follows a transfer to the new admin's keys, and to the deployment's when the new admin has none", async () => {
    const first = await seedUser();
    const second = await seedUser();
    const third = await seedUser();
    const { studioId } = await seedStudio(first, "team");
    await addMember(studioId, second);
    await addMember(studioId, third);
    await saveKey(first, "openrouter", "sk-or-v1-first");
    const secondKey = await saveKey(second, "openrouter", "sk-or-v1-second");

    await transferAdmin(studioId, first, second);
    const afterFirst = await resolveKeys({ studioId }, LLM);
    expect(afterFirst.keyId).toBe(secondKey);
    expect(afterFirst.keys.keyOf("openrouter")).toBe("sk-or-v1-second");

    await transferAdmin(studioId, second, third);
    const afterSecond = await resolveKeys({ studioId }, LLM);
    expect(afterSecond.keys.owner).toBe("deployment");
    expect(afterSecond.keyId).toBeNull();
  });

  it("never uses a soft-deleted account's keys", async () => {
    const userId = await seedUser();
    const { studioId } = await seedStudio(userId, "personal");
    await saveKey(userId, "openrouter", "sk-or-v1-departed");
    await saveKey(userId, "fal", "fal-departed");
    await accountModelUpstreamsRepo.setModelUpstream(userId, MODEL, "fal");
    await sql`UPDATE users SET deleted_at = now() WHERE id = ${userId}`;

    for (const purpose of [LLM, MEDIA]) {
      const resolved = await resolveKeys({ studioId }, purpose);
      expect(resolved.keys.owner).toBe("deployment");
      expect(resolved.keyId).toBeNull();
    }
  });
});

describe("resolveKeys: language-model calls", () => {
  it("runs on the account's OpenRouter key alone, never on another upstream's", async () => {
    const userId = await seedUser();
    const { studioId } = await seedStudio(userId, "personal");
    await saveKey(userId, "fal", "fal-key");
    const keyId = await saveKey(userId, "openrouter", "sk-or-v1-only");

    const resolved = await resolveKeys({ studioId }, LLM);
    expect(resolved.keyId).toBe(keyId);
    expect(resolved.keys.keyOf("openrouter")).toBe("sk-or-v1-only");
    expect(resolved.keys.keyOf("fal")).toBeUndefined();
  });

  it("runs on the deployment's keys when the account has no OpenRouter key", async () => {
    const userId = await seedUser();
    const { studioId } = await seedStudio(userId, "personal");
    await saveKey(userId, "fal", "fal-key");

    const resolved = await resolveKeys({ studioId }, LLM);
    expect(resolved.keys.owner).toBe("deployment");
    expect(resolved.keyId).toBeNull();
  });
});

describe("resolveKeys: media calls", () => {
  it("runs a model the account pointed at an upstream on that upstream's key and that upstream alone", async () => {
    const userId = await seedUser();
    const { projectId } = await seedStudio(userId, "personal");
    await saveKey(userId, "wavespeed", "ws-key");
    const falKey = await saveKey(userId, "fal", "fal-key");
    await saveKey(userId, "openrouter", "sk-or-v1-x");
    await accountModelUpstreamsRepo.setModelUpstream(userId, MODEL, "fal");

    const resolved = await resolveKeys({ projectId }, MEDIA);
    expect(resolved.keys.owner).toBe("account");
    expect(resolved.keyId).toBe(falKey);
    expect(resolved.route).toEqual({ mode: "upstream", upstream: "fal" });
    expect(resolved.keys.keyOf("fal")).toBe("fal-key");
    expect(resolved.keys.keyOf("wavespeed")).toBeUndefined();
    expect(resolved.keys.keyOf("openrouter")).toBeUndefined();
  });

  it("runs a model the account did not point anywhere on the deployment's keys, though it holds a key that could run it", async () => {
    const userId = await seedUser();
    const { studioId } = await seedStudio(userId, "personal");
    await saveKey(userId, "fal", "fal-key");

    const resolved = await resolveKeys({ studioId }, MEDIA);
    expect(resolved.keys.owner).toBe("deployment");
    expect(resolved.keyId).toBeNull();
    expect(resolved.route).toEqual({ mode: "default" });
  });

  it("runs new calls on the deployment's keys once the chosen upstream's key is gone", async () => {
    const userId = await seedUser();
    const { studioId } = await seedStudio(userId, "personal");
    await saveKey(userId, "fal", "fal-key");
    await accountModelUpstreamsRepo.setModelUpstream(userId, MODEL, "fal");
    // Only the key row is retired, so the choice still names fal: the key's own state decides.
    await sql`UPDATE account_provider_keys SET ciphertext = NULL, deleted_at = now() WHERE user_id = ${userId} AND upstream = 'fal'`;

    const resolved = await resolveKeys({ studioId }, MEDIA);
    expect(resolved.keys.owner).toBe("deployment");
    expect(resolved.keyId).toBeNull();
    expect(resolved.route).toEqual({ mode: "default" });
  });

  it("runs on the replacing key, by the new row's id, after a key is replaced", async () => {
    const userId = await seedUser();
    const { studioId } = await seedStudio(userId, "personal");
    await saveKey(userId, "fal", "fal-old");
    const newId = await saveKey(userId, "fal", "fal-new");
    await accountModelUpstreamsRepo.setModelUpstream(userId, MODEL, "fal");

    const resolved = await resolveKeys({ studioId }, MEDIA);
    expect(resolved.keyId).toBe(newId);
    expect(resolved.keys.keyOf("fal")).toBe("fal-new");
  });
});

describe("resolveKeys: what the answer carries", () => {
  it("names the key row and never holds the key in its serialisable part", async () => {
    await fc.assert(
      fc.asyncProperty(keyArb, fc.constantFrom<"llm" | "media">("llm", "media"), async (key, kind) => {
        const userId = await seedUser();
        const { studioId } = await seedStudio(userId, "personal");
        const upstream = kind === "llm" ? "openrouter" : "fal";
        const keyId = await saveKey(userId, upstream, key);
        if (kind === "media") await accountModelUpstreamsRepo.setModelUpstream(userId, MODEL, "fal");

        const resolved = await resolveKeys({ studioId }, kind === "llm" ? LLM : MEDIA);
        expect(resolved.keyId).toBe(keyId);
        expect(resolved.keys.keyOf(upstream)).toBe(key);
        expect(JSON.stringify(resolved)).not.toContain(key);
        expect(JSON.stringify(resolved)).not.toContain(key.slice(2));
      }),
      { numRuns: 12 },
    );
  });
});
