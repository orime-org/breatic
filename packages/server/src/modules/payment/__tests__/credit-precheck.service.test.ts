// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Which sentence a refused run is given, and what a run's admission holds
 * (inner#1611).
 *
 * The refusal names the cause that answers the problem: waiting helps only
 * when the credits are there but held by running work, and assigning helps
 * only when the account has unassigned purchases.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import type * as CoreModule from "@breatic/core";
import type * as SharedModule from "@breatic/shared";

const { env } = vi.hoisted(() => ({ env: { PAYMENT_ENABLED: true } }));
vi.mock("@breatic/core", async (importOriginal) => {
  const real = await importOriginal<typeof CoreModule>();
  return {
    AppError: real.AppError,
    env,
    getNodeTaskConfig: () => ({ default_budget_ms: 7_200_000 }),
  };
});

vi.mock("@breatic/shared", async (importOriginal) => ({
  ...(await importOriginal<typeof SharedModule>()),
  t: (key: string, params?: Record<string, unknown>) => `${key}${params ? ` ${JSON.stringify(params)}` : ""}`,
}));

const reserveCredits = vi.fn();
const getSpendableCredits = vi.fn();
const getStudioDebt = vi.fn();
const getUnassignedCredits = vi.fn();
const getGrantedCredits = vi.fn();
const resolveOwnerStudioId = vi.fn();
vi.mock("@breatic/domain", () => ({
  creditHoldService: {
    reserveCredits: (...a: unknown[]) => reserveCredits(...a),
  },
  creditLotService: {
    getStudioDebt: (...a: unknown[]) => getStudioDebt(...a),
    getUnassignedCredits: (...a: unknown[]) => getUnassignedCredits(...a),
    getGrantedCredits: (...a: unknown[]) => getGrantedCredits(...a),
    getSpendableCredits: (...a: unknown[]) => getSpendableCredits(...a),
  },
  assetService: { resolveOwnerStudioId: (...a: unknown[]) => resolveOwnerStudioId(...a) },
}));

const { CreditsHeldError, precheckCredits, reserveForRun } = await import("@server/modules/payment/credit-precheck.service.js");

const PROJECT = "p1";
const USER = "u1";
const STUDIO = "s1";

/**
 * The refusal a call ends in.
 * @param run - The call.
 * @returns Its status and message.
 */
async function refusal(run: () => Promise<void>): Promise<{ status: number; message: string }> {
  try {
    await run();
  } catch (err) {
    const e = err as { statusCode: number; message: string };
    return { status: e.statusCode, message: e.message };
  }
  throw new Error("expected a refusal");
}

/**
 * Refuse the next admission with these figures.
 * @param spendable - Purchases less debt.
 * @param held - Counted holds.
 */
function refuseWith(spendable: number, held: number): void {
  reserveCredits.mockResolvedValue({ ok: false, studioId: STUDIO, spendable, held });
}

beforeEach(() => {
  vi.clearAllMocks();
  env.PAYMENT_ENABLED = true;
  resolveOwnerStudioId.mockResolvedValue(STUDIO);
  reserveCredits.mockResolvedValue({ ok: true });
  getSpendableCredits.mockResolvedValue(100);
  getStudioDebt.mockResolvedValue(0);
  getUnassignedCredits.mockResolvedValue(0);
  getGrantedCredits.mockResolvedValue(0);
});

describe("reserveForRun", () => {
  it("holds the estimate under the run's key for the task budget", async () => {
    await reserveForRun(PROJECT, USER, "task-1", 40);
    expect(reserveCredits).toHaveBeenCalledWith({
      projectId: PROJECT,
      actorUserId: USER,
      referenceId: "task-1",
      amount: 40,
      ttlMs: 7_200_000,
    });
  });

  it("names the debt first", async () => {
    refuseWith(-30, 50);
    getStudioDebt.mockResolvedValue(30);
    expect(await refusal(() => reserveForRun(PROJECT, USER, "t", 10))).toEqual({
      status: 402,
      message: 'server.credit.in_debt {"owed":30}',
    });
  });

  it("says the credits are held by running work when the balance covers the run but its holds do not", async () => {
    refuseWith(100, 80);
    const err = await reserveForRun(PROJECT, USER, "t", 60).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CreditsHeldError);
    expect(err).toMatchObject({
      statusCode: 402,
      message: 'server.credit.held_by_running {"held":80,"available":20}',
    });
  });

  it("points at the account's unassigned credits before the held ones, since holds turn into charges", async () => {
    refuseWith(100, 80);
    getUnassignedCredits.mockResolvedValue(500);
    const err = await reserveForRun(PROJECT, USER, "t", 60).catch((e: unknown) => e);
    // Still a hold refusal, so a lane that stores the cause on its node names it.
    expect(err).toBeInstanceOf(CreditsHeldError);
    expect(err).toMatchObject({ statusCode: 402, message: 'server.credit.unassigned {"available":500}' });
  });

  it("says nothing is available rather than a negative figure when holds outgrow the balance", async () => {
    // A run charged above its estimate leaves the others' holds larger than
    // what is left; the sentence answers how much can be used now.
    refuseWith(90, 95);
    expect((await refusal(() => reserveForRun(PROJECT, USER, "t", 10))).message).toBe(
      'server.credit.held_by_running {"held":95,"available":0}',
    );
  });

  it("falls back to the shortfall sentence when the credits would not be enough even unheld", async () => {
    refuseWith(50, 20);
    expect(await refusal(() => reserveForRun(PROJECT, USER, "t", 60))).toEqual({
      status: 402,
      message: 'server.error.insufficient_credits {"required":60,"available":30}',
    });
  });

  it("points at assigning when nothing is left here and the account holds unassigned credits, even with holds", async () => {
    refuseWith(40, 40);
    getUnassignedCredits.mockResolvedValue(500);
    expect(await refusal(() => reserveForRun(PROJECT, USER, "t", 60))).toEqual({
      status: 402,
      message: 'server.credit.unassigned {"available":500}',
    });
  });

  it("says granted credits are pinned elsewhere, then that there are none", async () => {
    refuseWith(0, 0);
    getGrantedCredits.mockResolvedValue(10);
    expect((await refusal(() => reserveForRun(PROJECT, USER, "t", 5))).message).toBe("server.credit.granted_elsewhere");
    getGrantedCredits.mockResolvedValue(0);
    expect((await refusal(() => reserveForRun(PROJECT, USER, "t", 5))).message).toBe("server.credit.none");
  });
});

describe("precheckCredits", () => {
  // A chat turn cannot know up front what it will cost, so it holds nothing
  // and is admitted on the balance alone, holds or not (user 2026-10-18).
  it("lets a chat turn through on the balance, without reading holds", async () => {
    getSpendableCredits.mockResolvedValue(100);
    await expect(precheckCredits(PROJECT, USER, 0.000001)).resolves.toBeUndefined();
  });

  it("refuses on the balance with the sentence that names the cause, never the held one", async () => {
    getSpendableCredits.mockResolvedValue(0);
    expect(await refusal(() => precheckCredits(PROJECT, USER, 0.000001))).toEqual({
      status: 402,
      message: "server.credit.none",
    });
  });

  it("asks nothing while payments are off", async () => {
    env.PAYMENT_ENABLED = false;
    await precheckCredits(PROJECT, USER, 1);
    await reserveForRun(PROJECT, USER, "t", 1);
    expect(getSpendableCredits).not.toHaveBeenCalled();
    expect(reserveCredits).not.toHaveBeenCalled();
  });
});
