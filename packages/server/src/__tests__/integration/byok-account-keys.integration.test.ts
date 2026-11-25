// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-Breatic-Source-Available-2.0

/**
 * An account's own upstream keys and its per-model upstream choices (inner#1953), against the testcontainer
 * Postgres the migrations built.
 *
 * `account_provider_keys`: one live key per account and upstream, held in this table alone; replacing, deleting or
 * erasing a key clears its sealed text and soft-deletes its row at once, so a task still naming the row by id can no
 * longer read it. Erasing an account does so inside the erase's own transaction. No answer meant for the account ever
 * carries the sealed text.
 *
 * `account_model_upstreams`: one live choice per account and model; deleting a key drops the choices that named its
 * upstream.
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
import { accountModelUpstreamsRepo, accountProviderKeysRepo, db, eraseAccountAnalytics, initCore } from "@breatic/core";

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
 * A fresh account.
 * @returns Its id.
 */
async function seedUser(): Promise<string> {
  const [user] = await sql<{ id: string }[]>`
    INSERT INTO users (email, email_verified) VALUES (${`byok-${crypto.randomUUID().slice(0, 8)}@test.local`}, true) RETURNING id
  `;
  return user!.id;
}

/**
 * A sealed text that names its test, unique per call.
 * @param label - What it stands for.
 * @returns The text.
 */
const sealedText = (label: string): string => `v1:t1:${label}:${crypto.randomUUID().replaceAll("-", "")}:00`;

/**
 * Save a key for an account through the repository.
 * @param userId - The account.
 * @param upstream - The upstream.
 * @param ciphertext - Its sealed text.
 * @returns The saved row's id.
 */
async function save(userId: string, upstream: string, ciphertext = sealedText(upstream)): Promise<string> {
  const saved = await accountProviderKeysRepo.saveKey({ userId, upstream, ciphertext, displayHint: "sk-or-…a1B2" });
  return saved.id;
}

/**
 * Every row an account has for an upstream, deleted or not, straight from the table.
 * @param userId - The account.
 * @param upstream - The upstream.
 * @returns The rows, oldest first.
 */
async function rowsOf(userId: string, upstream: string): Promise<{ id: string; ciphertext: string | null; deleted_at: Date | null }[]> {
  return sql`
    SELECT id, ciphertext, deleted_at FROM account_provider_keys
    WHERE user_id = ${userId} AND upstream = ${upstream} ORDER BY created_at, id
  `;
}

describe("account_provider_keys", () => {
  it("saves a key and answers it without its sealed text", async () => {
    const userId = await seedUser();
    const ciphertext = sealedText("first");
    const saved = await accountProviderKeysRepo.saveKey({ userId, upstream: "openrouter", ciphertext, displayHint: "sk-or-…a1B2" });

    expect(saved).toMatchObject({ userId, upstream: "openrouter", displayHint: "sk-or-…a1B2" });
    expect(saved).not.toHaveProperty("ciphertext");
    expect(JSON.stringify(saved)).not.toContain(ciphertext);

    const live = await accountProviderKeysRepo.liveKeysFor(userId);
    expect(live.map((k) => [k.id, k.upstream])).toEqual([[saved.id, "openrouter"]]);
    for (const key of live) {
      expect(key).not.toHaveProperty("ciphertext");
      expect(JSON.stringify(key)).not.toContain(ciphertext);
    }
  });

  it("holds at most one live key per account and upstream, in the table itself", async () => {
    const userId = await seedUser();
    await save(userId, "fal");
    await expect(sql`
      INSERT INTO account_provider_keys (user_id, upstream, ciphertext, display_hint)
      VALUES (${userId}, 'fal', ${sealedText("second")}, 'x')
    `).rejects.toMatchObject({ code: "23505" });
    // A different upstream, and a different account on the same upstream, each have their own slot.
    await save(userId, "wavespeed");
    await save(await seedUser(), "fal");
    expect((await accountProviderKeysRepo.liveKeysFor(userId)).map((k) => k.upstream).sort()).toEqual(["fal", "wavespeed"]);
  });

  it("refuses a key for an account that does not exist, in the table itself", async () => {
    await expect(sql`
      INSERT INTO account_provider_keys (user_id, upstream, ciphertext, display_hint)
      VALUES (${crypto.randomUUID()}, 'fal', ${sealedText("orphan")}, 'x')
    `).rejects.toMatchObject({ code: "23503" });
  });

  it("refuses a key, a delete and a model choice for an account already deleted, writing nothing", async () => {
    const userId = await seedUser();
    await save(userId, "fal", sealedText("before"));
    await sql`UPDATE users SET deleted_at = now() WHERE id = ${userId}`;

    await expect(save(userId, "wavespeed", sealedText("after"))).rejects.toThrow();
    await expect(accountProviderKeysRepo.deleteKey(userId, "fal")).rejects.toThrow();
    await expect(accountModelUpstreamsRepo.setModelUpstream(userId, "seedream-5", "fal")).rejects.toThrow();
    expect((await rowsOf(userId, "wavespeed")).length).toBe(0);
  });

  it("replaces a key with a new row and clears the old row's sealed text at once", async () => {
    const userId = await seedUser();
    const oldId = await save(userId, "fal", sealedText("old"));
    const newText = sealedText("new");
    const newId = await save(userId, "fal", newText);

    expect(newId).not.toBe(oldId);
    const rows = await rowsOf(userId, "fal");
    expect(rows.map((r) => [r.id, r.ciphertext, r.deleted_at === null])).toEqual([
      [oldId, null, false],
      [newId, newText, true],
    ]);
    expect((await accountProviderKeysRepo.liveKeysFor(userId)).map((k) => k.id)).toEqual([newId]);
    // A task still holding the old row's id can no longer read a key from it.
    expect(await accountProviderKeysRepo.keyRowById(oldId)).toMatchObject({ id: oldId, userId, upstream: "fal", ciphertext: null });
    expect(await accountProviderKeysRepo.keyRowById(newId)).toMatchObject({ id: newId, userId, upstream: "fal", ciphertext: newText });
  });

  it("records a check on the row it checked, never on the row that replaced it meanwhile", async () => {
    const userId = await seedUser();
    const oldId = await save(userId, "fal", sealedText("old"));
    await accountProviderKeysRepo.saveKey({ userId, upstream: "fal", ciphertext: sealedText("new"), displayHint: "x", check: { connected: true, balanceState: null, balanceAmount: null, balanceCurrency: null, failure: null } });

    expect(await accountProviderKeysRepo.recordCheck(oldId, { connected: false, balanceState: null, balanceAmount: null, balanceCurrency: null, failure: "invalid" })).toBeNull();
    expect((await accountProviderKeysRepo.liveKeysFor(userId))[0]).toMatchObject({ lastConnected: true, lastFailure: null });
  });

  it("reads the live sealed key of an account and upstream, and nothing once it is deleted or the account is gone", async () => {
    const userId = await seedUser();
    const text = sealedText("live");
    const id = await save(userId, "fal", text);

    expect(await accountProviderKeysRepo.sealedLiveKeyFor(userId, "fal")).toEqual({ id, userId, upstream: "fal", ciphertext: text });
    expect(await accountProviderKeysRepo.sealedLiveKeyFor(userId, "wavespeed")).toBeNull();
    await sql`UPDATE users SET deleted_at = now() WHERE id = ${userId}`;
    expect(await accountProviderKeysRepo.sealedLiveKeyFor(userId, "fal")).toBeNull();
  });

  it("keeps the sealed text out of the error a failed save throws", async () => {
    // A live account, so the save gets past the account lock and its INSERT itself fails (a hint over 32 characters).
    const userId = await seedUser();
    const text = sealedText("leak");
    const thrown = await accountProviderKeysRepo.saveKey({ userId, upstream: "fal", ciphertext: text, displayHint: "x".repeat(33) }).then(() => null, (err: unknown) => err);

    expect(thrown).toBeInstanceOf(Error);
    const seen = JSON.stringify(thrown, Object.getOwnPropertyNames(thrown)) + String(thrown) + (thrown as Error).stack;
    expect(seen).not.toContain(text);
  });

  it("deletes a key by clearing its sealed text and soft-deleting the row", async () => {
    const userId = await seedUser();
    const id = await save(userId, "wavespeed", sealedText("gone"));

    expect(await accountProviderKeysRepo.deleteKey(userId, "wavespeed")).toBe(true);

    expect(await accountProviderKeysRepo.liveKeysFor(userId)).toEqual([]);
    const [row] = await rowsOf(userId, "wavespeed");
    expect(row!.deleted_at).not.toBeNull();
    expect(row!.ciphertext).toBeNull();
    expect((await accountProviderKeysRepo.keyRowById(id))?.ciphertext).toBeNull();
    // Nothing left to delete.
    expect(await accountProviderKeysRepo.deleteKey(userId, "wavespeed")).toBe(false);
  });

  it("keeps no sealed text on any retired row, however many times a key was replaced", async () => {
    const userId = await seedUser();
    const ids = [];
    for (let i = 0; i < 4; i++) ids.push(await save(userId, "fal"));
    const rows = await rowsOf(userId, "fal");
    expect(rows.filter((r) => r.ciphertext !== null).map((r) => r.id)).toEqual([ids[3]]);
  });

  it("is erased with the account: every sealed text cleared and every row soft-deleted, in the erase's transaction", async () => {
    const userId = await seedUser();
    const other = await seedUser();
    const otherText = sealedText("other");
    await save(userId, "fal");
    await save(userId, "fal");
    await save(userId, "openrouter");
    await save(other, "fal", otherText);
    await sql`UPDATE users SET deleted_at = now() WHERE id = ${userId}`;

    expect(await eraseAccountAnalytics([userId])).toEqual({ notDeleted: [] });

    const rows = await sql<{ ciphertext: string | null; deleted_at: Date | null }[]>`
      SELECT ciphertext, deleted_at FROM account_provider_keys WHERE user_id = ${userId}
    `;
    expect(rows).toHaveLength(3);
    for (const row of rows) {
      expect(row.ciphertext).toBeNull();
      expect(row.deleted_at).not.toBeNull();
    }
    expect(await accountProviderKeysRepo.liveKeysFor(userId)).toEqual([]);
    const [otherRow] = await rowsOf(other, "fal");
    expect(otherRow).toMatchObject({ ciphertext: otherText, deleted_at: null });
  });

  it("erases on the transaction it is handed, so a rolled-back erase clears nothing", async () => {
    const userId = await seedUser();
    const text = sealedText("kept");
    const id = await save(userId, "fal", text);

    await expect(db.transaction(async (tx) => {
      await accountProviderKeysRepo.eraseForAccounts([userId], tx);
      throw new Error("roll back");
    })).rejects.toThrow("roll back");

    expect(await accountProviderKeysRepo.keyRowById(id)).toMatchObject({ ciphertext: text });
    expect((await accountProviderKeysRepo.liveKeysFor(userId)).map((k) => k.id)).toEqual([id]);
  });
});

describe("account_model_upstreams", () => {
  it("sets, changes and clears the upstream an account chose for a model", async () => {
    const userId = await seedUser();
    await save(userId, "fal");
    await save(userId, "wavespeed");
    expect(await accountModelUpstreamsRepo.modelUpstreamFor(userId, "nano-banana-2")).toBeNull();

    await accountModelUpstreamsRepo.setModelUpstream(userId, "nano-banana-2", "fal");
    expect(await accountModelUpstreamsRepo.modelUpstreamFor(userId, "nano-banana-2")).toBe("fal");

    await accountModelUpstreamsRepo.setModelUpstream(userId, "nano-banana-2", "wavespeed");
    expect(await accountModelUpstreamsRepo.modelUpstreamFor(userId, "nano-banana-2")).toBe("wavespeed");
    const live = await sql`SELECT upstream FROM account_model_upstreams WHERE user_id = ${userId} AND deleted_at IS NULL`;
    expect(live.map((r) => r.upstream)).toEqual(["wavespeed"]);

    await accountModelUpstreamsRepo.setModelUpstream(userId, "nano-banana-2", null);
    expect(await accountModelUpstreamsRepo.modelUpstreamFor(userId, "nano-banana-2")).toBeNull();
    expect(await accountModelUpstreamsRepo.liveModelUpstreamsFor(userId)).toEqual([]);
  });

  it("writes nothing when the same choice is sent again", async () => {
    const userId = await seedUser();
    await save(userId, "fal", sealedText("same"));
    expect(await accountModelUpstreamsRepo.setModelUpstream(userId, "seedream-5", "fal")).toBe(true);
    expect(await accountModelUpstreamsRepo.setModelUpstream(userId, "seedream-5", "fal")).toBe(true);
    expect(await accountModelUpstreamsRepo.setModelUpstream(userId, "nano-banana-2", null)).toBe(true);

    const rows = await sql`SELECT model FROM account_model_upstreams WHERE user_id = ${userId}`;
    expect(rows.map((row) => row.model)).toEqual(["seedream-5"]);
  });

  it("keeps one choice per model and account apart from every other", async () => {
    const userId = await seedUser();
    const other = await seedUser();
    await save(userId, "fal");
    await save(userId, "wavespeed");
    await save(other, "sandbase");
    await accountModelUpstreamsRepo.setModelUpstream(userId, "nano-banana-2", "fal");
    await accountModelUpstreamsRepo.setModelUpstream(userId, "ideogram-v3-quality", "wavespeed");
    await accountModelUpstreamsRepo.setModelUpstream(other, "nano-banana-2", "sandbase");

    const mine = await accountModelUpstreamsRepo.liveModelUpstreamsFor(userId);
    expect(mine.map((c) => [c.model, c.upstream]).sort()).toEqual([["ideogram-v3-quality", "wavespeed"], ["nano-banana-2", "fal"]]);
    expect(await accountModelUpstreamsRepo.modelUpstreamFor(other, "nano-banana-2")).toBe("sandbase");
  });

  it("holds at most one live choice per account and model, in the table itself", async () => {
    const userId = await seedUser();
    await save(userId, "fal");
    await accountModelUpstreamsRepo.setModelUpstream(userId, "nano-banana-2", "fal");
    await expect(sql`
      INSERT INTO account_model_upstreams (user_id, model, upstream) VALUES (${userId}, 'nano-banana-2', 'wavespeed')
    `).rejects.toMatchObject({ code: "23505" });
  });

  it("refuses a choice naming an upstream the account holds no live key for, checked under the account's lock", async () => {
    const userId = await seedUser();
    await save(userId, "fal");
    await accountProviderKeysRepo.deleteKey(userId, "fal");

    expect(await accountModelUpstreamsRepo.setModelUpstream(userId, "nano-banana-2", "fal")).toBe(false);
    expect(await accountModelUpstreamsRepo.liveModelUpstreamsFor(userId)).toEqual([]);
    expect(await accountModelUpstreamsRepo.setModelUpstream(userId, "nano-banana-2", null)).toBe(true);
  });

  it("drops the choices naming an upstream when that upstream's key is deleted, and only those", async () => {
    const userId = await seedUser();
    await save(userId, "fal");
    await save(userId, "wavespeed");
    await accountModelUpstreamsRepo.setModelUpstream(userId, "nano-banana-2", "fal");
    await accountModelUpstreamsRepo.setModelUpstream(userId, "ideogram-v3-quality", "fal");
    await accountModelUpstreamsRepo.setModelUpstream(userId, "krea-v2-large-text-to-image", "wavespeed");

    await accountProviderKeysRepo.deleteKey(userId, "fal");

    const live = await accountModelUpstreamsRepo.liveModelUpstreamsFor(userId);
    expect(live.map((c) => [c.model, c.upstream])).toEqual([["krea-v2-large-text-to-image", "wavespeed"]]);
    const dropped = await sql`
      SELECT deleted_at FROM account_model_upstreams WHERE user_id = ${userId} AND upstream = 'fal'
    `;
    expect(dropped).toHaveLength(2);
    for (const row of dropped) expect(row.deleted_at).not.toBeNull();
  });

  it("is erased with the account: every choice soft-deleted, another account's kept", async () => {
    const userId = await seedUser();
    const other = await seedUser();
    await save(userId, "fal");
    await save(other, "fal");
    await accountModelUpstreamsRepo.setModelUpstream(userId, "nano-banana-2", "fal");
    await accountModelUpstreamsRepo.setModelUpstream(other, "nano-banana-2", "fal");
    await sql`UPDATE users SET deleted_at = now() WHERE id = ${userId}`;

    expect(await eraseAccountAnalytics([userId])).toEqual({ notDeleted: [] });

    expect(await accountModelUpstreamsRepo.liveModelUpstreamsFor(userId)).toEqual([]);
    const rows = await sql`SELECT deleted_at FROM account_model_upstreams WHERE user_id = ${userId}`;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.deleted_at).not.toBeNull();
    expect((await accountModelUpstreamsRepo.liveModelUpstreamsFor(other)).map((c) => c.upstream)).toEqual(["fal"]);
  });
});
