// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Property tests for the transfer-reference entrance (inner#1006 design §4.6,
 * §7.5 and §7.6; test spec P05, P07, P08, P10).
 *
 * Postgres and Redis are real. Only the storage adapter's `read` is a stub,
 * because the suite's R2 endpoint is not reachable; its delays are what make
 * concurrent references overlap inside the read lock's window. Every property
 * run seeds fresh users, so the routes' own per-user rate limits (60 a
 * minute) never decide an answer.
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
import fc from "fast-check";
import postgres from "postgres";
import type { Hono } from "hono";
import { initCore, loadLocales, getRedis, ObjectMissing, ObjectTooLarge } from "@breatic/core";
import {
  bytes,
  completedAgo,
  enc,
  historyCount,
  installReadStub,
  lockKey,
  logLines,
  post,
  ref,
  refKey,
  seedProject,
  sig,
  transferConfig,
  transferGrant,
  transferKey,
  type GrantState,
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

let sql: ReturnType<typeof postgres>;
let app: Hono;
let read: ReadStub;

beforeAll(async () => {
  sql = postgres(inject("DATABASE_URL"), {
    max: 4,
    prepare: false,
    connection: { application_name: "transfer-body-properties-test-driver" },
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
  clearLogs();
});

/** Forget every logged line. */
function clearLogs(): void {
  for (const fn of Object.values(logged)) if (typeof fn === "function" && "mockClear" in fn) fn.mockClear();
}

/**
 * Wait.
 * @param ms - How long.
 * @returns After that long.
 */
function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * A valid snapshot transfer file for a fresh node of the project.
 * @param projectId - P.
 * @returns The bytes.
 */
function snapshotFile(projectId: string): Uint8Array {
  return enc({ project_id: projectId, node_id: crypto.randomUUID(), text: "words" });
}

/**
 * A's completed transfer grant.
 * @param w - The project.
 * @param declaredSize - The ticket's size.
 * @param owner - Whose grant; A by default.
 * @returns Its key.
 */
async function completed(w: Seeded, declaredSize: number, owner: string = w.a.id): Promise<string> {
  return transferGrant({ userId: owner, studioId: w.studioId, projectId: w.projectId, declaredSize });
}

/** The three routes that take a transfer, by their config key. */
const ROUTES = {
  chat_message: "/chat/message",
  canvas_paste: "/canvas/paste",
  node_history_snapshot: SNAPSHOT,
} as const;

describe("P05: the read cap", () => {
  it("reads once with min(route cap, declared size)", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.constantFrom(...(Object.keys(ROUTES) as Array<keyof typeof ROUTES>)),
        fc.integer({ min: 1, max: 25_165_824 }),
        async (route, declared) => {
          read.calls.length = 0;
          const w = await seedProject(sql);
          const key = await completed(w, declared);
          read.answer = async (k) => {
            throw new ObjectMissing(k);
          };

          await post(app, ROUTES[route], w.a.cookie, ref(key));

          expect(read.calls).toEqual([[key, Math.min(transferConfig().route_max_bytes[route], declared)]]);
        },
      ),
      { numRuns: 60 },
    );
  });
});

/** How the stubbed read ends in P07. */
type Outcome = "ok" | "tooLarge" | "badFormat";

describe("P07: one transfer, many concurrent references", () => {
  it("reads at most once and lets exactly one reference through", async () => {
    await fc.assert(
      fc
        .asyncProperty(
          fc.integer({ min: 2, max: 8 }).chain((n) =>
            fc.tuple(fc.constant(n), fc.array(fc.nat(50), { minLength: n, maxLength: n })),
          ),
          fc.constantFrom<Outcome>("ok", "tooLarge", "badFormat"),
          async ([n, delays], outcome) => {
            read.calls.length = 0;
            clearLogs();
            const w = await seedProject(sql);
            const file = snapshotFile(w.projectId);
            const key = await completed(w, file.length);
            const historyBefore = await historyCount(sql, w.projectId);
            read.answer = async (k) => {
              await sleep(delays[read.calls.length - 1] ?? 0);
              if (outcome === "tooLarge") throw new ObjectTooLarge(k);
              if (outcome === "badFormat") return new TextEncoder().encode("{}");
              return file;
            };

            const statuses = (
              await Promise.all(Array.from({ length: n }, () => post(app, SNAPSHOT, w.a.cookie, ref(key))))
            ).map((r) => r.status);

            expect(read.calls.length).toBeLessThanOrEqual(1);
            const won = { ok: 201, tooLarge: 413, badFormat: 400 }[outcome];
            const reasons = logLines(logged, "transfer_rejected").map((l) => l.fields.reason);
            const badFormat = reasons.filter((r) => r === "bad_format").length;
            const alreadyUsed = reasons.filter((r) => r === "already_used").length;
            expect(badFormat).toBe(outcome === "badFormat" ? 1 : 0);
            if (outcome !== "badFormat") expect(statuses.filter((s) => s === won)).toHaveLength(1);
            // Every other answer is a lock refusal or already_used.
            const others = statuses.length - 1;
            expect(statuses.filter((s) => s === 429).length + alreadyUsed).toBe(others);
            expect(statuses.filter((s) => s === 400)).toHaveLength(alreadyUsed + badFormat);
            expect(await historyCount(sql, w.projectId)).toBe(historyBefore + (outcome === "ok" ? 1 : 0));
            expect(await getRedis().get(refKey(key))).toBe("1");
            expect(await getRedis().get(lockKey(w.a.id))).toBeNull();
          },
        ),
      { numRuns: 15 },
    );
  });
});

describe("P08: reads are serial per user and parallel across users", () => {
  it("never has two reads in flight for one user, and every refused key succeeds when sent again", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 1, max: 5 }),
        fc.integer({ min: 1, max: 5 }),
        fc.array(fc.nat(30), { minLength: 10, maxLength: 10 }),
        async (nA, nB, delays) => {
          read.calls.length = 0;
          const w = await seedProject(sql);
          const owner = new Map<string, string>();
          const files = new Map<string, Uint8Array>();
          const sends: Array<{ key: string; cookie: string }> = [];
          for (const [user, count] of [[w.a, nA], [w.b, nB]] as const) {
            for (let i = 0; i < count; i++) {
              const file = snapshotFile(w.projectId);
              const key = await completed(w, file.length, user.id);
              owner.set(key, user.id);
              files.set(key, file);
              sends.push({ key, cookie: user.cookie });
            }
          }
          const inFlight = new Map<string, number>();
          const peak = new Map<string, number>();
          read.answer = async (k) => {
            const user = owner.get(k)!;
            inFlight.set(user, (inFlight.get(user) ?? 0) + 1);
            peak.set(user, Math.max(peak.get(user) ?? 0, inFlight.get(user)!));
            await sleep(delays[(read.calls.length - 1) % delays.length]!);
            inFlight.set(user, inFlight.get(user)! - 1);
            return files.get(k)!;
          };

          const first = await Promise.all(sends.map((s) => post(app, SNAPSHOT, s.cookie, ref(s.key))));

          expect(peak.get(w.a.id) ?? 0).toBeLessThanOrEqual(1);
          expect(peak.get(w.b.id) ?? 0).toBeLessThanOrEqual(1);
          // Each key is its sender's own finished transfer, so a first send
          // either reads it or is turned away by the sender's lock.
          expect(first.map((r) => r.status).filter((s) => s !== 201 && s !== 429)).toEqual([]);
          const refused = sends.filter((_, i) => first[i]!.status === 429);
          for (const s of refused) {
            const again = await post(app, SNAPSHOT, s.cookie, ref(s.key));
            expect(again.status).toBe(201);
          }
          expect(read.calls.map(([k]) => k).sort()).toEqual(sends.map((s) => s.key).sort());
        },
      ),
      { numRuns: 10 },
    );
  });
});

/** What the stubbed read does in P10. */
type ReadResult = "ok" | "missing" | "tooLarge" | "badFormat" | "badEncoding" | "storageError";

/** Grant state in P10, `none` meaning the key was never issued. */
type P10State = "none" | GrantState;

describe("P10: which references are read and which are claimed", () => {
  it("reads only the owner's fresh unclaimed completed grant, and claims only after content-caused outcomes", async () => {
    const ttl = transferConfig().reference_ttl_seconds;
    await fc.assert(
      fc.asyncProperty(
        fc.constantFrom<"a" | "b">("a", "b"),
        fc.constantFrom<"a" | "b">("a", "b"),
        fc.constantFrom<P10State>("none", "open", "finishing", "completed", "voided"),
        // Two seconds either side of the TTL are left out: the clock moves
        // between writing consumed_at and the check that reads it.
        fc.integer({ min: 0, max: 7200 }).filter((age) => Math.abs(age - ttl) > 2),
        fc.boolean(),
        fc.constantFrom<ReadResult>("ok", "missing", "tooLarge", "badFormat", "badEncoding", "storageError"),
        async (ownerName, requesterName, state, age, claimed, result) => {
          read.calls.length = 0;
          clearLogs();
          const w = await seedProject(sql);
          const ownerId = w[ownerName].id;
          const requester = w[requesterName];
          const file = snapshotFile(w.projectId);
          let key = transferKey();
          if (state !== "none") {
            key = await transferGrant(
              { userId: ownerId, studioId: w.studioId, projectId: w.projectId, declaredSize: file.length },
              state,
            );
            if (state === "completed") await completedAgo(sql, key, age);
          }
          if (claimed) await getRedis().set(refKey(key), "1", "EX", ttl);
          read.answer = async (k) => {
            if (result === "missing") throw new ObjectMissing(k);
            if (result === "tooLarge") throw new ObjectTooLarge(k);
            if (result === "storageError") throw new Error("boom");
            if (result === "badFormat") return new TextEncoder().encode("{}");
            if (result === "badEncoding") return bytes(sig(), [0xc3, 0x28]);
            return file;
          };

          const res = await post(app, SNAPSHOT, requester.cookie, ref(key));

          const shouldRead =
            state === "completed" && ownerName === requesterName && age <= ttl && !claimed;
          expect(read.calls.length).toBe(shouldRead ? 1 : 0);
          const refNow = await getRedis().get(refKey(key));
          if (shouldRead) {
            const claims = ["ok", "tooLarge", "badFormat", "badEncoding"].includes(result);
            expect(refNow).toBe(claims ? "1" : null);
          } else {
            expect(refNow).toBe(claimed ? "1" : null);
            expect(res.status).toBe(400);
            const expected =
              state === "none"
                ? "not_found"
                : ownerName !== requesterName
                  ? "not_owner"
                  : state !== "completed"
                    ? "not_finished"
                    : age > ttl
                      ? "expired"
                      : "already_used";
            expect(logLines(logged, "transfer_rejected").map((l) => l.fields.reason)).toEqual([expected]);
          }
        },
      ),
      { numRuns: 60 },
    );
  });
});
