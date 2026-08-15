// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * Changing the tier an account is on (task #105) — real-PG.
 *
 * Until this landed the column had no writer at all: it was stamped once at
 * registration and nothing in the codebase ever issued an UPDATE against it.
 * Five ceilings already read it, so a payment could not move a single one of
 * them.
 *
 * What this suite pins:
 *
 *   1. The change is visible to the readers that already exist — the tier
 *      lookup and the ceilings derived from it — with no restart and no cache
 *      to expire. That is what makes "paid, and can now create the eleventh
 *      project" true in the same request.
 *   2. Every change leaves a row saying where it came from, where it went, and
 *      what caused it. A tier is what somebody paid for; "why is this account
 *      on base" has to be answerable months later.
 *   3. Setting an account to the tier it is already on writes nothing. This is
 *      an empty change, not an idempotency guarantee — see the note on the
 *      case itself, and §4.4 of the design.
 *   4. Two changes at once do not overwrite each other. The interleaving is
 *      observed through a held row lock, never hoped for.
 *   5. Both guards on the tier value stand: the database refuses a value
 *      outside the five, and the read side still refuses one that reached it
 *      anyway (that half is a unit test, in core).
 *
 * What it deliberately does NOT pin: anything that "should happen" after a
 * downgrade. The ratified rule is that every ceiling is judged at the moment
 * an action is taken and nothing already created is corrected, so the correct
 * behaviour after a downgrade is that nothing happens at all.
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
import {
  initCore,
  loadLocales,
  changeMembershipTier,
  getUserMembershipTier,
  getLimitsForUser,
  getMembershipLimits,
} from "@breatic/core";
import { waitUntilBlockedOn } from "@server/__tests__/integration/lock-probe.js";

try {
  initCore(process.env);
} catch {
  // already initialised by a sibling suite in this worker — fine.
}
loadLocales();

let sql: ReturnType<typeof postgres>;
let seq = 0;

beforeAll(() => {
  sql = postgres(inject("DATABASE_URL"), {
    max: 4,
    prepare: false,
    connection: { application_name: "membership-tier-mutation-test" },
  });
});

afterAll(async () => {
  await sql?.end({ timeout: 1 });
});

/**
 * An account sitting on a given tier.
 * @param tier - What to stamp on the row.
 * @returns The account id.
 */
async function insertUser(tier: string): Promise<string> {
  const [u] = await sql<{ id: string }[]>`
    INSERT INTO users (email, email_verified, membership_tier)
    VALUES (${`tier-mut-${seq++}@example.test`}, true, ${tier})
    RETURNING id
  `;
  return u!.id;
}

/** One row of the tier-change ledger, as stored. */
interface LedgerRow {
  from_tier: string;
  to_tier: string;
  reason: string;
  reference_id: string | null;
}

/**
 * Every ledger row belonging to one account.
 * @param userId - Whose history to read.
 * @returns The rows, oldest first.
 */
async function ledgerOf(userId: string): Promise<LedgerRow[]> {
  return sql<LedgerRow[]>`
    SELECT from_tier, to_tier, reason, reference_id
    FROM membership_tier_changes
    WHERE user_id = ${userId}
    ORDER BY created_at
  `;
}

/**
 * The tier stored on an account, read past the repo so a broken read cannot
 * make a broken write look fine.
 * @param userId - Whose row to read.
 * @returns The stored value.
 */
async function storedTier(userId: string): Promise<string> {
  const [row] = await sql<{ membership_tier: string }[]>`
    SELECT membership_tier FROM users WHERE id = ${userId}
  `;
  return row!.membership_tier;
}

describe("changeMembershipTier", () => {
  it("moves the account, and the tier lookup answers with the new one", async () => {
    const userId = await insertUser("base");

    const result = await changeMembershipTier(
      userId,
      "pro",
      "subscription_activated",
    );

    expect(result).toEqual({ changed: true, fromTier: "base" });
    expect(await storedTier(userId)).toBe("pro");
    await expect(getUserMembershipTier(userId)).resolves.toBe("pro");
  });

  it("moves the ceilings with it, in the same breath", async () => {
    // The reason this block exists at all. Five ceilings read the tier at the
    // moment an action happens, so a change to the column IS the change to
    // what the account may do — no restart, no cache, no second write.
    const userId = await insertUser("base");
    await expect(getLimitsForUser(userId)).resolves.toEqual(
      getMembershipLimits("base"),
    );

    await changeMembershipTier(userId, "team", "subscription_activated");

    await expect(getLimitsForUser(userId)).resolves.toEqual(
      getMembershipLimits("team"),
    );
  });

  it("records where it came from, where it went, and what caused it", async () => {
    const userId = await insertUser("base");

    await changeMembershipTier(userId, "pro", "subscription_activated", "sub_123");

    expect(await ledgerOf(userId)).toEqual([
      {
        from_tier: "base",
        to_tier: "pro",
        reason: "subscription_activated",
        reference_id: "sub_123",
      },
    ]);
  });

  it("keeps the whole history, one row per change", async () => {
    // A ledger that only kept the latest change would answer "what is this
    // account on" — which the column already answers — and not "how did it
    // get there", which is the only question this table exists for.
    const userId = await insertUser("base");

    await changeMembershipTier(userId, "pro", "subscription_activated", "sub_1");
    await changeMembershipTier(userId, "base", "subscription_ended", "sub_1");

    expect(await ledgerOf(userId)).toEqual([
      {
        from_tier: "base",
        to_tier: "pro",
        reason: "subscription_activated",
        reference_id: "sub_1",
      },
      {
        from_tier: "pro",
        to_tier: "base",
        reason: "subscription_ended",
        reference_id: "sub_1",
      },
    ]);
  });

  it("writes nothing when the account is already on that tier", async () => {
    // This keeps the ledger free of rows where nothing changed. It is NOT the
    // idempotency block eight needs: it compares tiers, not event identity, so
    // it converges on the last call and cannot tell a redelivered activation
    // from a new one. Block eight keys on the event itself.
    const userId = await insertUser("pro");

    const result = await changeMembershipTier(
      userId,
      "pro",
      "subscription_activated",
      "sub_repeat",
    );

    expect(result).toEqual({ changed: false, fromTier: "pro" });
    expect(await ledgerOf(userId)).toEqual([]);
    expect(await storedTier(userId)).toBe("pro");
  });

  it("refuses an account that is gone, and leaves no trace of the attempt", async () => {
    // Every caller resolves the id from a session or from a row it just read,
    // so an id with no live account behind it means our data or our code is
    // wrong. Same sentence the tier lookup already throws.
    const userId = await insertUser("base");
    await sql`UPDATE users SET deleted_at = now() WHERE id = ${userId}`;

    await expect(
      changeMembershipTier(userId, "pro", "subscription_activated"),
    ).rejects.toThrow(`No live account ${userId}`);

    expect(await ledgerOf(userId)).toEqual([]);
    expect(await storedTier(userId)).toBe("base");
  });

  it("does not lose one of two changes that arrive at once", async () => {
    // Read-then-write is not a decision under concurrency: both sides read
    // `base`, both write, and the second silently discards the first — which
    // for a paid tier means somebody's upgrade disappears.
    //
    // The interleaving is observed, not hoped for. A separate connection holds
    // the account's row so the first call parks on it, the second is then
    // known to be queued behind the first, and only then is the gate released.
    // With `Promise.all` and no lock this passes for the wrong reason: two
    // short transactions reuse one pooled connection and run one after the
    // other, so nothing ever interleaves (see backend-db notes).
    const userId = await insertUser("base");

    const gate = postgres(inject("DATABASE_URL"), { max: 1, prepare: false });
    let first: Promise<unknown>;
    let second: Promise<unknown>;
    try {
      await gate.begin(async (g) => {
        await g`SELECT id FROM users WHERE id = ${userId} FOR UPDATE`;

        first = changeMembershipTier(userId, "pro", "subscription_activated");
        await waitUntilBlockedOn(sql, ["users", "for update"], 1);
        second = changeMembershipTier(userId, "team", "subscription_activated");
        await waitUntilBlockedOn(sql, ["users", "for update"], 2);
      });
    } finally {
      await gate.end({ timeout: 5 });
    }
    await Promise.all([first!, second!]);

    // Order is not asserted — either may win the lock. What must hold is that
    // the two rows form a chain: whichever ran second read the first one's
    // result rather than the stale `base` both started from.
    const rows = await ledgerOf(userId);
    expect(rows).toHaveLength(2);
    const opening = rows.filter((r) => r.from_tier === "base");
    expect(opening, "exactly one change may start from base").toHaveLength(1);
    const closing = rows.find((r) => r.from_tier !== "base")!;
    expect(closing.from_tier).toBe(opening[0]!.to_tier);
    expect(new Set(rows.map((r) => r.to_tier))).toEqual(
      new Set(["pro", "team"]),
    );
    expect(await storedTier(userId)).toBe(closing.to_tier);
  });
});

describe("the tier value, guarded on the way in", () => {
  it("refuses a value outside the five tiers on the account row", async () => {
    // The write side of the pair. An operator moving somebody by hand types
    // the tier name, and `Pro` is not `pro`. Before this constraint the typo
    // landed in the column and surfaced only when somebody read it.
    await expect(sql`
      INSERT INTO users (email, email_verified, membership_tier)
      VALUES (${`tier-bad-${seq++}@example.test`}, true, 'Pro')
    `).rejects.toThrow(/membership_tier/i);
  });

  it("accepts every one of the five, enterprise included", async () => {
    // The constraint must not be narrower than the product. Enterprise is a
    // real tier that is negotiated per customer; a database that refuses the
    // word would make setting an account to it impossible rather than
    // explicit. What it may not do is invent ceilings — see the case below.
    //
    // ON ITS OWN THIS CASE PINS NOTHING, and that was measured: with no
    // constraint at all the column is a bare varchar and this passes. It has
    // meaning only next to the two rejection cases around it — together they
    // say the constraint exists AND lists exactly these five.
    for (const tier of ["base", "pro", "team", "self_hosted", "enterprise"]) {
      const userId = await insertUser(tier);
      expect(await storedTier(userId)).toBe(tier);
    }
  });

  it("refuses a value outside the five in the ledger's own two columns", async () => {
    // The ledger carries tier names too, and a row saying an account moved to
    // `Pro` would be just as unreadable as the column holding it.
    const userId = await insertUser("base");
    await expect(sql`
      INSERT INTO membership_tier_changes (user_id, from_tier, to_tier, reason)
      VALUES (${userId}, 'Base', 'pro', 'manual')
    `).rejects.toThrow(/from_tier/i);
    await expect(sql`
      INSERT INTO membership_tier_changes (user_id, from_tier, to_tier, reason)
      VALUES (${userId}, 'base', 'PRO', 'manual')
    `).rejects.toThrow(/to_tier/i);
  });
});

describe("the enterprise tier, which has no ceilings to give", () => {
  it("refuses to answer with numbers nobody negotiated, and says whose account", async () => {
    // Enterprise ceilings are agreed per customer and will be read from the
    // database when that work happens. Putting a set of them in the config
    // file today would hand an account a quota nobody agreed to, and nothing
    // would surface it. So the tier is legal to store and impossible to price:
    // the lookup fails, naming the account so it can be fixed.
    const userId = await insertUser("enterprise");

    const err = await getLimitsForUser(userId).then(
      () => null,
      (e: unknown) => e as Error,
    );
    expect(err, "expected a throw").not.toBeNull();
    expect(err!.message).toContain(userId);
    expect(err!.message).toContain("enterprise");
    expect(err!.message).toMatch(/negotiated/i);
  });
});
