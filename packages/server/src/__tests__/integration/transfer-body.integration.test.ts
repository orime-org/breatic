// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The transfer-reference entrance (inner#1006 design §4.6, test spec §4,
 * §6.1 S-cells and §6.2 R-cells).
 *
 * `/canvas/paste`, `/canvas/node-history/snapshot` and `/chat/message` take a
 * second body shape, `{ "transfer": "<storageKey>" }`. The server checks the
 * grant is the caller's own, finished and fresh, reads the stored transfer
 * file back under a per-route cap, claims it once, and hands the original body
 * to the route's own `validate`.
 *
 * Storage is the stubbed `read` of the shared adapter (the suite's R2 endpoint
 * is not reachable); Postgres and Redis are real.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, inject, vi } from "vitest";

vi.mock("ai", () => ({
  generateText: async () => ({ text: "", steps: [], usage: { totalTokens: 0 } }),
  streamText: () => ({
    fullStream: (async function* () {})(),
    text: Promise.resolve(""),
    usage: Promise.resolve({ totalTokens: 0 }),
    totalUsage: Promise.resolve({ totalTokens: 0 }),
  }),
  stepCountIs: (_n: number) => () => false,
  tool: (config: Record<string, unknown>) => config,
}));

/** Core's logger answers through a proxy a spy cannot see into, so the app gets this one. */
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
import type { Hono } from "hono";
import { initCore, loadLocales, getRedis, ObjectMissing, ObjectTooLarge } from "@breatic/core";
import { formatBytes, t, REQUEST_SHAPE_REASON } from "@breatic/shared";
import {
  PNG,
  allRefKeys,
  bytes,
  completedAgo,
  enc,
  grantRow,
  historyCount,
  installReadStub,
  lockKey,
  logLines,
  post,
  ref,
  refKey,
  seedConversation,
  seedProject,
  sig,
  transferConfig,
  transferGrant,
  transferKey,
  type ReadStub,
  type Seeded,
} from "./transfer-fixtures.js";

try {
  initCore(process.env);
} catch {
  // already initialised by a sibling suite in this worker — fine.
}
loadLocales();

const SNAPSHOT = "/canvas/node-history/snapshot";
const PASTE = "/canvas/paste";
const CHAT = "/chat/message";

/** `t0`: `<svg`, `&`, a C0 control, a quote, a backslash, a newline and CJK, then 1.2 MB. */
const T0 = "<svg onload=1>&\u0001\"\\\n中文" + "x".repeat(1_200_000);

let sql: ReturnType<typeof postgres>;
let app: Hono;
let read: ReadStub;

beforeAll(async () => {
  sql = postgres(inject("DATABASE_URL"), {
    max: 4,
    prepare: false,
    connection: { application_name: "transfer-body-test-driver" },
  });
  const { createApp } = await import("@server/app.js");
  app = createApp();
  read = await installReadStub();
});

afterAll(async () => {
  await sql?.end({ timeout: 1 });
});

beforeEach(() => {
  read.calls.length = 0;
  for (const fn of Object.values(logged)) if (typeof fn === "function" && "mockClear" in fn) fn.mockClear();
});

/** A project, its node and A's completed transfer of `SNAP(t0)`. */
interface World extends Seeded {
  node: string;
  /** `JSON.stringify(SNAP(t0))`'s transfer file. */
  file: Uint8Array;
  /** `K_A`. */
  key: string;
}

/**
 * `SNAP(t)`.
 * @param w - The project and node.
 * @param w.projectId - P.
 * @param w.node - N.
 * @param text - The node's words.
 * @returns The snapshot body.
 */
function snap(w: { projectId: string; node: string }, text: string): { project_id: string; node_id: string; text: string } {
  return { project_id: w.projectId, node_id: w.node, text };
}

/**
 * A fresh project and node, with `K_A` named but not yet issued.
 * @returns The project, the node and the key K_A will be issued under.
 */
async function bareWorld(): Promise<Seeded & { node: string; key: string }> {
  const seeded = await seedProject(sql);
  return { ...seeded, node: crypto.randomUUID(), key: transferKey() };
}

/**
 * Issue `K_A` as A's completed transfer of `ENC(SNAP(t0))`, and program the read stub with it.
 * @param w - The bare world.
 * @returns The world with its transfer file.
 */
async function issueKA(w: Seeded & { node: string; key: string }): Promise<World> {
  const file = enc(snap({ projectId: w.projectId, node: w.node }, T0));
  await transferGrant({ userId: w.a.id, studioId: w.studioId, projectId: w.projectId, declaredSize: file.length }, "completed", w.key);
  read.answer = async () => file;
  return { ...w, file };
}

/**
 * A fresh project with A's completed `K_A` holding `ENC(SNAP(t0))`.
 * @returns The world.
 */
async function world(): Promise<World> {
  return issueKA(await bareWorld());
}

/**
 * A's transfer grant in this project.
 * @param w - The project.
 * @param declaredSize - The ticket's size.
 * @param state - Where to leave it.
 * @param owner - Whose it is; A by default.
 * @returns Its key.
 */
async function grant(
  w: Seeded,
  declaredSize: number,
  state: "open" | "finishing" | "completed" | "voided" = "completed",
  owner: string = w.a.id,
): Promise<string> {
  return transferGrant({ userId: owner, studioId: w.studioId, projectId: w.projectId, declaredSize }, state);
}

/**
 * The 400 every refused reference gets.
 * @returns Its body.
 */
function invalid(): unknown {
  return { error: { code: 400, message: t("server.error.transfer_invalid") } };
}

/**
 * The reasons logged for refused references since the test began.
 * @returns Each `transfer_rejected` reason, in order per level.
 */
function reasons(): unknown[] {
  return logLines(logged, "transfer_rejected").map((l) => l.fields.reason);
}

/**
 * Assert `REF(key)` holds the claim: value `"1"`, TTL in `(TTL-10, TTL]`.
 * @param key - The transfer's key.
 * @returns Once checked.
 */
async function expectClaimed(key: string): Promise<void> {
  const ttl = transferConfig().reference_ttl_seconds;
  expect(await getRedis().get(refKey(key))).toBe("1");
  const left = await getRedis().ttl(refKey(key));
  expect(left).toBeGreaterThan(ttl - 10);
  expect(left).toBeLessThanOrEqual(ttl);
}

/**
 * Assert nothing claimed `key` and A holds no read lock.
 * @param key - The transfer's key.
 * @param userId - Whose lock.
 * @returns Once checked.
 */
async function expectUnclaimedAndUnlocked(key: string, userId: string): Promise<void> {
  expect(await getRedis().get(refKey(key))).toBeNull();
  expect(await getRedis().get(lockKey(userId))).toBeNull();
}

/**
 * The `node_history` rows of a node.
 * @param projectId - The project.
 * @param nodeId - The node.
 * @returns Their contents.
 */
async function contents(projectId: string, nodeId: string): Promise<string[]> {
  const rows = await sql<{ content: string }[]>`
    SELECT content FROM node_history WHERE project_id = ${projectId} AND node_id = ${nodeId} ORDER BY created_at
  `;
  return rows.map((r) => r.content);
}

/** The snapshot route's transfer cap. */
function capSnap(): number {
  return transferConfig().route_max_bytes.node_history_snapshot;
}

describe("§4.1 the main path", () => {
  it("T50 / R10: an ordinary body passes through untouched and never reaches storage or Redis", async () => {
    const w = await bareWorld();
    const before = await allRefKeys();

    const res = await post(app, SNAPSHOT, w.a.cookie, JSON.stringify(snap(w, "hello")));

    expect(res.status).toBe(201);
    expect(read.calls).toEqual([]);
    expect(await allRefKeys()).toEqual(before);
    expect(await getRedis().get(lockKey(w.a.id))).toBeNull();
  });

  it("T51 / R10: other shapes pass through to validate and leave K_A usable once", async () => {
    const w = await world();
    const before = await allRefKeys();
    const shapeRefusal = { error: { code: 422, message: t("server.error.validation"), reason: REQUEST_SHAPE_REASON } };

    const a = await post(app, SNAPSHOT, w.a.cookie, JSON.stringify({ transfer: 123 }));
    expect(a.status).toBe(422);
    expect(await a.json()).toEqual(shapeRefusal);

    const b = await post(app, SNAPSHOT, w.a.cookie, JSON.stringify({ transfer: w.key, project_id: w.projectId }));
    expect(b.status).toBe(422);
    expect(await b.json()).toEqual(shapeRefusal);

    const c = await post(app, SNAPSHOT, w.a.cookie, JSON.stringify([{ transfer: w.key }]));
    expect(c.status).toBe(422);
    expect(await c.json()).toEqual(shapeRefusal);

    const d = await post(app, SNAPSHOT, w.a.cookie, '{"transfer":');
    expect(d.status).toBe(400);
    expect(await d.json()).toEqual({ error: { code: 400, message: t("server.error.validation"), reason: REQUEST_SHAPE_REASON } });

    const e = await post(app, SNAPSHOT, w.a.cookie, "{}");
    expect(e.status).toBe(422);
    expect(await e.json()).toEqual(shapeRefusal);

    expect(read.calls).toEqual([]);
    expect(await allRefKeys()).toEqual(before);
    expect(await getRedis().get(lockKey(w.a.id))).toBeNull();

    const used = await post(app, SNAPSHOT, w.a.cookie, ref(w.key));
    expect(used.status).toBe(201);
  });

  it("T52: a route outside the three ignores the transfer shape", async () => {
    const w = await world();

    const res = await post(app, "/canvas/tasks", w.a.cookie, ref(w.key));

    expect(res.status).toBe(422);
    expect(await res.json()).toEqual({ error: { code: 422, message: t("server.error.validation"), reason: REQUEST_SHAPE_REASON } });
    expect(read.calls).toEqual([]);
    const used = await post(app, SNAPSHOT, w.a.cookie, ref(w.key));
    expect(used.status).toBe(201);
  });

  it("T53 / S20 / R01 / R06: a snapshot read back through a transfer stores t0 exactly", async () => {
    const w = await world();

    const res = await post(app, SNAPSHOT, w.a.cookie, ref(w.key));

    expect(res.status).toBe(201);
    expect(await contents(w.projectId, w.node)).toEqual([T0]);
    expect(read.calls).toEqual([[w.key, Math.min(capSnap(), w.file.length)]]);
    await expectClaimed(w.key);
    expect(await getRedis().get(lockKey(w.a.id))).toBeNull();
  });

  it("T54: a paste through a transfer answers and writes what the same body sent directly does", async () => {
    const w = await world();
    const node = crypto.randomUUID();
    const words = "中".repeat(400_000);
    const body = { project_id: w.projectId, urls: [], pairs: [], history: [{ node_id: node, kind: "text", content: words }] };
    const file = enc(body);
    const key = await grant(w, file.length);
    read.answer = async () => file;

    const direct = await post(app, PASTE, w.a.cookie, JSON.stringify(body));
    const viaTransfer = await post(app, PASTE, w.a.cookie, ref(key));

    expect(direct.status).toBe(200);
    expect(viaTransfer.status).toBe(200);
    const directMap = ((await direct.json()) as { data: { map: Record<string, unknown> } }).data.map;
    const transferMap = ((await viaTransfer.json()) as { data: { map: Record<string, unknown> } }).data.map;
    expect(Object.keys(transferMap).sort()).toEqual(Object.keys(directMap).sort());
    expect(await contents(w.projectId, node)).toEqual([words, words]);
    expect(read.calls).toEqual([[key, Math.min(transferConfig().route_max_bytes.canvas_paste, file.length)]]);
  });

  it("T55: a chat message through a transfer stores the same user message as the direct send", async () => {
    const w = await world();
    const direct = await seedConversation(sql, w.a.id, w.projectId);
    const viaTransfer = await seedConversation(sql, w.a.id, w.projectId);
    /**
     * The chat body for a conversation.
     * @param conversationId - Where it lands.
     * @returns The body.
     */
    const body = (conversationId: string): Record<string, unknown> => ({
      message: "m".repeat(200),
      project_id: w.projectId,
      conversation_id: conversationId,
      attached_chips: [{ id: "file-1", type: "text", name: "notes.txt", data_snapshot: { text: "中".repeat(190_000) } }],
      current_space: {
        id: "space-1",
        name: "Doc",
        kind: "document",
        state: "loaded",
        content: "中".repeat(90_000),
        total_chars: 90_000,
        blocks: [{ id: "b1", type: "paragraph", text: "中".repeat(90_000), lossy: false, partial: false }],
      },
    });
    const file = enc(body(viaTransfer));
    const key = await grant(w, file.length);
    read.answer = async () => file;

    const sent = await post(app, CHAT, w.a.cookie, JSON.stringify(body(direct)));
    expect(sent.status).toBe(200);
    await sent.text();
    const res = await post(app, CHAT, w.a.cookie, ref(key));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/event-stream");
    await res.text();

    /**
     * The user message stored in a conversation.
     * @param conversationId - The conversation.
     * @returns Its parts.
     */
    const userParts = async (conversationId: string): Promise<unknown[]> =>
      (await sql<{ parts: unknown }[]>`
        SELECT parts FROM conversation_messages WHERE conversation_id = ${conversationId} AND role = 'user' ORDER BY created_at
      `).map((r) => r.parts);
    const directParts = await userParts(direct);
    expect(directParts).toHaveLength(1);
    expect(await userParts(viaTransfer)).toEqual(directParts);
    expect(read.calls).toEqual([[key, Math.min(transferConfig().route_max_bytes.chat_message, file.length)]]);
  });

  it("T56: validate sees the original body; a body that fails it still used the transfer", async () => {
    const w = await world();
    const file = enc({ project_id: w.projectId, node_id: w.node });
    const key = await grant(w, file.length);
    read.answer = async () => file;

    const res = await post(app, SNAPSHOT, w.a.cookie, ref(key));

    expect(res.status).toBe(422);
    expect(await res.json()).toEqual({ error: { code: 422, message: t("server.error.validation"), reason: REQUEST_SHAPE_REASON } });
    await expectClaimed(key);
    expect(await getRedis().get(lockKey(w.a.id))).toBeNull();
  });

  it("T57: content that is not JSON, or a nested reference, is not unwrapped again", async () => {
    const w = await world();
    const before = await historyCount(sql, w.projectId);
    const notJson = bytes(sig(), "hello");
    const nested = enc({ transfer: "transfer/2026-10-24/1_y.transfer" });
    const k1 = await grant(w, notJson.length);
    const k2 = await grant(w, nested.length);

    read.answer = async () => notJson;
    const a = await post(app, SNAPSHOT, w.a.cookie, ref(k1));
    expect(a.status).toBe(400);
    expect(await a.json()).toEqual({ error: { code: 400, message: t("server.error.validation"), reason: REQUEST_SHAPE_REASON } });

    read.answer = async () => nested;
    const b = await post(app, SNAPSHOT, w.a.cookie, ref(k2));
    expect(b.status).toBe(422);
    expect(await b.json()).toEqual({ error: { code: 422, message: t("server.error.validation"), reason: REQUEST_SHAPE_REASON } });

    expect(read.calls.map(([k]) => k)).toEqual([k1, k2]);
    await expectClaimed(k1);
    await expectClaimed(k2);
    expect(await historyCount(sql, w.projectId)).toBe(before);
  });

  it("T58: assertSayable still applies to a chat body read back from a transfer", async () => {
    const w = await world();
    const conversationId = await seedConversation(sql, w.a.id, w.projectId);
    const file = enc({ message: "y".repeat(15_001), project_id: w.projectId, conversation_id: conversationId, attached_chips: [] });
    const key = await grant(w, file.length);
    read.answer = async () => file;

    const res = await post(app, CHAT, w.a.cookie, ref(key));

    expect(res.status).toBe(422);
    expect(await res.json()).toEqual({
      error: { code: 422, message: t("server.chat.message_too_long", { limit: 15_000, actual: 15_001 }) },
    });
  });
});

describe("§4.2 refusals and claims", () => {
  it("T60 / S23: another member's key is refused as not_owner and stays usable for its owner", async () => {
    const w = await world();

    const res = await post(app, SNAPSHOT, w.b.cookie, ref(w.key));

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual(invalid());
    const lines = logLines(logged, "transfer_rejected");
    expect(lines).toHaveLength(1);
    expect(lines[0]!.level).toBe("warn");
    expect(lines[0]!.fields).toMatchObject({ reason: "not_owner", userId: w.b.id });
    // The uploader's id rides along under a field the implementation names.
    expect(Object.entries(lines[0]!.fields).some(([k, v]) => k !== "userId" && v === w.a.id)).toBe(true);
    expect(read.calls).toEqual([]);
    expect(await getRedis().get(refKey(w.key))).toBeNull();

    const owner = await post(app, SNAPSHOT, w.a.cookie, ref(w.key));
    expect(owner.status).toBe(201);
  });

  it("T61 / S22: a second reference is refused as already_used", async () => {
    const w = await world();
    const before = await historyCount(sql, w.projectId);

    const first = await post(app, SNAPSHOT, w.a.cookie, ref(w.key));
    const second = await post(app, SNAPSHOT, w.a.cookie, ref(w.key));

    expect(first.status).toBe(201);
    expect(second.status).toBe(400);
    expect(await second.json()).toEqual(invalid());
    expect(reasons()).toEqual(["already_used"]);
    expect(read.calls).toHaveLength(1);
    expect(await historyCount(sql, w.projectId)).toBe(before + 1);
  });

  it("T62 / S02: a key never issued is refused as not_found", async () => {
    const w = await world();

    const res = await post(
      app,
      SNAPSHOT,
      w.a.cookie,
      ref("transfer/2026-10-24/1_00000000-0000-4000-8000-000000000000.transfer"),
    );

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual(invalid());
    expect(reasons()).toEqual(["not_found"]);
    expect(read.calls).toEqual([]);
  });

  it("T63 / R09: a key outside transfer/ is refused as bad_key before the lock is taken", async () => {
    const w = await world();
    const assetKey = `image/2026-10-24/1_${crypto.randomUUID()}.png`;
    await sql`
      INSERT INTO studio_assets
        (studio_id, content_hash, storage_key, file_url, size_bytes, mime_type, kind, source, produced_by_user_id)
      VALUES (${w.studioId}, ${crypto.randomBytes(32).toString("hex")}, ${assetKey},
              ${`https://assets.test.invalid/${assetKey}`}, 1, 'image/png', 'image', 'upload', ${w.a.id})
    `;
    await getRedis().set(lockKey(w.a.id), "other-token", "EX", 60);
    const setSpy = vi.spyOn(getRedis(), "set");
    try {
      for (const key of ["x", "", assetKey, "Transfer/2026-10-24/1_a.transfer", "/transfer/2026-10-24/1_a.transfer"]) {
        const res = await post(app, SNAPSHOT, w.a.cookie, ref(key));
        expect(res.status).toBe(400);
        expect(await res.json()).toEqual(invalid());
      }
      expect(reasons()).toEqual(["bad_key", "bad_key", "bad_key", "bad_key", "bad_key"]);
      expect(read.calls).toEqual([]);
      expect(setSpy.mock.calls.filter((call) => call[0] === lockKey(w.a.id))).toEqual([]);
    } finally {
      setSpy.mockRestore();
      await getRedis().del(lockKey(w.a.id));
    }
  });

  it("T64 / S06 / S14: an open or finishing grant is refused as not_finished", async () => {
    const w = await world();
    const open = await grant(w, 100, "open");
    const finishing = await grant(w, 100, "finishing");

    for (const key of [open, finishing]) {
      const res = await post(app, SNAPSHOT, w.a.cookie, ref(key));
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual(invalid());
    }
    expect(reasons()).toEqual(["not_finished", "not_finished"]);
    expect(read.calls).toEqual([]);
  });

  it("T65 / S29: a voided grant is refused as not_finished", async () => {
    const w = await world();
    const voided = await grant(w, 100, "voided");

    const res = await post(app, SNAPSHOT, w.a.cookie, ref(voided));

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual(invalid());
    expect(reasons()).toEqual(["not_finished"]);
  });

  it("T66 / S33: a reference inside the TTL works and one past it is refused as expired", async () => {
    const w = await world();
    const fresh = await grant(w, w.file.length);
    const stale = await grant(w, w.file.length);
    await completedAgo(sql, fresh, 3599);
    await completedAgo(sql, stale, 3601);

    const ok = await post(app, SNAPSHOT, w.a.cookie, ref(fresh));
    expect(ok.status).toBe(201);
    read.calls.length = 0;

    // S33 (stale × deadline / browser leaves): the status still reads
    // transferred and the row does not move.
    const rowBefore = await grantRow(sql, stale);
    const status = await app.request(`/api/v1/assets/upload-status?key=${encodeURIComponent(stale)}`, {
      headers: { Cookie: w.a.cookie },
    });
    expect(status.status).toBe(200);
    expect(await status.json()).toEqual({ data: { items: [{ key: stale, state: "transferred" }] } });
    expect(await grantRow(sql, stale)).toEqual(rowBefore);

    const res = await post(app, SNAPSHOT, w.a.cookie, ref(stale));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual(invalid());
    expect(reasons()).toEqual(["expired"]);
    expect(read.calls).toEqual([]);
  });

  it("T67 / S24: a read already in flight for the user answers 429 and leaves the transfer usable", async () => {
    const w = await world();
    await getRedis().set(lockKey(w.a.id), "other-token", "EX", 60, "NX");

    const res = await post(app, SNAPSHOT, w.a.cookie, ref(w.key));

    expect(res.status).toBe(429);
    expect(res.headers.get("retry-after")).toBe("1");
    expect(await res.json()).toEqual({ error: { code: 429, message: t("server.error.rate_limited") } });
    expect(read.calls).toEqual([]);
    expect(await getRedis().get(refKey(w.key))).toBeNull();
    expect(await getRedis().get(lockKey(w.a.id))).toBe("other-token");

    await getRedis().del(lockKey(w.a.id));
    const again = await post(app, SNAPSHOT, w.a.cookie, ref(w.key));
    expect(again.status).toBe(201);
  });

  it("T68 / S21b / R02: a missing object is refused as expired without claiming", async () => {
    const w = await world();
    read.answer = async (key) => {
      throw new ObjectMissing(key);
    };

    const res = await post(app, SNAPSHOT, w.a.cookie, ref(w.key));

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual(invalid());
    expect(reasons()).toEqual(["expired"]);
    await expectUnclaimedAndUnlocked(w.key, w.a.id);

    read.answer = async () => w.file;
    const again = await post(app, SNAPSHOT, w.a.cookie, ref(w.key));
    expect(again.status).toBe(201);
  });

  it("T69 / S21a / R11: an object past the read cap answers 413 and is claimed", async () => {
    const w = await world();
    read.answer = async (key) => {
      throw new ObjectTooLarge(key);
    };
    const before = await historyCount(sql, w.projectId);

    const res = await post(app, SNAPSHOT, w.a.cookie, ref(w.key));

    expect(res.status).toBe(413);
    expect(await res.json()).toEqual({
      error: {
        code: 413,
        message: t("server.error.payload_too_large", { limit: formatBytes(Math.min(capSnap(), w.file.length)) }),
      },
    });
    await expectClaimed(w.key);
    expect(await getRedis().get(lockKey(w.a.id))).toBeNull();

    read.answer = async () => w.file;
    const again = await post(app, SNAPSHOT, w.a.cookie, ref(w.key));
    expect(again.status).toBe(400);
    expect(await again.json()).toEqual(invalid());
    expect(reasons()).toEqual(["already_used"]);
    expect(read.calls).toHaveLength(1);
    expect(await historyCount(sql, w.projectId)).toBe(before);
  });

  it("T70 / S21a / R11: invalid UTF-8 after the signature is refused as bad_encoding and claimed", async () => {
    const w = await world();
    const file = bytes(sig(), [0x7b, 0x22, 0xc3, 0x28, 0x22, 0x7d]);
    const key = await grant(w, file.length);
    read.answer = async () => file;

    const res = await post(app, SNAPSHOT, w.a.cookie, ref(key));

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual(invalid());
    expect(reasons()).toEqual(["bad_encoding"]);
    await expectClaimed(key);
    expect(await getRedis().get(lockKey(w.a.id))).toBeNull();

    const again = await post(app, SNAPSHOT, w.a.cookie, ref(key));
    expect(again.status).toBe(400);
    expect(reasons()).toEqual(["bad_encoding", "already_used"]);
  });

  it("T71 / S21b / R02: a storage error answers 502, logs it and does not claim", async () => {
    const w = await world();
    const boom = new Error("boom");
    read.answer = async () => {
      throw boom;
    };

    const res = await post(app, SNAPSHOT, w.a.cookie, ref(w.key));

    expect(res.status).toBe(502);
    const lines = logLines(logged, "transfer_read_failed");
    expect(lines).toHaveLength(1);
    expect(lines[0]!.level).toBe("error");
    expect(lines[0]!.fields).toMatchObject({ err: boom, key: w.key, userId: w.a.id });
    await expectUnclaimedAndUnlocked(w.key, w.a.id);

    read.answer = async () => w.file;
    const again = await post(app, SNAPSHOT, w.a.cookie, ref(w.key));
    expect(again.status).toBe(201);
  });

  it("T72: the read cap is the route's cap, bounded by the declared size", async () => {
    const w = await world();
    const caps = transferConfig().route_max_bytes;
    // (a) chat: 5 MiB declared, chat caps at 4 MiB.
    const chatKey = await grant(w, 5_242_880);
    read.answer = async (key) => {
      throw new ObjectTooLarge(key);
    };
    const a = await post(app, CHAT, w.a.cookie, ref(chatKey));
    expect(read.calls).toEqual([[chatKey, 4_194_304]]);
    expect(caps.chat_message).toBe(4_194_304);
    expect(a.status).toBe(413);
    expect(await a.json()).toEqual({
      error: { code: 413, message: t("server.error.payload_too_large", { limit: formatBytes(4_194_304) }) },
    });
    await expectClaimed(chatKey);

    // (b) the same size on the snapshot route.
    read.calls.length = 0;
    const snapKey = await grant(w, 5_242_880);
    read.answer = async (key) => {
      throw new ObjectMissing(key);
    };
    await post(app, SNAPSHOT, w.a.cookie, ref(snapKey));
    expect(read.calls).toEqual([[snapKey, 5_242_880]]);

    // (c) the largest ticket on the paste route.
    read.calls.length = 0;
    const pasteKey = await grant(w, 25_165_824);
    await post(app, PASTE, w.a.cookie, ref(pasteKey));
    expect(read.calls).toEqual([[pasteKey, 25_165_824]]);
  });

  it("T73: the paste rate limit runs before the transfer is read", async () => {
    const w = await world();
    const body = { project_id: w.projectId, urls: [], pairs: [], history: [] };
    const file = enc(body);
    const keys: string[] = [];
    for (let i = 0; i < 61; i++) keys.push(await grant(w, file.length));
    read.answer = async () => file;

    const statuses: number[] = [];
    for (const key of keys) statuses.push((await post(app, PASTE, w.a.cookie, ref(key))).status);

    expect(statuses.slice(0, 60)).toEqual(Array.from({ length: 60 }, () => 200));
    expect(statuses[60]).toBe(429);
    expect(read.calls).toHaveLength(60);
  });

  it("T74: a reference without a session answers 401 on all three routes", async () => {
    const w = await bareWorld();
    for (const path of [SNAPSHOT, PASTE, CHAT]) {
      const res = await post(app, path, null, ref(w.key));
      expect(res.status).toBe(401);
    }
    expect(read.calls).toEqual([]);
  });

  it("T75 / S21a / R11: content without the signature at byte 0 is refused as bad_format and claimed", async () => {
    const w = await world();
    const before = await historyCount(sql, w.projectId);
    const answers = [
      new TextEncoder().encode(JSON.stringify(snap(w, T0))),
      PNG,
      bytes([0xef, 0xbb, 0xbf], enc(snap(w, "x"))),
    ];

    for (const file of answers) {
      read.answer = async () => file;
      const key = await grant(w, file.length);
      const res = await post(app, SNAPSHOT, w.a.cookie, ref(key));
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual(invalid());
      await expectClaimed(key);
      expect(await getRedis().get(lockKey(w.a.id))).toBeNull();
      const again = await post(app, SNAPSHOT, w.a.cookie, ref(key));
      expect(again.status).toBe(400);
    }
    expect(reasons()).toEqual(["bad_format", "already_used", "bad_format", "already_used", "bad_format", "already_used"]);
    expect(await historyCount(sql, w.projectId)).toBe(before);
  });

  it("T76: content-caused failures use the transfer up; missing objects and storage errors do not", async () => {
    const w = await world();
    const failures: Array<(key: string) => Promise<Uint8Array>> = [
      async (key) => {
        throw new ObjectTooLarge(key);
      },
      async () => new TextEncoder().encode(JSON.stringify(snap(w, "x"))),
      async () => bytes(sig(), [0xc3, 0x28]),
      async (key) => {
        throw new ObjectMissing(key);
      },
      async () => {
        throw new Error("boom");
      },
    ];
    const second: Array<{ status: number; reason: unknown }> = [];

    for (const fail of failures) {
      const key = await grant(w, w.file.length);
      read.answer = fail;
      await post(app, SNAPSHOT, w.a.cookie, ref(key));
      read.answer = async () => w.file;
      const before = reasons().length;
      const res = await post(app, SNAPSHOT, w.a.cookie, ref(key));
      second.push({ status: res.status, reason: reasons()[before] });
    }

    expect(second).toEqual([
      { status: 400, reason: "already_used" },
      { status: 400, reason: "already_used" },
      { status: 400, reason: "already_used" },
      { status: 201, reason: undefined },
      { status: 201, reason: undefined },
    ]);
  });

  it("T77: the chat read cap counts the signature", async () => {
    const w = await world();
    const conversationId = await seedConversation(sql, w.a.id, w.projectId);
    const json = JSON.stringify({ message: "hi", project_id: w.projectId, conversation_id: conversationId, attached_chips: [] });
    // Whitespace after the value keeps it valid JSON while filling the file to the cap.
    const padded = json + " ".repeat(4_194_285 - new TextEncoder().encode(json).length);
    const exact = bytes(sig(), padded);
    expect(exact.length).toBe(4_194_304);

    const okKey = await grant(w, 4_194_304);
    read.answer = async () => exact;
    const a = await post(app, CHAT, w.a.cookie, ref(okKey));
    expect(read.calls).toEqual([[okKey, 4_194_304]]);
    expect(a.status).toBe(200);
    await a.text();

    read.calls.length = 0;
    const bigKey = await grant(w, 4_194_304);
    read.answer = async (key) => {
      throw new ObjectTooLarge(key);
    };
    const b = await post(app, CHAT, w.a.cookie, ref(bigKey));
    expect(b.status).toBe(413);
    expect(await b.json()).toEqual({
      error: { code: 413, message: t("server.error.payload_too_large", { limit: formatBytes(4_194_304) }) },
    });
    await expectClaimed(bigKey);
  });

  it("T78: a key uploaded for chat may be used on paste, under paste's cap", async () => {
    const w = await world();
    const file = enc({ project_id: w.projectId, urls: [], pairs: [], history: [] });
    const key = await grant(w, 5_000_000);
    read.answer = async () => file;

    const res = await post(app, PASTE, w.a.cookie, ref(key));

    expect(read.calls).toEqual([[key, 5_000_000]]);
    expect(res.status).toBe(200);
  });

  it("T79: a file holding only the signature decodes to an empty body and is claimed", async () => {
    const w = await world();
    const key = await grant(w, 19);
    read.answer = async () => sig();

    const res = await post(app, SNAPSHOT, w.a.cookie, ref(key));

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: { code: 400, message: t("server.error.validation"), reason: REQUEST_SHAPE_REASON } });
    await expectClaimed(key);
  });
});

describe("§6 S25: a completed transfer nobody references", () => {
  it("S25: leaves REF unset and the grant unchanged", async () => {
    const w = await world();
    const before = await grantRow(sql, w.key);

    const status = await app.request(`/api/v1/assets/upload-status?key=${encodeURIComponent(w.key)}`, {
      headers: { Cookie: w.a.cookie },
    });

    expect(status.status).toBe(200);
    expect(await status.json()).toEqual({ data: { items: [{ key: w.key, state: "transferred" }] } });
    expect(await getRedis().get(refKey(w.key))).toBeNull();
    expect(await grantRow(sql, w.key)).toEqual(before);
    expect(before.consumed_at).not.toBeNull();
    expect(before.asset_id).toBeNull();
  });
});

describe("§6.2 the two Redis keys", () => {
  it("R03: losing the SET NX claim to another reader answers already_used", async () => {
    const w = await world();
    const before = await historyCount(sql, w.projectId);
    read.answer = async (key) => {
      await getRedis().set(refKey(key), "1", "EX", 3600);
      return w.file;
    };

    const res = await post(app, SNAPSHOT, w.a.cookie, ref(w.key));

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual(invalid());
    expect(reasons()).toEqual(["already_used"]);
    expect(await historyCount(sql, w.projectId)).toBe(before);
    expect(await getRedis().get(lockKey(w.a.id))).toBeNull();
  });

  it("R04: once REF and the grant's TTL have both run out, a reference is refused as expired", async () => {
    const w = await world();
    const first = await post(app, SNAPSHOT, w.a.cookie, ref(w.key));
    expect(first.status).toBe(201);
    await getRedis().expire(refKey(w.key), 1);
    await completedAgo(sql, w.key, transferConfig().reference_ttl_seconds + 1);
    const gone = Date.now() + 5_000;
    while ((await getRedis().exists(refKey(w.key))) === 1 && Date.now() < gone) {
      await new Promise((r) => setTimeout(r, 100));
    }
    expect(await getRedis().exists(refKey(w.key))).toBe(0);

    const res = await post(app, SNAPSHOT, w.a.cookie, ref(w.key));

    expect(res.status).toBe(400);
    expect(reasons()).toEqual(["expired"]);
  });

  it("R05: the read lock is held, with a random token and the configured TTL, while reading", async () => {
    const w = await world();
    const lockSeconds = transferConfig().read_lock_seconds;
    let seen: { value: string | null; ttl: number } | null = null;
    read.answer = async () => {
      seen = { value: await getRedis().get(lockKey(w.a.id)), ttl: await getRedis().ttl(lockKey(w.a.id)) };
      return w.file;
    };

    const res = await post(app, SNAPSHOT, w.a.cookie, ref(w.key));

    expect(res.status).toBe(201);
    const held = seen as { value: string | null; ttl: number } | null;
    expect(held).not.toBeNull();
    expect(typeof held!.value).toBe("string");
    expect(held!.value).not.toBe("1");
    expect(held!.ttl).toBeGreaterThan(lockSeconds - 5);
    expect(held!.ttl).toBeLessThanOrEqual(lockSeconds);
    expect(await getRedis().get(lockKey(w.a.id))).toBeNull();
  });

  it("R07: every failure releases the lock, and a lock someone else now holds is left alone", async () => {
    const w = await world();
    /**
     * A new completed grant of A.
     * @returns Its key.
     */
    const fresh = async (): Promise<string> => grant(w, w.file.length);

    // not_found
    await post(app, SNAPSHOT, w.a.cookie, ref("transfer/2026-10-24/1_00000000-0000-4000-8000-000000000001.transfer"));
    expect(await getRedis().get(lockKey(w.a.id))).toBeNull();
    // not_owner, on B's lock
    await post(app, SNAPSHOT, w.b.cookie, ref(await fresh()));
    expect(await getRedis().get(lockKey(w.b.id))).toBeNull();
    // not_finished
    await post(app, SNAPSHOT, w.a.cookie, ref(await grant(w, 100, "open")));
    expect(await getRedis().get(lockKey(w.a.id))).toBeNull();
    // expired
    const stale = await fresh();
    await completedAgo(sql, stale, 3601);
    await post(app, SNAPSHOT, w.a.cookie, ref(stale));
    expect(await getRedis().get(lockKey(w.a.id))).toBeNull();
    // already_used
    const used = await fresh();
    await getRedis().set(refKey(used), "1", "EX", 3600);
    await post(app, SNAPSHOT, w.a.cookie, ref(used));
    expect(await getRedis().get(lockKey(w.a.id))).toBeNull();
    // ObjectMissing, ObjectTooLarge, bad_format, bad_encoding, storage error
    const reads: Array<(key: string) => Promise<Uint8Array>> = [
      async (key) => {
        throw new ObjectMissing(key);
      },
      async (key) => {
        throw new ObjectTooLarge(key);
      },
      async () => PNG,
      async () => bytes(sig(), [0xff]),
      async () => {
        throw new Error("boom");
      },
    ];
    for (const answer of reads) {
      read.answer = answer;
      await post(app, SNAPSHOT, w.a.cookie, ref(await fresh()));
      expect(await getRedis().get(lockKey(w.a.id))).toBeNull();
    }
    expect(reasons()).toEqual([
      "not_found",
      "not_owner",
      "not_finished",
      "expired",
      "already_used",
      "expired",
      "bad_format",
      "bad_encoding",
    ]);

    // The lock changes hands mid-read: the finishing request must not delete it.
    read.answer = async () => {
      await getRedis().set(lockKey(w.a.id), "other-token", "EX", 60);
      return w.file;
    };
    await post(app, SNAPSHOT, w.a.cookie, ref(await fresh()));
    expect(await getRedis().get(lockKey(w.a.id))).toBe("other-token");
    await getRedis().del(lockKey(w.a.id));
  });

  it("R08: a lock left by a crashed process expires on its own", async () => {
    const w = await world();
    await getRedis().set(lockKey(w.a.id), "dead", "PX", 1000, "NX");

    const first = await post(app, SNAPSHOT, w.a.cookie, ref(w.key));
    expect(first.status).toBe(429);
    await new Promise((r) => setTimeout(r, 1200));
    const second = await post(app, SNAPSHOT, w.a.cookie, ref(w.key));
    expect(second.status).toBe(201);
  });
});
