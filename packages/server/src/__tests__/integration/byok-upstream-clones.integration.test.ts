// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-Breatic-Source-Available-2.0

/**
 * A Studio's cloned voices, vocals and elements are kept per key owner (inner#1953): a clone made with the
 * deployment's key lives on the deployment's upstream account, one made with an account's key lives on that account,
 * and neither can be reused by the other. `studio_upstream_clones.key_owner` is `deployment` or the account's id, never
 * null, so the live-uniqueness index covers both.
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

import postgres from "postgres";
import { initCore } from "@breatic/core";
import { upstreamCloneRepo } from "@breatic/domain";

try {
  initCore(process.env);
} catch {
  // already initialised by a sibling suite in this worker — fine.
}

let sql: ReturnType<typeof postgres>;

beforeAll(() => {
  sql = postgres(inject("DATABASE_URL"), { max: 4, prepare: false });
});

afterAll(async () => {
  await sql?.end({ timeout: 1 });
});

/**
 * A user and the studio they created.
 * @returns Both ids.
 */
async function seedStudio(): Promise<{ userId: string; studioId: string }> {
  const tag = crypto.randomUUID().slice(0, 8);
  const [user] = await sql<{ id: string }[]>`
    INSERT INTO users (email, email_verified) VALUES (${`clones-${tag}@test.local`}, true) RETURNING id
  `;
  const [studio] = await sql<{ id: string }[]>`
    INSERT INTO studios (created_by_user_id, slug, type, name)
    VALUES (${user!.id}, ${`clones-${tag}`}, 'personal', 'Clones') RETURNING id
  `;
  return { userId: user!.id, studioId: studio!.id };
}

describe("studio_upstream_clones.key_owner", () => {
  it("is a column that is never null", async () => {
    const [column] = await sql<{ is_nullable: string }[]>`
      SELECT is_nullable FROM information_schema.columns WHERE table_name = 'studio_upstream_clones' AND column_name = 'key_owner'
    `;
    expect(column?.is_nullable).toBe("NO");
  });

  it("keeps one live clone of a source per key owner: the deployment's and an account's side by side", async () => {
    const { userId, studioId } = await seedStudio();

    expect(await upstreamCloneRepo.recordClone(studioId, "fal", "voice", "sha-a", "dep-voice", "deployment")).toBe(true);
    expect(await upstreamCloneRepo.recordClone(studioId, "fal", "voice", "sha-a", "acct-voice", userId)).toBe(true);
    // A second clone for an owner that already has one keeps the first.
    expect(await upstreamCloneRepo.recordClone(studioId, "fal", "voice", "sha-a", "dep-again", "deployment")).toBe(false);
    expect(await upstreamCloneRepo.recordClone(studioId, "fal", "voice", "sha-a", "acct-again", userId)).toBe(false);

    const rows = await sql<{ upstream_id: string; key_owner: string }[]>`
      SELECT upstream_id, key_owner FROM studio_upstream_clones WHERE studio_id = ${studioId} AND deleted_at IS NULL ORDER BY upstream_id
    `;
    expect(rows.map((r) => [r.upstream_id, r.key_owner])).toEqual([["acct-voice", userId], ["dep-voice", "deployment"]]);
  });

  it("answers each key owner only its own clones", async () => {
    const { userId, studioId } = await seedStudio();
    await upstreamCloneRepo.recordClone(studioId, "fal", "voice", "sha-a", "dep-voice", "deployment");
    await upstreamCloneRepo.recordClone(studioId, "fal", "voice", "sha-a", "acct-voice", userId);

    expect((await upstreamCloneRepo.liveClonesFor(studioId, ["sha-a"], "deployment")).map((c) => c.upstreamId)).toEqual(["dep-voice"]);
    expect((await upstreamCloneRepo.liveClonesFor(studioId, ["sha-a"], userId)).map((c) => c.upstreamId)).toEqual(["acct-voice"]);
    expect(await upstreamCloneRepo.liveClonesFor(studioId, ["sha-a"], crypto.randomUUID())).toEqual([]);
  });

  it("refuses a second live row for the same source and owner in the table itself", async () => {
    const { studioId } = await seedStudio();
    await sql`
      INSERT INTO studio_upstream_clones (studio_id, upstream, kind, source_key, upstream_id, key_owner)
      VALUES (${studioId}, 'fal', 'voice', 'sha-a', 'first', 'deployment')
    `;
    await expect(sql`
      INSERT INTO studio_upstream_clones (studio_id, upstream, kind, source_key, upstream_id, key_owner)
      VALUES (${studioId}, 'fal', 'voice', 'sha-a', 'second', 'deployment')
    `).rejects.toMatchObject({ code: "23505" });
  });
});
