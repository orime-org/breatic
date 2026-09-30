// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * What the account's credit screens show, and whose activity they leave out
 * (task #267, closing #260).
 *
 * Both reads were taken by payer alone, which answered "whose money moved".
 * That is the wrong question for a screen an account holder opens about their
 * own studios: a guest editing someone else's project spends the admin's
 * credits there, and every one of those runs was landing on the guest's
 * panel — naming a studio they do not administer, its projects, and what was
 * generated in them.
 *
 * So both reads narrow to the studios the reader administers. The list keeps
 * one more thing, and that is the half easy to lose: a run that belongs to no
 * studio at all. The text tools carry no project, and a project deleted while
 * its task was running leaves the same shape — the reader ran those, so they
 * stay. The per-studio totals have nowhere to put them and do not.
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
import { initCore } from "@breatic/core";
import { creditLotRepo } from "@breatic/domain";

const PG_DRIVER_LOCAL = "credit-narrowing-test-driver";

let sql: ReturnType<typeof postgres>;

beforeAll(() => {
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
 * One account.
 * @returns Its id.
 */
async function seedUser(): Promise<string> {
  const rows = await sql<{ id: string }[]>`
    INSERT INTO users (email, email_verified)
    VALUES (${`narrow-${seq++}@example.test`}, true) RETURNING id
  `;
  return rows[0]!.id;
}

/**
 * One team studio, with whoever administers it.
 *
 * Required, so a studio with no admin cannot be seeded here: the role half of
 * the predicate refuses one on its own, which would leave the half asking
 * whose studio it is unread.
 * @param adminUserId - Who administers it.
 * @returns Its id.
 */
async function seedStudio(adminUserId: string): Promise<string> {
  const rows = await sql<{ id: string }[]>`
    INSERT INTO studios (created_by_user_id, slug, type, name)
    VALUES (${adminUserId}, ${`narrow-s-${seq++}`}, 'team', 'Narrow') RETURNING id
  `;
  const id = rows[0]!.id;
  await sql`
    INSERT INTO studio_members (studio_id, user_id, role)
    VALUES (${id}, ${adminUserId}, 'admin')
  `;
  return id;
}

/**
 * One spend against this account's credits.
 * @param payerUserId - Whose credits moved.
 * @param studioId - Where it was spent; null for a run belonging to no studio.
 * @param amount - How much, as a positive figure; written negative.
 * @returns Nothing.
 */
async function seedSpend(
  payerUserId: string,
  studioId: string | null,
  amount: number,
): Promise<void> {
  await sql`
    INSERT INTO credit_ledger
      (payer_user_id, actor_user_id, studio_id, entry_type, amount, reference_id)
    VALUES (${payerUserId}, ${payerUserId}, ${studioId}, 'spend', ${-amount},
            ${`ref-${seq++}`})
  `;
}

describe("the account's own activity, narrowed to what it administers", () => {
  it("keeps what was spent in a studio the reader administers", async () => {
    const reader = await seedUser();
    const mine = await seedStudio(reader);
    await seedSpend(reader, mine, 5);

    const rows = await creditLotRepo.listLedgerByPayer(reader, 20, null);
    expect(rows.map((r) => r.studioId)).toEqual([mine]);
  });

  it("drops what was spent in a studio somebody else administers", async () => {
    // The reader is a guest here: their credits paid for the run, and the
    // studio, its projects and what ran in them are not theirs to read.
    // Somebody else really administers it — a studio with no admin at all
    // would be dropped by the role half of the predicate alone, and the half
    // that asks whose studio it is would go unread.
    const reader = await seedUser();
    const theirs = await seedStudio(await seedUser());
    await seedSpend(reader, theirs, 5);

    const rows = await creditLotRepo.listLedgerByPayer(reader, 20, null);
    expect(rows).toEqual([]);

    // Dropped from the reader's own view, not from the books: the studio's
    // side still carries it, which is what makes this a narrowing rather
    // than a deletion.
    const theirSide = await creditLotRepo.listLedgerByStudio(theirs, 20, null);
    expect(theirSide.map((r) => r.actorUserId)).toEqual([reader]);
  });

  it("keeps a run that belongs to no studio", async () => {
    const reader = await seedUser();
    await seedSpend(reader, null, 3);

    const rows = await creditLotRepo.listLedgerByPayer(reader, 20, null);
    expect(rows.map((r) => r.studioId)).toEqual([null]);
  });

  it("pages to the end without handing over an empty page", async () => {
    // What the narrowing costs if it is done after the read instead of
    // inside it: a page whose rows were all dropped comes back empty while
    // the cursor still says there is more, and the reader sees the list end
    // early. Every case above holds one row and asks for twenty, so none of
    // them can tell the two apart.
    const reader = await seedUser();
    const mine = await seedStudio(reader);
    const theirs = await seedStudio(await seedUser());
    for (let i = 0; i < 3; i += 1) {
      await seedSpend(reader, theirs, 1);
      await seedSpend(reader, mine, 1);
    }

    const seen: string[] = [];
    let cursor: { createdAt: string; id: string } | null = null;
    // Bounded so a cursor that never advances fails as a test rather than
    // hanging the suite.
    for (let page = 0; page < 10; page += 1) {
      const rows = await creditLotRepo.listLedgerByPayer(reader, 2, cursor);
      expect(
        rows.length,
        "an empty page while the cursor said there was more",
      ).toBeGreaterThan(0);
      seen.push(...rows.map((r) => r.id));
      if (rows.length < 2) break;
      const last = rows.at(-1)!;
      cursor = { createdAt: last.cursorAt, id: last.id };
    }

    expect(seen).toHaveLength(3);
    expect(new Set(seen).size).toBe(3);
  });

  it("stops administering and the rows go with it", async () => {
    // Read fresh rather than carried: the answer is who administers the
    // studio now, not who did when the credits moved.
    const reader = await seedUser();
    const studio = await seedStudio(reader);
    await seedSpend(reader, studio, 5);

    await sql`
      UPDATE studio_members SET deleted_at = now()
      WHERE studio_id = ${studio} AND user_id = ${reader}
    `;

    expect(await creditLotRepo.listLedgerByPayer(reader, 20, null)).toEqual([]);
  });
});

describe("the per-studio totals, narrowed the same way", () => {
  it("totals a studio the reader administers", async () => {
    const reader = await seedUser();
    const mine = await seedStudio(reader);
    await seedSpend(reader, mine, 7);

    const rows = await creditLotRepo.sumSpentByStudio(reader);
    expect(rows.map((r) => r.studioId)).toEqual([mine]);
    expect(Number(rows[0]!.spent)).toBe(7);
  });

  it("leaves out a studio somebody else administers", async () => {
    const reader = await seedUser();
    const theirs = await seedStudio(await seedUser());
    await seedSpend(reader, theirs, 7);

    expect(await creditLotRepo.sumSpentByStudio(reader)).toEqual([]);
  });

  it("has nowhere to put a run that belongs to no studio, and leaves it out", async () => {
    // The list above keeps this row. Here the answer is one line per studio,
    // and a run that was in none has no line — which is why the two reads
    // share the administering test and not the whole predicate.
    const reader = await seedUser();
    await seedSpend(reader, null, 3);

    expect(await creditLotRepo.sumSpentByStudio(reader)).toEqual([]);
  });
});
