// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { sql } from "drizzle-orm";
import { createPgClient, db, initCore, loadLocales, rawPg } from "@breatic/core";
import {
  completeMiniToolConsumptionSet, confirmMiniToolConsumption, miniToolExecutionService, recordMiniToolConsumption, settleMiniToolCharge,
} from "@domain/index.js";
import { seedExecution } from "./execution-lifecycle-fixtures.js";
import { claimExecutionSettlement, executionCompletion, executionIdentity, terminalExecution } from "./execution-step-fixtures.js";

// Every statement a transaction needs must run on that transaction's own connection. With a pool of exactly one
// connection, a call inside the transaction that asks the pool for a second one waits forever, so each case below
// fails on its deadline instead of passing.
const DEADLINE_MS = 15_000;
let pg: ReturnType<typeof createPgClient>;

beforeAll(() => {
  initCore({ ...process.env, PAYMENT_ENABLED: "false", CREDIT_MULTIPLIER: "1", DB_POOL_SIZE: "1" }); loadLocales();
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
    await confirmMiniToolConsumption({ taskId: f.taskId, stepId: i.stepId, identity: i.identity, claim: c.claim, costUsd: 0.3, costSource: "generation_lookup", raw: {} });
    await recordMiniToolConsumption({ taskId: f.taskId, stepId: i.stepId, identity: i.identity, claim: c.claim });
    await terminalExecution(pg, f); await completeMiniToolConsumptionSet(f.taskId);
    await expect(withinDeadline(settleMiniToolCharge(f.taskId))).resolves.toMatchObject({ state: "settled", credits: 30, first: true });
  });
});
