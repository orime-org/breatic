// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Where granted credits may go, and where they may not (task #267).
 *
 * Credits nobody paid for are pinned to the account holder's own studio when
 * they are written, and nothing afterwards moves them. Three ways out are
 * closed, and each is closed by something different:
 *
 *   1. Pointing them at another studio — refused by the designation rule,
 *      which asks what the credits are before it asks anything else.
 *
 *   2. Clearing the designation — refused by the same rule and for the same
 *      reason. Refusing only the first would leave the second as a way of
 *      doing it in two steps: unassign, then point anywhere.
 *
 *   3. Asking for the money back — refused by the refund rule, which has no
 *      money to return.
 *
 * And one that is closed by arithmetic rather than by a rule: handing a team
 * studio to someone else clears the designations pointing at that studio, and
 * a granted lot never points at one. Asserted here because it holds on a fact
 * about the data rather than on a predicate anybody wrote — if grants ever
 * reach a team studio, this is what notices.
 *
 * Runs against the testcontainer Postgres started by global-setup.ts.
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
import { initCore, ForbiddenError, loadLocales, db } from "@breatic/core";
import { creditLotService } from "@breatic/domain";
import { t } from "@breatic/shared";
import { precheckCredits } from "@server/modules/payment/credit-precheck.service.js";
import * as studioService from "@server/modules/studio/studio.service.js";

const PG_DRIVER_LOCAL = "trial-credits-constraints-test-driver";

let sql: ReturnType<typeof postgres>;

beforeAll(() => {
  initCore({
    ...process.env,
    PAYMENT_ENABLED: "true",
    STRIPE_SECRET_KEY: "sk_test_unused_by_this_suite",
    STRIPE_WEBHOOK_SECRET: "whsec_unused_by_this_suite",
  });
  loadLocales();
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
 * An account holding its trial credits, with the studio they are pinned to.
 * @returns The account, its studio, and the granted lot.
 */
async function seedGranted(): Promise<{
  userId: string;
  studioId: string;
  lotId: string;
}> {
  const rows = await sql<{ id: string }[]>`
    INSERT INTO users (email, email_verified)
    VALUES (${`pinned-${seq++}@example.test`}, true) RETURNING id
  `;
  const userId = rows[0]!.id;
  const studio = await studioService.createPersonalStudio(
    userId,
    `pinned-${seq++}`,
  );
  const lots = await sql<{ id: string }[]>`
    SELECT id FROM credit_lots WHERE user_id = ${userId}
  `;
  expect(lots, "the grant this suite tests did not happen").toHaveLength(1);
  return { userId, studioId: studio.id, lotId: lots[0]!.id };
}

/**
 * A team studio this account administers.
 * @param userId - Who administers it.
 * @returns Its id.
 */
async function seedTeamStudio(userId: string): Promise<string> {
  // Written directly: what this suite needs is a studio the account
  // administers, and going through the service would first have to satisfy
  // the plan limit on how many team studios a free account may create —
  // a rule this suite is not about.
  const rows = await sql<{ id: string }[]>`
    INSERT INTO studios (created_by_user_id, slug, type, name)
    VALUES (${userId}, ${`teamer-${seq++}`}, 'team', 'Team') RETURNING id
  `;
  const id = rows[0]!.id;
  await sql`
    INSERT INTO studio_members (studio_id, user_id, role)
    VALUES (${id}, ${userId}, 'admin')
  `;
  return id;
}

/**
 * One project inside a studio.
 * @param studioId - Which studio owns it.
 * @param userId - Who created it.
 * @returns Its id.
 */
async function seedProject(
  studioId: string,
  userId: string,
): Promise<string> {
  const rows = await sql<{ id: string }[]>`
    INSERT INTO projects (studio_id, created_by_user_id, slug, name)
    VALUES (${studioId}, ${userId}, ${`proj-${seq++}`}, 'Project') RETURNING id
  `;
  return rows[0]!.id;
}

/**
 * Where a lot points right now, read past every service.
 * @param lotId - The lot to read.
 * @returns The studio id on the column, or null.
 */
async function designationOf(lotId: string): Promise<string | null> {
  const rows = await sql<{ designated_studio_id: string | null }[]>`
    SELECT designated_studio_id FROM credit_lots WHERE id = ${lotId}
  `;
  return rows[0]!.designated_studio_id;
}

describe("granted credits stay where they were granted", () => {
  it("refuses to point them at a studio the holder administers", async () => {
    const { userId, studioId, lotId } = await seedGranted();
    const team = await seedTeamStudio(userId);

    await expect(
      creditLotService.designateLot({
        lotId,
        requestingUserId: userId,
        studioId: team,
      }),
    ).rejects.toBeInstanceOf(ForbiddenError);

    expect(await designationOf(lotId)).toBe(studioId);
  });

  it("refuses to clear the designation", async () => {
    const { userId, studioId, lotId } = await seedGranted();

    await expect(
      creditLotService.designateLot({
        lotId,
        requestingUserId: userId,
        studioId: null,
      }),
    ).rejects.toBeInstanceOf(ForbiddenError);

    expect(await designationOf(lotId)).toBe(studioId);
  });

  it("refuses a refund, whatever state the lot is in", async () => {
    const { userId, lotId } = await seedGranted();

    // 422 rather than 409: the four refusals about where a purchase stands
    // are things that may change, and this one never does.
    await expect(
      creditLotService.requestRefund({ lotId, requestingUserId: userId }),
    ).rejects.toMatchObject({ statusCode: 422 });

    const rows = await sql<{ lifecycle: string }[]>`
      SELECT lifecycle FROM credit_lots WHERE id = ${lotId}
    `;
    expect(rows[0]!.lifecycle).toBe("active");
  });

  it("is untouched when a team studio changes hands", async () => {
    const { userId, studioId, lotId } = await seedGranted();
    const team = await seedTeamStudio(userId);

    // Release runs on the designations pointing at the studio handed over.
    // A granted lot points at the holder's own studio, so it is not among
    // them — and this says so through the call rather than by reasoning
    // about its predicate.
    await db.transaction((tx) =>
      creditLotService.releaseDesignations({ userId, studioId: team, tx }),
    );

    expect(await designationOf(lotId)).toBe(studioId);
  });
});

describe("bought credits are still the buyer's to move", () => {
  it("lets a purchase be pointed at a studio the buyer administers", async () => {
    // The pair the four refusals need beside them: without it, a rule that
    // refused every designation would pass all of them.
    const { userId, lotId: grantedLot } = await seedGranted();
    const team = await seedTeamStudio(userId);

    const sourceId = (
      await sql<{ id: string }[]>`
        INSERT INTO credit_sources (id, kind)
        VALUES (gen_random_uuid(), 'payment') RETURNING id
      `
    )[0]!.id;
    await sql`
      INSERT INTO payments (id, user_id, amount_cents, status, credits_granted)
      VALUES (${sourceId}, ${userId}, 1000, 'completed', 880)
    `;
    const bought = (
      await sql<{ id: string }[]>`
        INSERT INTO credit_lots
          (source_id, source_kind, user_id, purchased_credits, remaining_credits, lifecycle)
        VALUES (${sourceId}, 'payment', ${userId}, 880, 880, 'active')
        RETURNING id
      `
    )[0]!.id;

    await creditLotService.designateLot({
      lotId: bought,
      requestingUserId: userId,
      studioId: team,
    });

    expect(await designationOf(bought)).toBe(team);
    // And the grant beside it did not move.
    expect(await designationOf(grantedLot)).not.toBe(team);
  });
});

describe("the refusal a holder of granted credits reads", () => {
  it("says the credits are pinned elsewhere, not that there are none", async () => {
    const { userId } = await seedGranted();
    const team = await seedTeamStudio(userId);
    const project = await seedProject(team, userId);

    const err = await precheckCredits(project, userId, 1).then(
      () => null,
      (e: unknown) => e as { statusCode: number; message: string },
    );

    expect(err?.statusCode).toBe(402);
    // The account holds a hundred credits and this studio can reach none of
    // them. Answering "top up first" here tells someone with credits that
    // they have none, which is the same mistake the unassigned branch above
    // exists to avoid.
    expect(err?.message).toBe(t("server.credit.granted_elsewhere"));
  });

  it("still says there are none when there really are none", async () => {
    // The pair the one above needs: a branch that fired for everybody would
    // pass it and be wrong for every account that has nothing.
    const rows = await sql<{ id: string }[]>`
      INSERT INTO users (email, email_verified)
      VALUES (${`broke-${seq++}@example.test`}, true) RETURNING id
    `;
    const userId = rows[0]!.id;
    const team = await seedTeamStudio(userId);
    const project = await seedProject(team, userId);

    const err = await precheckCredits(project, userId, 1).then(
      () => null,
      (e: unknown) => e as { statusCode: number; message: string },
    );

    expect(err?.statusCode).toBe(402);
    expect(err?.message).toBe(t("server.credit.none"));
  });
});
