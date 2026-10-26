// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * inner#1595 P06: one ticket opens exactly one upload, and no answer carries
 * a ticket (the second of the four parts of acceptance item 5, test spec §1.3).
 *
 * Any mix of single, batch (1 to BATCH_MAX files) and transfer tickets, sent
 * one after another or all at once, through the real routes and the real
 * database. Only the Worker's `POST /uploads` is a double, which counts every
 * open by key and answers each key the way the run's modes say, decided by
 * the key alone so a concurrent run is as reproducible as a sequential one.
 *
 * "Every key the server issued" is read off the grants this run's user holds,
 * not off the answers: an `openFailed` answer carries no key.
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
vi.mock("@server/utils/send-best-effort-mail.js", () => ({
  sendBestEffortMail: async () => {},
}));
vi.mock("@breatic/shared", async (importOriginal) =>
  (await import("../helpers/ingest-open-double.js")).sharedWithOpenDouble(importOriginal),
);

import crypto from "node:crypto";
import postgres from "postgres";
import fc from "fast-check";
import type { Hono } from "hono";
import { initCore, getRedis, setSession, sessionCookieName, loadLocales } from "@breatic/core";
import { UploadHttpError } from "@breatic/shared";
import { MINI_TOOLS, mostOutputsOf } from "@breatic/shared/mini-tools";
import { getRateLimit } from "@server/config/rate-limits.js";
import { openCalls, opensByKey, resetOpenDouble, setOpenMode } from "../helpers/ingest-open-double.js";

try {
  initCore(process.env);
} catch {
  // already initialised by a sibling suite in this worker — fine.
}
loadLocales();

let sql: ReturnType<typeof postgres>;
let app: Hono;

beforeAll(async () => {
  sql = postgres(inject("DATABASE_URL"), {
    max: 4,
    prepare: false,
    connection: { application_name: "one-open-per-ticket-test" },
  });
  const { createApp } = await import("@server/app.js");
  app = createApp();
});

afterAll(async () => {
  await sql?.end({ timeout: 1 });
});

/** The largest batch a grouped browser tool asks for, read the way the route reads it. */
const BATCH_MAX = Math.max(
  ...MINI_TOOLS.filter((spec) => spec.run.kind === "browser" && spec.groupOutputs === true).map(mostOutputsOf),
);
const TILE_BYTES = 4096;
let seq = 0;

/** How the double answers a key. */
type Mode = "ok" | "http5xx" | "http4xx" | "net";

/** One request of a run. */
type Op =
  | { kind: "single"; node: boolean; purpose: "none" | "project_cover" }
  | { kind: "batch"; n: number; hits: boolean[] }
  | { kind: "transfer"; size: number };

/** One file a single or batch request asked for, and where its answer is. */
interface Asked {
  op: number;
  item: number;
  nodeId: string | undefined;
  hit: boolean;
}

/**
 * A fresh user who owns a project in their personal studio, with a session.
 * @returns The ids and a login cookie.
 */
async function seedEditor(): Promise<{ userId: string; studioId: string; projectId: string; cookie: string }> {
  const [u] = await sql<{ id: string }[]>`
    INSERT INTO users (email, email_verified) VALUES (${`oop-${seq++}-${crypto.randomUUID()}@example.com`}, true)
    RETURNING id
  `;
  const userId = u!.id;
  const [st] = await sql<{ id: string }[]>`
    INSERT INTO studios (created_by_user_id, slug, type, name)
    VALUES (${userId}, ${`oop-s-${seq++}-${crypto.randomUUID()}`}, 'personal', 'Personal') RETURNING id
  `;
  const studioId = st!.id;
  await sql`INSERT INTO studio_members (studio_id, user_id, role) VALUES (${studioId}, ${userId}, 'admin')`;
  const slug = `oop-p-${seq++}-${crypto.randomUUID()}`;
  const [p] = await sql<{ id: string }[]>`
    INSERT INTO projects (studio_id, created_by_user_id, name, slug)
    VALUES (${studioId}, ${userId}, ${`P ${slug}`}, ${slug}) RETURNING id
  `;
  const projectId = p!.id;
  await sql`
    INSERT INTO project_members (project_id, user_id, role, added_by) VALUES (${projectId}, ${userId}, 'owner', null)
  `;
  const token = crypto.randomBytes(24).toString("hex");
  await setSession(getRedis(), token, userId);
  return { userId, studioId, projectId, cookie: `${sessionCookieName()}=${token}` };
}

/**
 * Put one picture in the studio's ledger so the dedup pass finds it.
 * @param studioId - The studio.
 * @param userId - Who produced it.
 * @param hash - Its content hash.
 */
async function registerAsset(studioId: string, userId: string, hash: string): Promise<void> {
  await sql`
    INSERT INTO studio_assets
      (studio_id, content_hash, storage_key, file_url, size_bytes, mime_type, kind, source, produced_by_user_id)
    VALUES
      (${studioId}, ${hash}, ${`image/${hash}.png`}, ${`https://cdn.test.invalid/${hash}.png`}, ${TILE_BYTES},
       'image/png', 'image', 'upload', ${userId})
  `;
}

/**
 * A stable hash of a key, so its mode does not depend on call order.
 * @param key - The storage key.
 * @returns A non-negative integer.
 */
function stableHash(key: string): number {
  let h = 0;
  for (const ch of key) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return h;
}

/**
 * The failure the double throws for a mode.
 * @param mode - The mode.
 * @returns What it throws, or `"ok"`.
 */
function answerFor(mode: Mode): unknown {
  switch (mode) {
    case "ok":
      return "ok";
    case "http5xx":
      return new UploadHttpError(502, "store_failed");
    case "http4xx":
      return new UploadHttpError(401, null);
    case "net":
      return new TypeError("fetch failed");
  }
}

/**
 * Whether anything in a JSON value is a property named `ticket`.
 * @param value - The parsed body.
 * @returns Whether one was found, at any depth.
 */
function hasTicketKey(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(hasTicketKey);
  if (value !== null && typeof value === "object") {
    return Object.entries(value).some(([name, inner]) => name === "ticket" || hasTicketKey(inner));
  }
  return false;
}

const single = fc.record({ node: fc.boolean(), purpose: fc.constantFrom("none" as const, "project_cover" as const) });
const batchOp = fc.record({
  n: fc.oneof(
    { arbitrary: fc.integer({ min: 1, max: 4 }), weight: 4 },
    { arbitrary: fc.constant(BATCH_MAX), weight: 1 },
  ),
  hits: fc.array(fc.boolean()),
});
const transfer = fc.record({ size: fc.integer({ min: 1, max: 4096 }) });
const op: fc.Arbitrary<Op> = fc.oneof(
  single.map((o) => ({ kind: "single" as const, ...o })),
  batchOp.map((o) => ({ kind: "batch" as const, ...o })),
  transfer.map((o) => ({ kind: "transfer" as const, ...o })),
);

describe("inner#1595 P06: every key the server issues is opened exactly once, and no answer carries a ticket", () => {
  it("holds for any mix of single, batch and transfer tickets, sequential or concurrent", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(op, { minLength: 1, maxLength: 5 }),
        fc.boolean(),
        fc.array(fc.constantFrom<Mode>("ok", "ok", "ok", "http5xx", "http4xx", "net"), { minLength: 1, maxLength: 8 }),
        async (ops, concurrent, modes) => {
          const ticketOps = ops.filter((o) => o.kind !== "transfer").length;
          const transferOps = ops.length - ticketOps;
          expect(ticketOps).toBeLessThanOrEqual(getRateLimit("upload-ticket").max);
          expect(transferOps).toBeLessThanOrEqual(getRateLimit("transfer-ticket").max);

          const seed = await seedEditor();
          const spaceId = crypto.randomUUID();
          resetOpenDouble();
          /**
           * The mode a key is answered with.
           * @param key - The storage key.
           * @returns Its mode.
           */
          const modeOf = (key: string): Mode => modes[stableHash(key) % modes.length]!;
          setOpenMode((key) => answerFor(modeOf(key)));

          // What each request asks for, built before anything is sent.
          const asked: Asked[] = [];
          const sends: Array<() => Response | Promise<Response>> = [];
          for (const [index, o] of ops.entries()) {
            if (o.kind === "transfer") {
              sends.push(() =>
                app.request("/api/v1/assets/transfer-ticket", {
                  method: "POST",
                  headers: { "content-type": "application/json", cookie: seed.cookie },
                  body: JSON.stringify({ project_id: seed.projectId, size: o.size }),
                }),
              );
              continue;
            }
            if (o.kind === "single") {
              const nodeId = o.node && o.purpose === "none" ? crypto.randomUUID() : undefined;
              asked.push({ op: index, item: 0, nodeId, hit: false });
              const payload = {
                project_id: seed.projectId,
                filename: "photo.png",
                content_type: "image/png",
                size: TILE_BYTES,
                client_hash: crypto.randomBytes(32).toString("hex"),
                ...(o.purpose === "project_cover" ? { purpose: "project_cover" } : {}),
                ...(nodeId !== undefined ? { node_id: nodeId, space_id: spaceId } : {}),
              };
              sends.push(() =>
                app.request("/api/v1/assets/upload-ticket", {
                  method: "POST",
                  headers: { "content-type": "application/json", cookie: seed.cookie },
                  body: JSON.stringify(payload),
                }),
              );
              continue;
            }
            const items: Record<string, unknown>[] = [];
            for (let i = 0; i < o.n; i++) {
              const hit = o.hits[i] === true;
              const hash = crypto.randomBytes(32).toString("hex");
              if (hit) await registerAsset(seed.studioId, seed.userId, hash);
              const nodeId = crypto.randomUUID();
              asked.push({ op: index, item: i, nodeId, hit });
              items.push({ filename: "GRID.png", content_type: "image/png", size: TILE_BYTES, client_hash: hash, node_id: nodeId });
            }
            sends.push(() =>
              app.request("/api/v1/assets/upload-ticket", {
                method: "POST",
                headers: { "content-type": "application/json", cookie: seed.cookie },
                body: JSON.stringify({
                  project_id: seed.projectId,
                  space_id: spaceId,
                  source: "mini_tool",
                  tool_name: "image.grid",
                  items,
                }),
              }),
            );
          }

          const responses = concurrent
            ? await Promise.all(sends.map((send) => send()))
            : await (async () => {
                const out: Response[] = [];
                for (const send of sends) out.push(await send());
                return out;
              })();
          const answers = await Promise.all(
            responses.map(async (res) => {
              const text = await res.text();
              return { status: res.status, text, json: JSON.parse(text) as unknown };
            }),
          );

          const grants = await sql<
            { storage_key: string; voided_at: Date | null; asset_source: string | null; node_id: string | null }[]
          >`
            SELECT storage_key, voided_at, asset_source, node_id FROM upload_grants WHERE user_id = ${seed.userId}
          `;
          const opens = opensByKey();

          // 1. The keys issued are exactly the keys opened, each once.
          expect([...opens.keys()].sort()).toEqual(grants.map((g) => g.storage_key).sort());
          expect([...opens.values()].every((n) => n === 1)).toBe(true);

          // 2. No answer carries a ticket, by name or by value.
          const tickets = openCalls().map((call) => call.ticket);
          for (const answer of answers) {
            expect(hasTicketKey(answer.json)).toBe(false);
            for (const ticket of tickets) expect(answer.text.includes(ticket)).toBe(false);
          }

          // 5. The statuses each kind of request may answer with.
          for (const [index, o] of ops.entries()) {
            const allowed = o.kind === "transfer" ? [201, 500] : [200, 201];
            expect(allowed).toContain(answers[index]!.status);
          }

          // 3. Each answer agrees with how its key's open went.
          const grantByKey = new Map(grants.map((g) => [g.storage_key, g]));
          const grantByNode = new Map(grants.filter((g) => g.node_id !== null).map((g) => [g.node_id!, g]));
          let openedItems = 0;
          let failedItems = 0;
          for (const a of asked) {
            const json = answers[a.op]!.json as { data: Record<string, unknown> & { items?: Record<string, unknown>[] } };
            const item = ops[a.op]!.kind === "batch" ? json.data.items![a.item]! : json.data;
            if (a.hit) {
              // 4. A dedup hit opens no grant and nothing at the Worker.
              expect(item.alreadyExists).toBe(true);
              expect(a.nodeId === undefined || !grantByNode.has(a.nodeId)).toBe(true);
              continue;
            }
            if (typeof item.uploadId === "string") {
              openedItems += 1;
              const key = item.storageKey as string;
              expect(modeOf(key)).toBe("ok");
              const call = openCalls().find((c) => c.storageKey === key);
              expect(item.uploadId).toBe(call?.answer?.uploadId);
              expect(item.token).toBe(call?.answer?.token);
              expect(grantByKey.get(key)?.voided_at).toBeNull();
              continue;
            }
            failedItems += 1;
            expect(item.openFailed).toBeDefined();
            if (a.nodeId !== undefined) {
              const grant = grantByNode.get(a.nodeId)!;
              expect(modeOf(grant.storage_key)).not.toBe("ok");
              expect(grant.voided_at).not.toBeNull();
              expect(Object.keys(item).sort()).toEqual(["openFailed", "taskId"]);
              const [row] = await sql<{ id: string; status: string }[]>`
                SELECT id, status FROM node_tasks WHERE storage_key = ${grant.storage_key}
              `;
              expect(item.taskId).toBe(row!.id);
              expect(row!.status).toBe("failed");
            } else {
              expect(Object.keys(item)).toEqual(["openFailed"]);
            }
          }
          for (const [index, o] of ops.entries()) {
            if (o.kind !== "transfer" || answers[index]!.status !== 201) continue;
            const data = (answers[index]!.json as { data: Record<string, unknown> }).data;
            const key = data.storageKey as string;
            expect(modeOf(key)).toBe("ok");
            const call = openCalls().find((c) => c.storageKey === key);
            expect(data.uploadId).toBe(call?.answer?.uploadId);
            expect(data.token).toBe(call?.answer?.token);
            expect(grantByKey.get(key)?.voided_at).toBeNull();
          }
          const transferFailures = ops.filter((o, i) => o.kind === "transfer" && answers[i]!.status === 500).length;
          const failedKeys = grants.filter((g) => modeOf(g.storage_key) !== "ok");
          expect(failedKeys.every((g) => g.voided_at !== null)).toBe(true);
          expect(failedItems + transferFailures).toBe(failedKeys.length);
          expect(transferFailures).toBe(failedKeys.filter((g) => g.asset_source === "transfer").length);
          const okTransfers = ops.filter((o, i) => o.kind === "transfer" && answers[i]!.status === 201).length;
          expect(openedItems + okTransfers).toBe(grants.length - failedKeys.length);

          // 4. Only the files that were not hits have grants.
          expect(grants.length).toBe(asked.filter((a) => !a.hit).length + transferOps);
        },
      ),
      { numRuns: 15 },
    );
  }, 600_000);
});
