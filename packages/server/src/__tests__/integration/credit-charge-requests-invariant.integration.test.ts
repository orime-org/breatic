// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * The charge-request invariants under any order of events (inner#1617).
 *
 * One delivery per run, driven through a random sequence of the events that
 * can reach it: the delivery committing, a delivery rolled back by a crash, a
 * redelivery, the delivering process settling at once, the process dying
 * before it does, a settlement failing, and the sweep. After every step and at
 * the end the invariants hold:
 *
 *   I1  delivered ⇔ exactly one request row; never two.
 *   I2  the ledger's spend and debt rows for the delivery sum to minus the
 *       amount when the row is settled, and to zero while it is pending.
 *   I3  once the database works again, the sweep leaves the row settled, and
 *       the amount was booked exactly once.
 *   I4  a canvas run's hold is held while its request is pending and released
 *       once it is settled.
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

import { randomUUID } from "node:crypto";
import fc from "fast-check";
import postgres from "postgres";
import { db, initCore, loadLocales } from "@breatic/core";
import { creditHoldService, creditLotService, taskService } from "@breatic/domain";
import {
  seedDesignatedLot,
  seedStudioFixture,
  type StudioFixture,
} from "@server/__tests__/integration/studio-credit-fixtures.js";

const APP = "credit-charge-invariant-test";

let sql: ReturnType<typeof postgres>;

beforeAll(() => {
  initCore({
    ...process.env,
    PAYMENT_ENABLED: "true",
    STRIPE_SECRET_KEY: "sk_test_unused_by_this_suite",
    STRIPE_WEBHOOK_SECRET: "whsec_unused_by_this_suite",
  });
  loadLocales();
  sql = postgres(inject("DATABASE_URL"), { max: 6, prepare: false, connection: { application_name: APP } });
});

afterAll(async () => {
  await sql?.end({ timeout: 1 });
  initCore(process.env);
});

type Kind = "task" | "timeline_execution" | "operation";
type Event = "deliver" | "crashDuringDeliver" | "settleNow" | "crash" | "settleFails" | "sweep";

/** What the delivering process still remembers, and what the database should hold. */
interface Run {
  kind: Kind;
  fx: StudioFixture;
  referenceId: string;
  amount: number;
  description: string;
  /** The id the delivering process holds in memory; lost when it crashes. */
  inMemory: string | null;
  delivered: boolean;
}

/**
 * The request rows of this run's delivery.
 * @param run - The run.
 * @returns Id, status and attempts of each.
 */
async function rowsOf(run: Run): Promise<{ id: string; status: string; attempts: number }[]> {
  return sql<{ id: string; status: string; attempts: number }[]>`
    SELECT id, status, attempts FROM credit_charge_requests
    WHERE kind = ${run.kind} AND actor_user_id = ${run.fx.userId} AND reference_id = ${run.referenceId}
  `;
}

/**
 * What the ledger booked for this run's delivery: spend plus debt.
 * @param run - The run.
 * @returns The sum, as a number of credits (negative for a charge).
 */
async function bookedFor(run: Run): Promise<number> {
  const [row] = await sql<{ total: string }[]>`
    SELECT COALESCE(SUM(amount), 0)::text AS total FROM credit_ledger
    WHERE reference_id = ${run.referenceId} AND entry_type IN ('spend', 'debt_incurred')
  `;
  return Number(row!.total);
}

/**
 * Commit the delivery fact with its request, the way each path does.
 * @param run - The run.
 * @returns The new request's id, or null when the delivery was already committed.
 */
async function commitDelivery(run: Run): Promise<string | null> {
  const charge = {
    actorUserId: run.fx.userId,
    projectId: run.fx.projectId,
    amount: run.amount,
    description: run.description,
  };
  if (run.kind === "task") {
    const won = await taskService.markCompletedAndBill(run.referenceId, {}, run.amount, 1, { ...charge, releaseHold: run.referenceId });
    return won ? creditLotService.pendingChargeRequestId("task", run.fx.userId, run.referenceId) : null;
  }
  return db.transaction((tx) => creditLotService.requestCharge({ ...charge, kind: run.kind, referenceId: run.referenceId }, tx));
}

/**
 * Settle the run's row through the sweep, if the sweep lists it.
 * @param run - The run.
 * @returns Whether the sweep listed it.
 */
async function sweep(run: Run): Promise<boolean> {
  const listed = await creditLotService.listSweepableChargeRequests(0, 100_000);
  const [mine] = await rowsOf(run);
  if (!mine || !listed.includes(mine.id)) return false;
  await creditLotService.settleCharge(mine.id);
  return true;
}

/**
 * Apply one event and check what it did.
 * @param run - The run.
 * @param event - The event.
 */
async function apply(run: Run, event: Event): Promise<void> {
  const [before] = await rowsOf(run);
  switch (event) {
    case "deliver": {
      const id = await commitDelivery(run);
      if (run.delivered) {
        expect(id).toBeNull();
      } else {
        expect(id).toMatch(/^[0-9a-f-]{36}$/);
        run.delivered = true;
        run.inMemory = id;
      }
      return;
    }
    case "crashDuringDeliver": {
      await expect(
        db.transaction(async (tx) => {
          await creditLotService.requestCharge(
            { kind: run.kind, referenceId: run.referenceId, actorUserId: run.fx.userId, projectId: run.fx.projectId, amount: run.amount },
            tx,
          );
          throw new Error("process died before the delivery committed");
        }),
      ).rejects.toThrow("process died");
      return;
    }
    case "settleNow": {
      if (run.inMemory === null) return;
      const outcome = await creditLotService.settleCharge(run.inMemory);
      if (before?.status === "pending") expect(outcome).toMatchObject({ billed: true, studioId: run.fx.studioId });
      else expect(outcome).toBeNull();
      return;
    }
    case "crash": {
      run.inMemory = null;
      return;
    }
    case "settleFails": {
      if (!before) return;
      const name = `charge_inv_block_${randomUUID().replaceAll("-", "")}`;
      await sql.unsafe(`ALTER TABLE credit_ledger ADD CONSTRAINT ${name} CHECK (description IS DISTINCT FROM '${run.description}') NOT VALID`);
      try {
        if (before.status === "pending") {
          let failure: unknown = null;
          await creditLotService.settleCharge(before.id).catch((err: unknown) => {
            failure = err;
          });
          expect(failure).toMatchObject({ cause: expect.objectContaining({ message: expect.stringContaining(name) }) });
          await creditLotService.recordSettleFailure(before.id, failure);
          const [after] = await rowsOf(run);
          expect(after).toMatchObject({ status: "pending", attempts: before.attempts + 1 });
        } else {
          // Settled first, so a settlement finds nothing to write and cannot fail.
          expect(await creditLotService.settleCharge(before.id)).toBeNull();
        }
      } finally {
        await sql.unsafe(`ALTER TABLE credit_ledger DROP CONSTRAINT ${name}`);
      }
      return;
    }
    case "sweep": {
      const listed = await sweep(run);
      expect(listed).toBe(before?.status === "pending");
      return;
    }
  }
}

/**
 * Check the invariants that hold after every step.
 * @param run - The run.
 */
async function checkInvariants(run: Run): Promise<void> {
  const rows = await rowsOf(run);
  // I1
  expect(rows).toHaveLength(run.delivered ? 1 : 0);
  // I2
  const settled = rows[0]?.status === "settled";
  expect(await bookedFor(run)).toBeCloseTo(settled ? -run.amount : 0, 6);
  // I4
  if (run.kind === "task") {
    const holds = await sql<{ status: string }[]>`SELECT status FROM credit_holds WHERE reference_id = ${run.referenceId}`;
    expect(holds.map((h) => h.status)).toEqual([settled ? "released" : "held"]);
  }
}

const events = fc.array(
  fc.constantFrom<Event>("deliver", "crashDuringDeliver", "settleNow", "crash", "settleFails", "sweep"),
  { minLength: 1, maxLength: 8 },
);

describe("charge request invariants", () => {
  it("charges a delivered result exactly once and an undelivered one never, for any order of events", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.constantFrom<Kind>("task", "timeline_execution", "operation"),
        fc.integer({ min: 1, max: 150 }),
        events,
        async (kind, amount, sequence) => {
          const fx = await seedStudioFixture(sql, "charge-inv");
          await seedDesignatedLot(sql, fx, 100);
          let referenceId = `inv-${randomUUID()}`;
          if (kind === "task") {
            const [task] = await sql<{ id: string }[]>`
              INSERT INTO tasks (user_id, project_id, space_id, task_type, mode, status)
              VALUES (${fx.userId}, ${fx.projectId}, ${randomUUID()}, 'image', 'overwrite', 'processing')
              RETURNING id
            `;
            referenceId = task!.id;
            const admitted = await creditHoldService.reserveCredits({ projectId: fx.projectId, actorUserId: fx.userId, referenceId, amount: 1, ttlMs: 3_600_000 });
            expect(admitted).toEqual({ ok: true });
          }
          const run: Run = { kind, fx, referenceId, amount, description: `inv-${randomUUID()}`, inMemory: null, delivered: false };

          for (const event of sequence) {
            await apply(run, event);
            await checkInvariants(run);
          }

          // I3: the database works from here on; the sweep finishes the job.
          await sweep(run);
          await checkInvariants(run);
          const rows = await rowsOf(run);
          if (run.delivered) {
            expect(rows.map((r) => r.status)).toEqual(["settled"]);
            expect(await bookedFor(run)).toBeCloseTo(-amount, 6);
          } else {
            expect(rows).toEqual([]);
            expect(await bookedFor(run)).toBe(0);
          }
        },
      ),
      { numRuns: 40 },
    );
  }, 300_000);
});
