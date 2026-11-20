// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { sql } from "drizzle-orm";
import { createPgClient, db, initCore, loadLocales, rawPg } from "@breatic/core";
import {
  completeMiniToolConsumptionSet, creditHoldService, miniToolExecutionService, recordMiniToolConsumption, settleMiniToolCharge,
} from "@domain/index.js";
import { seedDesignatedLot } from "../../../../server/src/__tests__/integration/studio-credit-fixtures.js";
import { seedExecution } from "./execution-lifecycle-fixtures.js";
import { claimExecutionSettlement, confirmExecutionCost, executionCompletion, executionIdentity, terminalExecution } from "./execution-step-fixtures.js";

// Every statement a transaction needs must run on that transaction's own connection. With a pool of exactly one
// connection, a call inside the transaction that asks the pool for a second one waits forever, so each case below
// fails on its deadline instead of passing.
const DEADLINE_MS = 15_000;
let pg: ReturnType<typeof createPgClient>;
const ONE_CONNECTION = { ...process.env, CREDIT_MULTIPLIER: "1", DB_POOL_SIZE: "1" };

beforeAll(() => {
  initCore({ ...ONE_CONNECTION, PAYMENT_ENABLED: "false" }); loadLocales();
  pg = createPgClient(inject("DATABASE_URL"), { name: "single-connection-fixtures", max: 4 });
});
afterAll(async () => { await pg.end(); initCore(process.env); });

/**
 * Resolve with the call's value, or reject once it has waited past the deadline.
 * @param work - The call under test.
 * @returns What the call resolved with.
 * @throws {Error} When the call is still waiting at the deadline.
 */
async function withinDeadline<T>(work: Promise<T>): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`Still waiting after ${String(DEADLINE_MS)} ms on a one-connection pool`)), DEADLINE_MS);
  });
  try {
    return await Promise.race([work, deadline]);
  } finally {
    clearTimeout(timer);
  }
}

describe("mini-tool transactions on a one-connection pool", () => {
  it("the core pool under test holds exactly one connection", async () => {
    let entered = false;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const held = db.transaction(async (tx) => { await tx.execute(sql`select 1`); entered = true; await gate; });
    await expect.poll(() => entered).toBe(true);
    const outside = rawPg`select 1`.then(() => "answered");
    const first = await Promise.race([outside, new Promise((resolve) => setTimeout(() => resolve("waiting"), 500))]);
    release();
    await held;
    expect(first).toBe("waiting");
    await expect(outside).resolves.toBe("answered");
  });

  it("a terminal commit of a registered output finishes", async () => {
    const f = await seedExecution(pg, "running");
    const { record } = await withinDeadline(miniToolExecutionService.finishMiniToolExecution(f.taskId, executionCompletion(f)));
    expect(record.outputs[0]!.result).toEqual(f.registered);
  });

  it("a progress commit of a registered output finishes", async () => {
    const f = await seedExecution(pg, "running");
    const { record } = await withinDeadline(miniToolExecutionService.commitMiniToolExecutionProgress(f.taskId, {
      planFingerprint: f.plan.planFingerprint, expectedVersion: 0, outputs: [{ ...f.plan.outputs[0]!, result: f.registered, late: false }],
    }));
    expect(record.outputs[0]!.result).toEqual(f.registered);
  });

  it("settling a recorded charge finishes", async () => {
    const f = await seedExecution(pg, "running"); const i = await executionIdentity(f); const c = await claimExecutionSettlement(pg, f);
    await confirmExecutionCost(f, i, c.claim, 0.3);
    await recordMiniToolConsumption({ taskId: f.taskId, stepId: i.stepId, identity: i.identity, claim: c.claim });
    await terminalExecution(pg, f); await completeMiniToolConsumptionSet(f.taskId);
    await expect(withinDeadline(settleMiniToolCharge(f.taskId))).resolves.toMatchObject({ state: "settled", credits: 30, first: true });
  });
});

describe("the paid charge on a one-connection pool", () => {
  beforeAll(() => {
    initCore({ ...ONE_CONNECTION, PAYMENT_ENABLED: "true", STRIPE_SECRET_KEY: "sk_test_unused_by_single_connection", STRIPE_WEBHOOK_SECRET: "whsec_unused_by_single_connection" });
  });
  afterAll(() => { initCore({ ...ONE_CONNECTION, PAYMENT_ENABLED: "false" }); });

  it("settling a recorded charge against a designated lot finishes and spends that lot", async () => {
    const f = await seedExecution(pg, "running"); const lotId = await seedDesignatedLot(pg, f, 1000);
    expect((await creditHoldService.reserveCredits({ projectId: f.projectId, actorUserId: f.userId, referenceId: f.taskId, amount: 30, ttlMs: 7_200_000 })).ok).toBe(true);
    const i = await executionIdentity(f); const c = await claimExecutionSettlement(pg, f);
    await confirmExecutionCost(f, i, c.claim, 0.3);
    await recordMiniToolConsumption({ taskId: f.taskId, stepId: i.stepId, identity: i.identity, claim: c.claim });
    await terminalExecution(pg, f); await completeMiniToolConsumptionSet(f.taskId);
    await expect(withinDeadline(settleMiniToolCharge(f.taskId))).resolves.toMatchObject({ state: "settled", credits: 30, first: true });
    const ledger = await pg<{ entry_type: string; amount: number; lot_id: string | null }[]>`SELECT entry_type,amount::float8 AS amount,lot_id FROM credit_ledger WHERE reference_id=${f.taskId}`;
    expect([...ledger]).toEqual([{ entry_type: "spend", amount: -30, lot_id: lotId }]);
    const [lot] = await pg<{ remaining: number }[]>`SELECT remaining_credits::float8 AS remaining FROM credit_lots WHERE id=${lotId}`;
    expect(lot?.remaining).toBe(970);
    const [hold] = await pg<{ status: string }[]>`SELECT status FROM credit_holds WHERE reference_id=${f.taskId}`;
    expect(hold?.status).toBe("released");
  });
});
