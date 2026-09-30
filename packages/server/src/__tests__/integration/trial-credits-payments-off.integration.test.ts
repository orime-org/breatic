// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Trial credits where nobody is charged for anything (task #267).
 *
 * Every development environment and every self-hosted install runs with
 * payments off, so this is the path most deployments are on. A deployment
 * that takes no payment has no notion of a credit to give, so it grants
 * none — and registration finishes exactly as it does anywhere else.
 *
 * Its own file because the switch is process-wide: it cannot share one with
 * the suite that needs it on, for the reason the charge engine's two suites
 * are split the same way.
 *
 * The zero case lives here too. Configured to zero, a deployment that does
 * charge grants nothing either, and "nothing" has to mean no rows rather
 * than a lot worth zero: a lot that starts empty never reaches `depleted`
 * (only a charge that lands on zero writes that), so it would sit `active`
 * forever, counted among the studio's lots and printed on the assignment
 * screen with nothing in it.
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

import postgres from "postgres";
import { initCore, db } from "@breatic/core";
import { creditLotService } from "@breatic/domain";
import * as studioService from "@server/modules/studio/studio.service.js";

const PG_DRIVER_LOCAL = "trial-credits-off-test-driver";

let sql: ReturnType<typeof postgres>;

beforeAll(() => {
  // Stated rather than inherited: a sibling suite in this worker turns it on
  // for its own purposes.
  initCore({ ...process.env, PAYMENT_ENABLED: "false" });
  sql = postgres(inject("DATABASE_URL"), {
    max: 4,
    prepare: false,
    connection: { application_name: PG_DRIVER_LOCAL },
  });
});

afterAll(async () => {
  await sql?.end({ timeout: 1 });
  initCore(process.env);
});

let seq = 0;

/**
 * One account with nothing of its own yet.
 * @returns Its id.
 */
async function seedUser(): Promise<string> {
  const rows = await sql<{ id: string }[]>`
    INSERT INTO users (email, email_verified)
    VALUES (${`trial-off-${seq++}@example.test`}, true) RETURNING id
  `;
  return rows[0]!.id;
}

/** A slug that satisfies the format rule (lowercase, 6–39 chars). */
function freshSlug(): string {
  return `offuser-${seq++}`;
}

/**
 * How much of anything this account was given.
 * @param userId - Whose rows to count.
 * @returns The receipts, lots and ledger rows that exist for it.
 */
async function rowsOf(
  userId: string,
): Promise<{ sources: number; lots: number; ledger: number }> {
  const rows = await sql<{ sources: number; lots: number; ledger: number }[]>`
    SELECT
      (SELECT count(*)::int FROM credit_sources WHERE id = ${userId}) AS sources,
      (SELECT count(*)::int FROM credit_lots WHERE user_id = ${userId}) AS lots,
      (SELECT count(*)::int FROM credit_ledger WHERE payer_user_id = ${userId}) AS ledger
  `;
  return rows[0]!;
}

describe("a deployment that charges nobody", () => {
  it("creates the studio and grants nothing", async () => {
    const userId = await seedUser();
    const studio = await studioService.createPersonalStudio(
      userId,
      freshSlug(),
    );

    expect(studio.id).toBeTruthy();
    expect(await rowsOf(userId)).toEqual({ sources: 0, lots: 0, ledger: 0 });
  });
});

describe("a grant configured to zero", () => {
  it("writes no rows at all, not a lot worth nothing", async () => {
    const userId = await seedUser();
    const studio = await studioService.createPersonalStudio(
      userId,
      freshSlug(),
    );

    // Driven directly rather than through configuration, so the assertion is
    // about the figure and not about which file it came from. Payments are
    // off in this suite, which the grant also refuses on — so turn that back
    // on for the call and let the amount be the only thing deciding.
    initCore({
      ...process.env,
      PAYMENT_ENABLED: "true",
      STRIPE_SECRET_KEY: "sk_test_unused_by_this_suite",
      STRIPE_WEBHOOK_SECRET: "whsec_unused_by_this_suite",
    });
    try {
      const lot = await db.transaction((tx) =>
        creditLotService.grantTrialCredits(
          { userId, studioId: studio.id, credits: 0 },
          tx,
        ),
      );
      expect(lot).toBeNull();
    } finally {
      initCore({ ...process.env, PAYMENT_ENABLED: "false" });
    }

    expect(await rowsOf(userId)).toEqual({ sources: 0, lots: 0, ledger: 0 });
  });

  it("grants what a positive figure asks for, through the same call", async () => {
    // The pair the zero case needs beside it: without this, "no rows" would
    // also pass for a grant that never writes anything whatever it is told.
    const userId = await seedUser();
    const studio = await studioService.createPersonalStudio(
      userId,
      freshSlug(),
    );

    initCore({
      ...process.env,
      PAYMENT_ENABLED: "true",
      STRIPE_SECRET_KEY: "sk_test_unused_by_this_suite",
      STRIPE_WEBHOOK_SECRET: "whsec_unused_by_this_suite",
    });
    try {
      const lot = await db.transaction((tx) =>
        creditLotService.grantTrialCredits(
          { userId, studioId: studio.id, credits: 7 },
          tx,
        ),
      );
      expect(Number(lot?.purchasedCredits)).toBe(7);
    } finally {
      initCore({ ...process.env, PAYMENT_ENABLED: "false" });
    }

    expect(await rowsOf(userId)).toEqual({ sources: 1, lots: 1, ledger: 1 });
  });
});
