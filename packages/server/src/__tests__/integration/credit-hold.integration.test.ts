// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Credit holds on a real Postgres (inner#1611).
 *
 * What a hold guarantees is decided by locks and transactions: two admissions
 * on one studio must queue on the studio's debt row, and a charge must release
 * its hold in the same commit. A stubbed query builder cannot answer either.
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

import fc from "fast-check";
import postgres from "postgres";
import { createRedisClient, env, initCore, loadLocales } from "@breatic/core";
import { creditsChangedChannel } from "@breatic/shared";
import { creditHoldService, creditLotService } from "@breatic/domain";
import { waitUntilBlockedOn } from "@server/__tests__/integration/lock-probe.js";
import {
  seedDesignatedLot,
  seedStudioFixture,
  type StudioFixture,
} from "@server/__tests__/integration/studio-credit-fixtures.js";

const APP = "credit-hold-test";
const HOUR = 3_600_000;

let sql: ReturnType<typeof postgres>;

/**
 * Turn payments on or off for what follows.
 * @param enabled - Whether payments are on.
 */
function payments(enabled: boolean): void {
  initCore({
    ...process.env,
    PAYMENT_ENABLED: enabled ? "true" : "false",
    STRIPE_SECRET_KEY: "sk_test_unused_by_this_suite",
    STRIPE_WEBHOOK_SECRET: "whsec_unused_by_this_suite",
  });
}

beforeAll(() => {
  payments(true);
  loadLocales();
  sql = postgres(inject("DATABASE_URL"), { max: 6, prepare: false, connection: { application_name: APP } });
});

afterAll(async () => {
  await sql?.end({ timeout: 1 });
  initCore(process.env);
});

/**
 * A studio with one designated purchase.
 * @param credits - What the purchase grants.
 * @returns The fixture.
 */
async function studioWith(credits: number): Promise<StudioFixture> {
  const fx = await seedStudioFixture(sql, "hold");
  await seedDesignatedLot(sql, fx, credits);
  return fx;
}

/**
 * A hold request for a fixture.
 * @param fx - Whose studio.
 * @param referenceId - The hold's key.
 * @param amount - How much to hold.
 * @returns The request.
 */
function req(fx: StudioFixture, referenceId: string, amount: number): creditHoldService.HoldRequest {
  return { projectId: fx.projectId, actorUserId: fx.userId, referenceId, amount, ttlMs: HOUR };
}

/**
 * Rows of one reference.
 * @param referenceId - The key.
 * @returns Its rows.
 */
async function holdRows(referenceId: string): Promise<{ status: string; amount: string }[]> {
  return sql<{ status: string; amount: string }[]>`
    SELECT status, amount::text AS amount FROM credit_holds WHERE reference_id = ${referenceId}
  `;
}

let key = 0;
/**
 * A reference id no other case uses.
 * @param label - What it stands for.
 * @returns The key.
 */
function ref(label: string): string {
  return `${label}-${key++}-${Date.now()}`;
}

/**
 * Hold a studio's debt row from a separate connection until released.
 * @param studioId - The studio.
 * @returns A function that lets go.
 */
async function holdDebtLock(studioId: string): Promise<() => Promise<void>> {
  const gate = postgres(inject("DATABASE_URL"), { max: 1, prepare: false, connection: { application_name: `${APP}-gate` } });
  let release: () => void = () => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  let acquired: () => void = () => {};
  const lockHeld = new Promise<void>((resolve) => {
    acquired = resolve;
  });
  await sql`INSERT INTO studio_credit_debts (studio_id, amount) VALUES (${studioId}, 0) ON CONFLICT (studio_id) DO NOTHING`;
  const done = gate.begin(async (tx) => {
    await tx`SELECT id FROM studio_credit_debts WHERE studio_id = ${studioId} FOR UPDATE`;
    acquired();
    await held;
  });
  await lockHeld;
  return async () => {
    release();
    await done;
    await gate.end({ timeout: 1 });
  };
}

describe("credit_holds schema", () => {
  it("rejects a status outside held and released, a negative amount, and a release without its time", async () => {
    const fx = await studioWith(10);
    const insert = (status: string, amount: string, releasedAt: Date | null): Promise<unknown> => sql`
      INSERT INTO credit_holds (studio_id, actor_user_id, reference_id, amount, status, expires_at, released_at)
      VALUES (${fx.studioId}, ${fx.userId}, ${ref("schema")}, ${amount}, ${status}, now() + interval '1 hour', ${releasedAt})
    `;
    await expect(insert("pending", "1", null)).rejects.toThrow(/credit_holds_status_check/);
    await expect(insert("held", "-1", null)).rejects.toThrow(/credit_holds_amount_check/);
    await expect(insert("released", "1", null)).rejects.toThrow(/credit_holds_released_at_check/);
    await expect(insert("held", "1", new Date())).rejects.toThrow(/credit_holds_released_at_check/);
  });

  it("allows one row per reference", async () => {
    const fx = await studioWith(10);
    const reference = ref("unique");
    const insert = (): Promise<unknown> => sql`
      INSERT INTO credit_holds (studio_id, actor_user_id, reference_id, amount, expires_at)
      VALUES (${fx.studioId}, ${fx.userId}, ${reference}, 1, now() + interval '1 hour')
    `;
    await insert();
    await expect(insert()).rejects.toThrow(/credit_holds_reference_id_idx/);
  });
});

describe("reserveCredits", () => {
  it("admits what fits and counts it against the next admission", async () => {
    const fx = await studioWith(100);
    expect(await creditHoldService.reserveCredits(req(fx, ref("a"), 80))).toEqual({ ok: true });
    expect(await creditHoldService.reserveCredits(req(fx, ref("b"), 30))).toEqual({
      ok: false,
      studioId: fx.studioId,
      spendable: 100,
      held: 80,
      available: 20,
    });
    expect(await creditHoldService.getCreditPosition(fx.studioId)).toEqual({ spendable: 100, held: 80, available: 20 });
  });

  it("lets exactly one of two concurrent admissions through when only one fits", async () => {
    const fx = await studioWith(100);
    const open = await holdDebtLock(fx.studioId);
    const first = creditHoldService.reserveCredits(req(fx, ref("c1"), 60));
    await waitUntilBlockedOn(sql, ["studio_credit_debts", "for update"], 1);
    const second = creditHoldService.reserveCredits(req(fx, ref("c2"), 60));
    await waitUntilBlockedOn(sql, ["studio_credit_debts", "for update"], 2);
    await open();
    const outcomes = await Promise.all([first, second]);
    expect(outcomes.filter((o) => o.ok)).toHaveLength(1);
    expect((await creditHoldService.getCreditPosition(fx.studioId)).held).toBe(60);
  });

  it("subtracts debt before deciding", async () => {
    const fx = await studioWith(100);
    await creditLotService.chargeForGeneration({ projectId: fx.projectId, actorUserId: fx.userId, amount: 130 });
    expect(await creditHoldService.reserveCredits(req(fx, ref("debt"), 1))).toEqual({
      ok: false,
      studioId: fx.studioId,
      spendable: -30,
      held: 0,
      available: -30,
    });
  });

  it("reads nothing available when a charge above its hold leaves the others' holds larger than the balance", async () => {
    const fx = await studioWith(100);
    const a = ref("over-a");
    await creditHoldService.reserveCredits(req(fx, a, 50));
    await creditHoldService.reserveCredits(req(fx, ref("over-b"), 45));
    await creditLotService.chargeForGeneration({ projectId: fx.projectId, actorUserId: fx.userId, amount: 60, releaseHold: a });
    expect(await creditHoldService.getCreditPosition(fx.studioId)).toEqual({ spendable: 40, held: 45, available: 0 });
    expect(await creditHoldService.reserveCredits(req(fx, ref("over-c"), 1))).toEqual({
      ok: false,
      studioId: fx.studioId,
      spendable: 40,
      held: 45,
      available: 0,
    });
  });

  it("rejects a key that already has a hold, held or released", async () => {
    // Every admission's key is a task id minted for that request, so a second
    // reservation under one is a caller bug the unique index reports.
    const fx = await studioWith(100);
    const held = ref("held-again");
    await creditHoldService.reserveCredits(req(fx, held, 10));
    await expect(creditHoldService.reserveCredits(req(fx, held, 10))).rejects.toThrow();

    const released = ref("released-again");
    await creditHoldService.reserveCredits(req(fx, released, 10));
    await creditHoldService.releaseHold(released);
    await expect(creditHoldService.reserveCredits(req(fx, released, 10))).rejects.toThrow();
    expect(await holdRows(held)).toEqual([{ status: "held", amount: "10.000000" }]);
  });

  it("stops counting a hold once it expires", async () => {
    const fx = await studioWith(100);
    const reference = ref("ttl");
    await creditHoldService.reserveCredits(req(fx, reference, 90));
    await sql`UPDATE credit_holds SET expires_at = now() - interval '1 second' WHERE reference_id = ${reference}`;
    expect(await creditHoldService.getCreditPosition(fx.studioId)).toEqual({ spendable: 100, held: 0, available: 100 });
    expect(await creditHoldService.reserveCredits(req(fx, ref("after"), 90))).toEqual({ ok: true });
  });

  it("admits without writing a row while payments are off", async () => {
    const fx = await studioWith(0);
    const reference = ref("off");
    payments(false);
    try {
      expect(await creditHoldService.reserveCredits(req(fx, reference, 1_000))).toEqual({ ok: true });
    } finally {
      payments(true);
    }
    expect(await sql`SELECT 1 FROM credit_holds WHERE studio_id = ${fx.studioId}`).toHaveLength(0);
  });
});

describe("releaseHold", () => {
  it("releases once and ignores a second release or an unknown key", async () => {
    const fx = await studioWith(100);
    const reference = ref("rel");
    await creditHoldService.reserveCredits(req(fx, reference, 10));
    await creditHoldService.releaseHold(reference);
    await creditHoldService.releaseHold(reference);
    await creditHoldService.releaseHold(ref("unknown"));
    expect(await holdRows(reference)).toEqual([{ status: "released", amount: "10.000000" }]);
  });
});

describe("chargeForGeneration with a hold", () => {
  it("releases the hold and charges the actual amount in one commit, beyond the hold if needed", async () => {
    const fx = await studioWith(100);
    const reference = ref("task");
    await creditHoldService.reserveCredits(req(fx, reference, 50));
    const outcome = await creditLotService.chargeForGeneration({
      projectId: fx.projectId,
      actorUserId: fx.userId,
      amount: 70,
      referenceId: reference,
      releaseHold: reference,
    });
    expect(outcome.charged).toBe(70);
    expect(await holdRows(reference)).toEqual([{ status: "released", amount: "50.000000" }]);
    expect(await creditHoldService.getCreditPosition(fx.studioId)).toEqual({ spendable: 30, held: 0, available: 30 });
  });

  it("tells the project's readers once the charge has committed", async () => {
    const fx = await studioWith(100);
    const subscriber = createRedisClient(env.REDIS_STREAM_URL, { name: "credit-hold-test-sub" });
    try {
      const heard = new Promise<string>((resolve, reject) => {
        subscriber.on("message", (_channel, raw: string) => resolve(raw));
        setTimeout(() => reject(new Error("no credits:changed within 5s")), 5_000);
      });
      await subscriber.subscribe(creditsChangedChannel(env.REDIS_KEY_PREFIX, fx.projectId));
      await creditLotService.chargeForGeneration({ projectId: fx.projectId, actorUserId: fx.userId, amount: 10 });
      expect(JSON.parse(await heard)).toMatchObject({ type: "project-credits:changed", projectId: fx.projectId });
    } finally {
      subscriber.disconnect();
    }
  });

  it("keeps the hold when the charge fails", async () => {
    const fx = await studioWith(100);
    const reference = ref("boom");
    await creditHoldService.reserveCredits(req(fx, reference, 50));
    await sql`ALTER TABLE credit_ledger ADD CONSTRAINT credit_hold_test_block CHECK (description IS DISTINCT FROM 'credit-hold-boom') NOT VALID`;
    try {
      await expect(
        creditLotService.chargeForGeneration({
          projectId: fx.projectId,
          actorUserId: fx.userId,
          amount: 20,
          description: "credit-hold-boom",
          releaseHold: reference,
        }),
      ).rejects.toThrow();
    } finally {
      await sql`ALTER TABLE credit_ledger DROP CONSTRAINT credit_hold_test_block`;
    }
    expect(await holdRows(reference)).toEqual([{ status: "held", amount: "50.000000" }]);
  });

  it("releases the hold while payments are off", async () => {
    const fx = await studioWith(100);
    const reference = ref("off-charge");
    await creditHoldService.reserveCredits(req(fx, reference, 10));
    payments(false);
    try {
      await creditLotService.chargeForGeneration({
        projectId: fx.projectId,
        actorUserId: fx.userId,
        amount: 5,
        releaseHold: reference,
      });
    } finally {
      payments(true);
    }
    expect(await holdRows(reference)).toEqual([{ status: "released", amount: "10.000000" }]);
  });
});

describe("hold invariant", () => {
  it("never lets admitted holds exceed what the studio can spend", async () => {
    // I1: whenever an admission succeeds, the holds still counted
    // add up to no more than the purchases less the debt.
    const op = fc.oneof(
      fc.record({ kind: fc.constant("reserve" as const), amount: fc.integer({ min: 1, max: 80 }) }),
      fc.record({ kind: fc.constant("release" as const), slot: fc.integer({ min: 0, max: 5 }) }),
      fc.record({ kind: fc.constant("charge" as const), slot: fc.integer({ min: 0, max: 5 }), amount: fc.integer({ min: 0, max: 60 }) }),
    );
    await fc.assert(
      fc.asyncProperty(fc.array(op, { minLength: 1, maxLength: 12 }), async (ops) => {
        const fx = await studioWith(100);
        const keys: string[] = [];
        for (const o of ops) {
          let admitted = false;
          if (o.kind === "reserve") {
            const k = ref("p");
            keys.push(k);
            admitted = (await creditHoldService.reserveCredits(req(fx, k, o.amount))).ok;
          } else if (o.kind === "release") {
            const k = keys[o.slot];
            if (k) await creditHoldService.releaseHold(k);
          } else {
            const k = keys[o.slot];
            if (k && o.amount > 0) {
              await creditLotService.chargeForGeneration({
                projectId: fx.projectId,
                actorUserId: fx.userId,
                amount: o.amount,
                releaseHold: k,
              });
            }
          }
          const position = await creditHoldService.getCreditPosition(fx.studioId);
          // What is left reads below zero only when the studio owes.
          const left = position.spendable < 0 ? position.spendable : Math.max(0, position.spendable - position.held);
          expect(position.available).toBeCloseTo(left, 6);
          if (admitted) expect(position.held).toBeLessThanOrEqual(position.spendable + 1e-6);
        }
      }),
      { numRuns: 25 },
    );
  });
});
