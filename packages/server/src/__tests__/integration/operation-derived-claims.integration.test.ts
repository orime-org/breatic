// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * Derived images claimed, used up and swept, and the same key admitted
 * twice, against real Postgres with payments on (inner#1968, test spec area
 * B: B-46, B-53 to B-62, B-64, B-65, B-72; invariants I1, I2, I5, I7, I8;
 * property tests PT-2 for these invariants and PT-6).
 *
 * A derived upload (a crop, a drawn mask, a screenshot) is deferred. An
 * operation whose inputs name it claims it when admitted: within the
 * operation's own studio and account, unclaimed and not expired, at most
 * `operations.max_absorbed_per_operation` (10) rows, in input order; a claim
 * gives back the derived row's 0.5 hold. Claiming happens before the
 * allowance is judged, and a refusal rolls the claim back. When the claimant
 * is counted, every still-deferred row among its inputs is released as
 * `absorbed`; when it is released, only its claims are cleared. Once a
 * deferred row has expired unclaimed (or its claimant has), the sweep counts
 * it in the sweep's own period.
 *
 * Placement: the spec puts these at domain integration (B-46, B-55, B-65 at
 * worker integration). Neither has an integration harness; the sweep cases
 * call the domain sweep the worker job runs.
 */

import { describe, it, expect, beforeAll, afterAll, inject, vi } from "vitest";

vi.mock("ai", () => ({
  generateText: async () => ({ text: "", steps: [], usage: { totalTokens: 0 } }),
  streamText: () => ({ fullStream: (async function* () {})(), text: Promise.resolve(""), usage: Promise.resolve({ totalTokens: 0 }) }),
  stepCountIs: (_n: number) => () => false,
  tool: (config: Record<string, unknown>) => config,
}));

vi.mock("@breatic/shared", async (importOriginal) =>
  (await import("../helpers/ingest-open-double.js")).sharedWithOpenDouble(importOriginal),
);

import crypto from "node:crypto";
import fc from "fast-check";
import postgres from "postgres";
import type { Hono } from "hono";
import { db, initCore, loadLocales } from "@breatic/core";
import { creditHoldService, creditLotService, operationService } from "@breatic/domain";
import {
  ALLOWANCE,
  PAYMENTS_ON,
  admit,
  captureLogs,
  countedRows,
  derivedUpload,
  ledgerRow,
  seedAccount,
  seedAsset,
  ticket,
  stored,
  used,
  type Account,
  type Derived,
} from "./operation-counting-fixtures.js";

let sql: ReturnType<typeof postgres>;
let app: Hono;

beforeAll(async () => {
  initCore(PAYMENTS_ON);
  loadLocales();
  sql = postgres(inject("DATABASE_URL"), { max: 6, prepare: false, connection: { application_name: "operation-derived-claims-test" } });
  app = (await import("@server/app.js")).createApp();
});

afterAll(async () => {
  await sql?.end({ timeout: 1 });
  initCore(process.env);
});

/** `operations.max_absorbed_per_operation` in config/membership.yaml. */
const MAX_ABSORBED = 10;

/**
 * Count an operation in its own success transaction.
 * @param key - Its key.
 */
async function count(key: string): Promise<void> {
  await db.transaction((tx) => operationService.countOperation(key, tx));
}

/**
 * Release an operation in its own transaction.
 * @param key - Its key.
 */
async function release(key: string): Promise<void> {
  await db.transaction((tx) => operationService.releaseOperation(key, tx));
}

/**
 * Move a row's expiry into the past.
 * @param key - Its key.
 */
async function expire(key: string): Promise<void> {
  await sql`update operation_ledger set expires_at = now() - interval '1 second' where operation_key = ${key}`;
}

/**
 * The credit hold filed for one operation.
 * @param key - The operation key.
 * @returns Its status, or undefined.
 */
async function holdOf(key: string): Promise<string | undefined> {
  const [row] = await sql<{ status: string }[]>`select status from credit_holds where reference_id = ${`operation:${key}`}`;
  return row?.status;
}

/**
 * A deferred row written directly for an asset, as a derived upload leaves it.
 * @param a - Whose.
 * @param assetId - The asset.
 * @returns Its key.
 */
async function deferredRow(a: Account, assetId: string): Promise<string> {
  const key = `upload:${a.userId}:${crypto.randomUUID()}`;
  await sql`insert into operation_ledger(operation_key, kind, account_user_id, studio_id, project_id, actor_user_id, status, admitted_as, asset_id, expires_at, created_at)
    values (${key}, 'upload', ${a.userId}, ${a.studioId}, ${a.projectId}, ${a.userId}, 'deferred', 'covered', ${assetId}, now() + interval '2 hours', now())`;
  return key;
}

describe("B.3 the expiry sweep", () => {
  it("B-46 a crop nothing used is counted by the sweep once it expires, with an audit line", async () => {
    const a = await seedAccount(sql);
    const logs = captureLogs("operation-derived-b46");
    const d4 = await derivedUpload(app, sql, a);
    await expire(d4.key);
    await operationService.sweepDeferredOperations();
    const row = await ledgerRow(sql, d4.key);
    expect(row).toMatchObject({ status: "counted", slot: "allowance" });
    expect(row?.period_start?.toISOString()).toBe(a.periodStart.toISOString());
    expect(await used(a)).toBe(1);
    expect(logs("operation_deferred_counted")).toContainEqual(expect.objectContaining({ operationKey: d4.key }));
  });

  it("B-53 a crop claimed by a message still waiting on a renewed lease is skipped, then used up when the message counts", async () => {
    const a = await seedAccount(sql);
    const d1 = await derivedUpload(app, sql, a);
    const { key: message } = await admit(a, "chat_message", [d1.url], `chat:${a.userId}:${crypto.randomUUID()}`);
    await expire(d1.key);
    // Three hours on: the message's lease was renewed and runs past now.
    await sql`update operation_ledger set expires_at = now() + interval '1 hour' where operation_key = ${message}`;
    await operationService.sweepDeferredOperations();
    expect((await ledgerRow(sql, d1.key))?.status).toBe("deferred");
    await count(message);
    expect(await ledgerRow(sql, d1.key)).toMatchObject({ status: "released", release_reason: "absorbed" });
    expect(await used(a)).toBe(1);
  });

  it("B-54 a crop claimed by a container task inside its report grace is skipped, then used up when the task succeeds", async () => {
    const a = await seedAccount(sql);
    const d1 = await derivedUpload(app, sql, a);
    const { key: task } = await admit(a, "tool_run", [d1.url]);
    await expire(d1.key);
    // Past the task's deadline, inside the grace for its last report.
    await sql`update operation_ledger set expires_at = now() + interval '5 seconds' where operation_key = ${task}`;
    await operationService.sweepDeferredOperations();
    expect((await ledgerRow(sql, d1.key))?.status).toBe("deferred");
    await count(task);
    expect(await ledgerRow(sql, d1.key)).toMatchObject({ status: "released", release_reason: "absorbed" });
  });

  it("B-55 a sweep after the claimant counted finds the crop used up and counts nothing", async () => {
    const a = await seedAccount(sql);
    const d1 = await derivedUpload(app, sql, a);
    const { key: task } = await admit(a, "generation", [d1.url]);
    await expire(d1.key);
    await operationService.sweepDeferredOperations();
    expect((await ledgerRow(sql, d1.key))?.status).toBe("deferred");
    await count(task);
    const usedUp = await ledgerRow(sql, d1.key);
    await operationService.sweepDeferredOperations();
    expect(await ledgerRow(sql, d1.key)).toEqual(usedUp);
    expect(usedUp?.status).toBe("released");
    expect(await used(a)).toBe(1);
  });

  it("B-65 a crop left unclaimed past the allowance is counted as overage and charged 0.5, into debt", async () => {
    const a = await seedAccount(sql, { credits: 0 });
    const d1 = await derivedUpload(app, sql, a);
    await countedRows(sql, a, ALLOWANCE);
    await expire(d1.key);
    await operationService.sweepDeferredOperations();
    expect(await ledgerRow(sql, d1.key)).toMatchObject({ status: "counted", slot: "overage" });
    const requests = await sql<{ id: string; kind: string; amount: string }[]>`select id, kind, amount::text from credit_charge_requests where reference_id = ${d1.key}`;
    expect(requests).toEqual([{ id: expect.any(String), kind: "operation_overage", amount: "0.500000" }]);
    await creditLotService.settleCharge(requests[0]!.id);
    expect(Number((await creditHoldService.getCreditPosition(a.studioId)).spendable)).toBeCloseTo(-0.5, 6);
  });
});

describe("B.3 whose rows a run may claim", () => {
  it("B-56 a run claims only its own studio's row for a storage key another studio also holds", async () => {
    const a = await seedAccount(sql);
    const other = await seedAccount(sql);
    const mine = await seedAsset(sql, a.studioId, a.userId);
    const theirs = await seedAsset(sql, other.studioId, other.userId, "image", mine.storageKey);
    const myRow = await deferredRow(a, mine.id);
    const theirRow = await deferredRow(other, theirs.id);
    const { key } = await admit(a, "generation", [mine.url]);
    expect((await ledgerRow(sql, myRow))?.absorbed_by).toBe(key);
    const before = await ledgerRow(sql, theirRow);
    expect(before?.absorbed_by).toBeNull();
    await count(key);
    expect((await ledgerRow(sql, myRow))?.status).toBe("released");
    expect(await ledgerRow(sql, theirRow)).toEqual(before);
  });

  it("B-57 a crop made in this studio of a picture pasted from another studio is deferred and claimed as usual", async () => {
    const a = await seedAccount(sql);
    const other = await seedAccount(sql);
    const pasted = await seedAsset(sql, other.studioId, other.userId);
    const crop = await ticket(app, a, { derived: true, space_id: a.spaceId, client_hash: pasted.hash });
    expect(crop.res.status).toBe(201);
    await stored(crop.storageKey!, "image/png", pasted.hash);
    expect((await ledgerRow(sql, crop.key))?.status).toBe("deferred");
    const [asset] = await sql<{ storage_key: string }[]>`select storage_key from studio_assets where studio_id = ${a.studioId} and content_hash = ${pasted.hash}`;
    const { getStorageAdapter } = await import("@breatic/core");
    const { key } = await admit(a, "generation", [(await getStorageAdapter()).publicUrl(asset!.storage_key)]);
    await count(key);
    expect(await ledgerRow(sql, crop.key)).toMatchObject({ status: "released", release_reason: "absorbed" });
  });

  it("B-58 another account's run naming the same address claims nothing", async () => {
    const a = await seedAccount(sql);
    const stranger = await seedAccount(sql);
    const d1 = await derivedUpload(app, sql, a);
    await admit(stranger, "generation", [d1.url]);
    expect(await ledgerRow(sql, d1.key)).toMatchObject({ status: "deferred", absorbed_by: null });
  });

  it("B-64 a run naming three images, two of them derived, claims those two", async () => {
    const a = await seedAccount(sql);
    const plain = await seedAsset(sql, a.studioId, a.userId);
    const d1 = await derivedUpload(app, sql, a);
    const d2 = await derivedUpload(app, sql, a);
    const { key } = await admit(a, "generation", [plain.url, d1.url, d2.url]);
    const claimed = await sql`select operation_key from operation_ledger where absorbed_by = ${key}`;
    expect(claimed).toHaveLength(2);
    expect(claimed.length).toBeLessThanOrEqual(Math.min(3, MAX_ABSORBED));
  });

  it("B-64 a run naming more images than it may use, some twice and some not ours, claims the first ten in the order named", async () => {
    const a = await seedAccount(sql);
    const crops: Derived[] = [];
    for (let i = 0; i < MAX_ABSORBED + 2; i++) crops.push(await derivedUpload(app, sql, a));
    const named = [crops[0]!.url, crops[0]!.url, "https://elsewhere.example/picture.png", ...crops.slice(1).map((c) => c.url)];
    const { key } = await admit(a, "generation", named);
    const claimed = await sql<{ operation_key: string }[]>`select operation_key from operation_ledger where absorbed_by = ${key}`;
    expect(claimed.map((row) => row.operation_key).sort()).toEqual(crops.slice(0, MAX_ABSORBED).map((c) => c.key).sort());
  });
});

describe("B.3 claiming against the allowance and the 0.5 holds", () => {
  it("B-59 with one operation left and a covered crop waiting, a run using the crop is covered and the pair counts once", async () => {
    const a = await seedAccount(sql, { used: ALLOWANCE - 1, credits: 0 });
    const d1 = await derivedUpload(app, sql, a);
    expect((await ledgerRow(sql, d1.key))?.admitted_as).toBe("covered");
    const { key, answer } = await admit(a, "generation", [d1.url]);
    expect(answer).toMatchObject({ kind: "covered" });
    await count(key);
    expect(await used(a)).toBe(ALLOWANCE);
    expect(await ledgerRow(sql, d1.key)).toMatchObject({ status: "released", release_reason: "absorbed" });
  });

  it("B-60 a run claiming a held crop gives the crop's 0.5 back and holds its own, leaving one operation hold", async () => {
    const a = await seedAccount(sql, { used: ALLOWANCE, credits: 0.7 });
    const d1 = await derivedUpload(app, sql, a);
    expect(await ledgerRow(sql, d1.key)).toMatchObject({ admitted_as: "held" });
    const { key, answer } = await admit(a, "generation", [d1.url]);
    expect(answer).toMatchObject({ kind: "held" });
    expect(await ledgerRow(sql, d1.key)).toMatchObject({ absorbed_by: key, absorbed_hold_released: true });
    expect(await holdOf(d1.key)).toBe("released");
    const live = await sql`select 1 from credit_holds where studio_id = ${a.studioId} and reference_id like 'operation:%' and status = 'held' and expires_at > now()`;
    expect(live).toHaveLength(1);
  });

  it("B-61 a refusal after claiming rolls the claim and the given-back hold back", async () => {
    const a = await seedAccount(sql, { used: ALLOWANCE, credits: 0.5 });
    const d1 = await derivedUpload(app, sql, a);
    expect(await holdOf(d1.key)).toBe("held");
    // The studio now holds 0.4 counting what d1 holds.
    await sql`update credit_lots set remaining_credits = 0.4 where designated_studio_id = ${a.studioId}`;
    const { answer } = await admit(a, "generation", [d1.url]);
    expect(answer).toMatchObject({ kind: "refused" });
    expect(await ledgerRow(sql, d1.key)).toMatchObject({ absorbed_by: null, absorbed_hold_released: false });
    expect(await holdOf(d1.key)).toBe("held");
  });

  it("B-62 a claimant that fails leaves its crop unclaimed with no hold; swept over the allowance it is charged with no hold to release", async () => {
    const a = await seedAccount(sql, { used: ALLOWANCE, credits: 0.5 });
    const d1 = await derivedUpload(app, sql, a);
    const { key: g1 } = await admit(a, "generation", [d1.url]);
    await release(g1);
    expect(await ledgerRow(sql, d1.key)).toMatchObject({ status: "deferred", absorbed_by: null, absorbed_hold_released: true });
    expect(await holdOf(d1.key)).toBe("released");
    await expire(d1.key);
    await operationService.sweepDeferredOperations();
    expect(await ledgerRow(sql, d1.key)).toMatchObject({ status: "counted", slot: "overage" });
    const requests = await sql<{ release_hold: string | null }[]>`select release_hold from credit_charge_requests where reference_id = ${d1.key} and kind = 'operation_overage'`;
    expect(requests).toEqual([{ release_hold: null }]);
  });
});

describe("B-72 a key that already has a row is taken, whatever its state", () => {
  it.each(["reserved", "deferred", "counted", "released"])("%s", async (state) => {
    const a = await seedAccount(sql, { used: ALLOWANCE, credits: 3 });
    let key: string;
    if (state === "deferred") key = (await derivedUpload(app, sql, a)).key;
    else {
      key = (await admit(a, "upload", [], `upload:${a.userId}:${crypto.randomUUID()}`)).key;
      if (state === "counted") await count(key);
      if (state === "released") await release(key);
    }
    const holdsBefore = await sql`select reference_id, status from credit_holds where studio_id = ${a.studioId} order by reference_id`;
    const { answer } = await admit(a, "upload", [], key);
    expect(answer).toMatchObject({ kind: "taken" });
    expect(await sql`select 1 from operation_ledger where operation_key = ${key}`).toHaveLength(1);
    expect(await sql`select reference_id, status from credit_holds where studio_id = ${a.studioId} order by reference_id`).toEqual(holdsBefore);
  });
});

/** One operation of a property run: which derived images it names, and how it ends. */
interface PlannedOperation {
  inputs: number[];
  /** Also name the other studio's image with the same storage key. */
  foreign: boolean;
  outcome: "succeed" | "fail" | "expire";
}

describe("PT-6 derived images claimed and used up", () => {
  it("every derived image ends used up by a counted operation of its own studio and account, or counted itself; no operation takes more than ten", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 0, max: 20 }),
        fc.array(
          fc.record({
            inputs: fc.array(fc.nat({ max: 19 }), { maxLength: 15 }),
            foreign: fc.boolean(),
            outcome: fc.constantFrom<PlannedOperation["outcome"]>("succeed", "fail", "expire"),
          }),
          { minLength: 1, maxLength: 6 },
        ),
        async (derivedCount, plan) => {
          const a = await seedAccount(sql, { credits: 100 });
          const other = await seedAccount(sql);
          const images: Array<Derived & { foreignUrl: string }> = [];
          for (let i = 0; i < derivedCount; i++) {
            const asset = await seedAsset(sql, a.studioId, a.userId);
            const foreign = await seedAsset(sql, other.studioId, other.userId, "image", asset.storageKey);
            await deferredRow(other, foreign.id);
            images.push({ key: await deferredRow(a, asset.id), assetId: asset.id, url: asset.url, foreignUrl: foreign.url });
          }
          const keys: string[] = [];
          for (const op of plan) {
            const named = op.inputs.filter((i) => i < images.length).map((i) => images[i]!.url);
            const { key } = await admit(a, "generation", op.foreign && images.length > 0 ? [...named, images[0]!.foreignUrl] : named);
            keys.push(key);
            // I8: what a live operation holds claimed is bounded.
            const [claimed] = await sql<{ n: number }[]>`select count(*)::int as n from operation_ledger where absorbed_by = ${key}`;
            expect(claimed!.n).toBeLessThanOrEqual(Math.min(named.length + (op.foreign ? 1 : 0), MAX_ABSORBED));
          }
          for (const [i, op] of plan.entries()) {
            if (op.outcome === "succeed") await count(keys[i]!);
            else if (op.outcome === "fail") await release(keys[i]!);
            else await expire(keys[i]!);
          }
          await sql`update operation_ledger set expires_at = now() - interval '1 second' where studio_id = ${a.studioId} and status = 'deferred'`;
          await operationService.sweepDeferredOperations();

          const rows = await sql<Array<{ operation_key: string; status: string; release_reason: string | null; asset_id: string | null }>>`
            select operation_key, status, release_reason, asset_id from operation_ledger where operation_key in ${sql(images.length > 0 ? images.map((d) => d.key) : ["none"])}`;
          const ops = await sql<Array<{ operation_key: string; status: string; input_asset_ids: string[]; studio_id: string; account_user_id: string }>>`
            select operation_key, status, input_asset_ids, studio_id, account_user_id from operation_ledger where operation_key in ${sql(keys)}`;
          for (const op of ops) {
            expect(op.input_asset_ids.length).toBeLessThanOrEqual(MAX_ABSORBED);
            const [usedUp] = await sql<{ n: number }[]>`select count(*)::int as n from operation_ledger where release_reason = 'absorbed' and asset_id = any(${op.input_asset_ids}::uuid[]) and studio_id = ${a.studioId}`;
            expect(usedUp!.n).toBeLessThanOrEqual(MAX_ABSORBED);
          }
          for (const row of rows) {
            // Every derived image ends one of two ways.
            expect(row.status === "counted" || (row.status === "released" && row.release_reason === "absorbed")).toBe(true);
            // I7: used up only by a counted operation of the same studio and account that took it as input.
            if (row.release_reason === "absorbed") {
              expect(ops.some((op) => op.status === "counted" && op.studio_id === a.studioId && op.account_user_id === a.userId && op.input_asset_ids.includes(row.asset_id!))).toBe(true);
            }
          }
          // The other studio's rows are never touched by these operations.
          const theirs = await sql`select 1 from operation_ledger where studio_id = ${other.studioId} and release_reason = 'absorbed'`;
          expect(theirs).toEqual([]);
        },
      ),
      { numRuns: 100 },
    );
  }, 600_000);
});

/** One step of a PT-2 run over a small set of keys. */
type Step = { op: "admit" | "succeed" | "succeedTwice" | "fail" | "expire"; key: number };

describe("PT-2 the ledger state machine (the invariants area B relies on)", () => {
  it("a key has at most one row, counts at most once, and neither a counted nor a released row moves again", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 0, max: 5 }),
        fc.constantFrom(0, 0.4, 0.5, 0.7, 3),
        fc.array(fc.record({ op: fc.constantFrom<Step["op"]>("admit", "succeed", "succeedTwice", "fail", "expire"), key: fc.nat({ max: 3 }) }), { minLength: 1, maxLength: 12 }),
        async (filled, credits, steps) => {
          const a = await seedAccount(sql, { used: Math.max(0, ALLOWANCE - filled), credits });
          const keys = [0, 1, 2, 3].map(() => `task:${crypto.randomUUID()}`);
          const settled = new Map<string, Record<string, unknown>>();
          for (const step of steps) {
            const key = keys[step.key]!;
            if (step.op === "admit") await admit(a, "generation", [], key);
            else if (step.op === "succeed") await count(key);
            else if (step.op === "succeedTwice") { await count(key); await count(key); }
            else if (step.op === "fail") await release(key);
            else await expire(key);
            for (const k of keys) {
              const rows = await sql<Array<Record<string, unknown>>>`
                select status, slot, period_start, counted_at, charge_request_id, released_at from operation_ledger where operation_key = ${k}`;
              // I1: at most one row per key.
              expect(rows.length).toBeLessThanOrEqual(1);
              const row = rows[0];
              if (row === undefined) continue;
              // I2: a counted row, and a released row's status, never change once reached.
              const before = settled.get(k);
              if (before !== undefined) expect(before.status === "released" ? { status: row.status } : row).toEqual(before.status === "released" ? { status: "released" } : before);
              else if (row.status === "counted") settled.set(k, row);
              else if (row.status === "released") settled.set(k, { status: "released" });
              // I5: a released row carries no charge and has no overage request.
              if (row.status === "released") {
                expect(row.charge_request_id).toBeNull();
                expect(await sql`select 1 from credit_charge_requests where kind = 'operation_overage' and reference_id = ${k}`).toEqual([]);
              }
            }
          }
        },
      ),
      { numRuns: 100 },
    );
  }, 600_000);
});
