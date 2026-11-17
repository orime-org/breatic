// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Reading back the key a task, a turn or a lookup recorded (inner#1953), against the testcontainer Postgres.
 *
 * What runs later (a worker pickup, a resumed segment, a cost lookup) holds only the key row's id and reads the key by
 * it: no id is the deployment's keys; a live row is the account's key for that row's upstream alone, with the account
 * that owns it; a row that was replaced or deleted has had its sealed text cleared, and reading it fails as
 * `account_key_missing` rather than falling back to any other key. The answer's serialisable part never holds the key.
 *
 * Also: a paused Agent segment records the key row its turn ran on, and the resume reads it back.
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
import { accountProviderKeysRepo, initCore, sealProviderKey } from "@breatic/core";
import { accountKeyFailureIn, keysById } from "@breatic/domain";

const SECRET = randomBytes(32);
const RING = { current: "t1", keys: { t1: SECRET } };

initCore({
  ...process.env,
  PROVIDER_KEY_SECRET_ID: "t1",
  PROVIDER_KEY_SECRETS: JSON.stringify({ t1: SECRET.toString("hex") }),
});

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
    INSERT INTO users (email, email_verified) VALUES (${`by-id-${crypto.randomUUID().slice(0, 8)}@test.local`}, true) RETURNING id
  `;
  return user!.id;
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

/**
 * What a read threw.
 * @param read - The read.
 * @returns The error, or undefined when it answered.
 */
async function thrownBy(read: Promise<unknown>): Promise<unknown> {
  return read.then(() => undefined, (err: unknown) => err);
}

/**
 * The key failure kind on an error or its cause chain.
 * @param err - The error.
 * @returns The kind, or undefined.
 */
function kindOf(err: unknown): unknown {
  for (let current = err; typeof current === "object" && current !== null; current = (current as { cause?: unknown }).cause) {
    const kind = (current as { kind?: unknown }).kind;
    if (kind !== undefined) return kind;
  }
  return undefined;
}

describe("keysById", () => {
  it("answers nothing for no key row: the call runs on the deployment's keys", async () => {
    expect(await keysById(null)).toBeNull();
  });

  it("answers a live row as its account's key for that row's upstream alone, with the account", async () => {
    const userId = await seedUser();
    const keyId = await saveKey(userId, "fal", "fal-live-key");
    await saveKey(userId, "openrouter", "sk-or-v1-other");

    const read = await keysById(keyId);
    expect(read?.accountId).toBe(userId);
    expect(read?.keys.owner).toBe("account");
    expect(read?.keys.keyOf("fal")).toBe("fal-live-key");
    expect(read?.keys.keyOf("openrouter")).toBeUndefined();
    expect(read?.keys.keyOf("wavespeed")).toBeUndefined();
  });

  it("fails as account_key_missing for a row that was replaced, never answering the replacing key", async () => {
    const userId = await seedUser();
    const oldId = await saveKey(userId, "fal", "fal-old");
    await saveKey(userId, "fal", "fal-new");

    const err = await thrownBy(keysById(oldId));
    expect(kindOf(err)).toBe("account_key_missing");
    expect(accountKeyFailureIn(err)?.upstream).toBe("fal");
    expect(String(err)).not.toContain("fal-new");
  });

  it("fails as account_key_missing for a row that was deleted", async () => {
    const userId = await seedUser();
    const keyId = await saveKey(userId, "openrouter", "sk-or-v1-deleted");
    await accountProviderKeysRepo.deleteKey(userId, "openrouter");

    const err = await thrownBy(keysById(keyId));
    expect(kindOf(err)).toBe("account_key_missing");
    expect(accountKeyFailureIn(err)?.upstream).toBe("openrouter");
  });

  it("fails as account_key_missing naming no upstream for an id no row has", async () => {
    const err = await thrownBy(keysById(crypto.randomUUID()));
    expect(kindOf(err)).toBe("account_key_missing");
    expect(accountKeyFailureIn(err)?.upstream).toBeUndefined();
  });

  it("property: never holds the key in its serialisable part", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(fc.integer({ min: 0x21, max: 0x7e }), { minLength: 20, maxLength: 60 }).map((codes) => `k~${String.fromCharCode(...codes)}`),
        async (key) => {
          const keyId = await saveKey(await seedUser(), "openrouter", key);
          const read = await keysById(keyId);
          expect(read?.keys.keyOf("openrouter")).toBe(key);
          expect(JSON.stringify(read)).not.toContain(key.slice(2));
        },
      ),
      { numRuns: 10 },
    );
  });
});

describe("a paused Agent segment's key row", () => {
  it("is read back for the resume beside the upstream that served it", async () => {
    const userId = await seedUser();
    const [conversation] = await sql<{ id: string }[]>`INSERT INTO conversations (user_id) VALUES (${userId}) RETURNING id`;
    const messageRepo = await import("@server/modules/conversation/conversation-message.repo.js");
    const toolCallId = `call-${crypto.randomUUID()}`;
    await messageRepo.addMessage(
      conversation!.id,
      { role: "assistant", parts: [{ type: "tool", toolCallId, toolName: "ask_user", input: { questions: [] }, status: "awaiting" }], turnIndex: 1 } as never,
      { messages: [], prefixHash: "h", turnTokens: 0, endTokens: 0, modelId: "deepseek/deepseek-v4.1-flash-1017", servedUpstream: "openrouter", keyId: "key-row-1" },
    );

    expect(await messageRepo.getReplyRun(conversation!.id, toolCallId)).toEqual({
      modelId: "deepseek/deepseek-v4.1-flash-1017",
      servedUpstream: "openrouter",
      keyId: "key-row-1",
    });
  });
});
