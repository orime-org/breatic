// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * An account's own upstream keys and its per-model upstream choices (inner#1953), against the testcontainer
 * Postgres the migrations built.
 *
 * `account_provider_keys`: one live key per account and upstream; a replaced or deleted key is soft-deleted with its
 * sealed text kept, so the tasks, turns and look-ups already using it still read it by row id, until a cleanup clears
 * the sealed text of rows nothing unfinished points at. Erasing an account clears its sealed text at once, inside the
 * erase's own transaction. No answer meant for the account ever carries the sealed text.
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
import { accountModelUpstreamsRepo, accountProviderKeysRepo, eraseAccountAnalytics, initCore, rawPg } from "@breatic/core";

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

  it("replaces a key with a new row, keeping the old row's sealed text readable by its id", async () => {
    const userId = await seedUser();
    const oldText = sealedText("old");
    const oldId = await save(userId, "fal", oldText);
    const newText = sealedText("new");
    const newId = await save(userId, "fal", newText);

    expect(newId).not.toBe(oldId);
    const rows = await rowsOf(userId, "fal");
    expect(rows.map((r) => [r.id, r.ciphertext, r.deleted_at === null])).toEqual([
      [oldId, oldText, false],
      [newId, newText, true],
    ]);
    expect((await accountProviderKeysRepo.liveKeysFor(userId)).map((k) => k.id)).toEqual([newId]);
    expect(await accountProviderKeysRepo.sealedKeyById(oldId)).toMatchObject({ id: oldId, userId, upstream: "fal", ciphertext: oldText });
    expect(await accountProviderKeysRepo.sealedKeyById(newId)).toMatchObject({ id: newId, ciphertext: newText });
  });

  it("deletes a key by soft-deleting it: no longer live, sealed text still readable by id", async () => {
    const userId = await seedUser();
    const text = sealedText("gone");
    const id = await save(userId, "wavespeed", text);

    expect(await accountProviderKeysRepo.deleteKey(userId, "wavespeed")).toBe(true);

    expect(await accountProviderKeysRepo.liveKeysFor(userId)).toEqual([]);
    const [row] = await rowsOf(userId, "wavespeed");
    expect(row!.deleted_at).not.toBeNull();
    expect(row!.ciphertext).toBe(text);
    expect(await accountProviderKeysRepo.sealedKeyById(id)).toMatchObject({ ciphertext: text });
    // Nothing left to delete.
    expect(await accountProviderKeysRepo.deleteKey(userId, "wavespeed")).toBe(false);
  });

  it("clears the sealed text of retired keys nothing unfinished points at, and of no other row", async () => {
    const userId = await seedUser();
    const stillUsedText = sealedText("still-used");
    const stillUsed = await save(userId, "fal", stillUsedText);
    const unused = await save(userId, "fal");           // replaces stillUsed
    await accountProviderKeysRepo.deleteKey(userId, "fal");  // retires unused
    const liveText = sealedText("live");
    const live = await save(userId, "wavespeed", liveText);

    await accountProviderKeysRepo.clearUnreferencedCiphertext([stillUsed]);

    expect((await accountProviderKeysRepo.sealedKeyById(stillUsed))?.ciphertext).toBe(stillUsedText);
    expect((await accountProviderKeysRepo.sealedKeyById(unused))?.ciphertext).toBeNull();
    // A live key is never cleared, referenced or not.
    expect((await accountProviderKeysRepo.sealedKeyById(live))?.ciphertext).toBe(liveText);

    // Once the last reference ends, the next cleanup clears it too.
    await accountProviderKeysRepo.clearUnreferencedCiphertext([]);
    expect((await accountProviderKeysRepo.sealedKeyById(stillUsed))?.ciphertext).toBeNull();
    expect((await accountProviderKeysRepo.sealedKeyById(live))?.ciphertext).toBe(liveText);
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

    await expect(rawPg.begin(async (tx) => {
      await accountProviderKeysRepo.eraseForAccounts([userId], tx);
      throw new Error("roll back");
    })).rejects.toThrow("roll back");

    expect(await accountProviderKeysRepo.sealedKeyById(id)).toMatchObject({ ciphertext: text });
    expect((await accountProviderKeysRepo.liveKeysFor(userId)).map((k) => k.id)).toEqual([id]);
  });
});

describe("account_model_upstreams", () => {
  it("sets, changes and clears the upstream an account chose for a model", async () => {
    const userId = await seedUser();
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

  it("keeps one choice per model and account apart from every other", async () => {
    const userId = await seedUser();
    const other = await seedUser();
    await accountModelUpstreamsRepo.setModelUpstream(userId, "nano-banana-2", "fal");
    await accountModelUpstreamsRepo.setModelUpstream(userId, "ideogram-v3-quality", "wavespeed");
    await accountModelUpstreamsRepo.setModelUpstream(other, "nano-banana-2", "sandbase");

    const mine = await accountModelUpstreamsRepo.liveModelUpstreamsFor(userId);
    expect(mine.map((c) => [c.model, c.upstream]).sort()).toEqual([["ideogram-v3-quality", "wavespeed"], ["nano-banana-2", "fal"]]);
    expect(await accountModelUpstreamsRepo.modelUpstreamFor(other, "nano-banana-2")).toBe("sandbase");
  });

  it("holds at most one live choice per account and model, in the table itself", async () => {
    const userId = await seedUser();
    await accountModelUpstreamsRepo.setModelUpstream(userId, "nano-banana-2", "fal");
    await expect(sql`
      INSERT INTO account_model_upstreams (user_id, model, upstream) VALUES (${userId}, 'nano-banana-2', 'wavespeed')
    `).rejects.toMatchObject({ code: "23505" });
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
});
