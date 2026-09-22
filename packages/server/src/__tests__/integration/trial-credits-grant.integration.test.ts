// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Trial credits — the grant a new account gets with its personal studio
 * (task #267).
 *
 * The grant lands in step two of registration, not step one: the credits are
 * pinned to the personal studio and that studio does not exist until
 * `setup-studio`. It writes three rows in the transaction that creates the
 * studio — the receipt, the lot, and the ledger row that opens its balance.
 *
 * What is pinned here:
 *
 *   1. The three rows, and the values that make them a trial grant: kind
 *      `gift`, the configured amount, pointed at the studio just created.
 *
 *   2. The ledger row is not optional. A lot's remaining balance is defined
 *      as the ledger summed over it, so a lot committed without its `topup`
 *      row reads as owing its whole value.
 *
 *   3. One account, one grant — and the database is what says so. The
 *      receipt's id IS the account's id, so a second grant collides with the
 *      primary key instead of relying on anything above it to have counted.
 *      A user who soft-deletes their personal studio and makes another gets
 *      the studio, and no second grant.
 *
 * Runs against the testcontainer Postgres started by global-setup.ts, driving
 * the real `studioService.createPersonalStudio`.
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
import { initCore } from "@breatic/core";
import * as studioService from "@server/modules/studio/studio.service.js";
import { getTrialGrantCredits } from "@server/config/pricing.js";

const PG_DRIVER_LOCAL = "trial-credits-grant-test-driver";

let sql: ReturnType<typeof postgres>;

beforeAll(() => {
  // Stated rather than inherited: a sibling suite in this worker turns the
  // switch off for its own purposes, and the grant only happens when the
  // deployment charges for anything.
  initCore({
    ...process.env,
    PAYMENT_ENABLED: "true",
    STRIPE_SECRET_KEY: "sk_test_unused_by_this_suite",
    STRIPE_WEBHOOK_SECRET: "whsec_unused_by_this_suite",
  });
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
    VALUES (${`trial-${seq++}@example.test`}, true) RETURNING id
  `;
  return rows[0]!.id;
}

/** A slug that satisfies the format rule (lowercase, 6–39 chars). */
function freshSlug(): string {
  return `trialer-${seq++}`;
}

interface GrantRows {
  sourceId: string | null;
  sourceKind: string | null;
  lotId: string | null;
  purchased: string | null;
  remaining: string | null;
  designated: string | null;
  lifecycle: string | null;
}

/**
 * Every lot this account holds, with the receipt each points at.
 * @param userId - Whose lots.
 * @returns One row per lot.
 */
async function lotsOf(userId: string): Promise<GrantRows[]> {
  return sql<GrantRows[]>`
    SELECT s.id AS "sourceId", s.kind AS "sourceKind", l.id AS "lotId",
           l.purchased_credits AS purchased, l.remaining_credits AS remaining,
           l.designated_studio_id AS designated, l.lifecycle
    FROM credit_lots l
    JOIN credit_sources s ON s.id = l.source_id
    WHERE l.user_id = ${userId}
  `;
}

/**
 * What the ledger says this lot is worth.
 * @param lotId - The lot to total.
 * @returns The sum of every entry against it, and how many there are.
 */
async function ledgerOf(
  lotId: string,
): Promise<{ total: string; entries: number; types: string[] }> {
  const rows = await sql<{ total: string; entries: number; type: string }[]>`
    SELECT SUM(amount)::text AS total, count(*)::int AS entries,
           string_agg(DISTINCT entry_type, ',') AS type
    FROM credit_ledger WHERE lot_id = ${lotId}
  `;
  const row = rows[0]!;
  return {
    total: row.total ?? "0",
    entries: row.entries,
    types: row.type ? row.type.split(",") : [],
  };
}

describe("a new account's trial credits", () => {
  it("opens one gift lot pinned to the personal studio", async () => {
    const userId = await seedUser();
    const studio = await studioService.createPersonalStudio(
      userId,
      freshSlug(),
    );

    const lots = await lotsOf(userId);
    expect(lots).toHaveLength(1);

    const lot = lots[0]!;
    expect(lot.sourceKind).toBe("gift");
    // Compared against the configured figure rather than a number written
    // here, so changing the setting cannot leave this assertion pinning the
    // old one.
    expect(Number(lot.purchased)).toBe(getTrialGrantCredits());
    expect(Number(lot.remaining)).toBe(getTrialGrantCredits());
    expect(lot.designated).toBe(studio.id);
    expect(lot.lifecycle).toBe("active");
  });

  it("opens the lot's balance in the ledger", async () => {
    const userId = await seedUser();
    await studioService.createPersonalStudio(userId, freshSlug());

    const lot = (await lotsOf(userId))[0]!;
    const ledger = await ledgerOf(lot.lotId!);

    expect(ledger.entries).toBe(1);
    expect(ledger.types).toEqual(["topup"]);
    // The balance a lot reports has to equal what the ledger says it is.
    expect(Number(ledger.total)).toBe(Number(lot.remaining));
  });

  it("files the receipt under the account it was granted to", async () => {
    const userId = await seedUser();
    await studioService.createPersonalStudio(userId, freshSlug());

    // Not an incidental equality: it is what makes a second grant collide
    // with the primary key rather than open a second receipt.
    expect((await lotsOf(userId))[0]!.sourceId).toBe(userId);
  });

  it("grants once, however many personal studios the account goes through", async () => {
    const userId = await seedUser();
    const first = await studioService.createPersonalStudio(
      userId,
      freshSlug(),
    );
    await sql`UPDATE studios SET deleted_at = now() WHERE id = ${first.id}`;
    await sql`UPDATE studio_members SET deleted_at = now() WHERE studio_id = ${first.id}`;

    // The second studio is created normally — the collision is swallowed
    // where the grant happens, not raised to the caller. Raised, it would
    // reach the catch that reads any unique violation as a taken slug.
    const second = await studioService.createPersonalStudio(
      userId,
      freshSlug(),
    );
    expect(second.id).not.toBe(first.id);

    const lots = await lotsOf(userId);
    expect(lots).toHaveLength(1);
    expect(lots[0]!.designated).toBe(first.id);
  });
});
