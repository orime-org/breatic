// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * `credit_lots.source_kind` — where a lot's credits came from, on the lot
 * itself (task #267).
 *
 * Trial credits are the first lot that is not a payment, and three decisions
 * turn on the kind: a non-purchased lot cannot be re-designated, cannot be
 * refunded, and prints its origin instead of a price. Every one of those
 * readers holds a lot row and nothing else, so the kind has to be readable
 * from that row without a join — which is what `payments` already does with
 * the same pair of columns.
 *
 * Structural promises, each with the failure it pins:
 *
 *   1. `source_kind` is NOT NULL. A lot whose origin is unknown would have to
 *      be treated as purchased or as granted, and either answer is wrong for
 *      half the rows.
 *
 *   2. The foreign key is composite: `(source_id, source_kind)` →
 *      `credit_sources (id, kind)`. Without it the database accepts a lot
 *      claiming `payment` while its receipt says `gift`, and every one of the
 *      three decisions above then reads the wrong answer off the lot.
 *
 *   3. Lots written before this column existed read as `payment`. Every lot
 *      that exists today came from a payment, so the backfill is the truth
 *      about them rather than a default.
 *
 * Runs against the testcontainer Postgres started by global-setup.ts, so what
 * it reads is the schema the migration actually produced.
 */

import { describe, it, expect, beforeAll, afterAll, inject } from "vitest";
import postgres from "postgres";

const PG_DRIVER_LOCAL = "trial-credits-schema-test-driver";

let sql: ReturnType<typeof postgres>;

beforeAll(() => {
  sql = postgres(inject("DATABASE_URL"), {
    max: 4,
    prepare: false,
    connection: { application_name: PG_DRIVER_LOCAL },
  });
});

afterAll(async () => {
  await sql?.end({ timeout: 1 });
});

let seq = 0;

/**
 * One account.
 * @returns Its id.
 */
async function seedUser(): Promise<string> {
  const rows = await sql<{ id: string }[]>`
    INSERT INTO users (email, email_verified)
    VALUES (${`lotkind-${seq++}@example.test`}, true) RETURNING id
  `;
  return rows[0]!.id;
}

/**
 * One receipt of the given kind.
 * @param kind - Which kind of receipt it is.
 * @param id - The id to open it under; a fresh uuid when omitted.
 * @returns Its id.
 */
async function seedSource(kind: string, id?: string): Promise<string> {
  const rows = await sql<{ id: string }[]>`
    INSERT INTO credit_sources (id, kind)
    VALUES (${id ?? sql`gen_random_uuid()`}, ${kind}) RETURNING id
  `;
  return rows[0]!.id;
}

/**
 * One lot, written directly so the constraint is what answers.
 * @param sourceId - The receipt it points at.
 * @param sourceKind - What the lot claims that receipt is.
 * @param userId - Whose credits.
 * @returns Nothing; the insert either lands or throws.
 */
async function seedLot(
  sourceId: string,
  sourceKind: string,
  userId: string,
): Promise<void> {
  await sql`
    INSERT INTO credit_lots
      (source_id, source_kind, user_id, purchased_credits, remaining_credits, lifecycle)
    VALUES (${sourceId}, ${sourceKind}, ${userId}, 100, 100, 'active')
  `;
}

describe("credit_lots.source_kind", () => {
  it("is a column every lot must fill", async () => {
    const rows = await sql<{ is_nullable: string }[]>`
      SELECT is_nullable
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = 'credit_lots'
        AND column_name = 'source_kind'
    `;

    // Asserted before the value is read: with the column missing the row is
    // absent and an optional chain would let "is nullable" pass quietly.
    expect(rows.length, "credit_lots.source_kind does not exist").toBe(1);
    expect(rows[0]!.is_nullable).toBe("NO");
  });

  it("refuses a lot that claims an origin its receipt does not have", async () => {
    const userId = await seedUser();
    const giftSource = await seedSource("gift");

    await expect(seedLot(giftSource, "payment", userId)).rejects.toThrow(
      /credit_lots_source_fk/,
    );
  });

  it("takes a lot whose claim matches its receipt", async () => {
    const userId = await seedUser();
    const giftSource = await seedSource("gift");

    await expect(seedLot(giftSource, "gift", userId)).resolves.toBeUndefined();

    const rows = await sql<{ source_kind: string }[]>`
      SELECT source_kind FROM credit_lots WHERE source_id = ${giftSource}
    `;
    expect(rows[0]!.source_kind).toBe("gift");
  });

  it("reads every lot that predates the column as a payment", async () => {
    // The backfill, asserted through the rows the earlier migrations left:
    // a lot pointing at a `payment` receipt says `payment`. Written as a
    // count over the join so it holds whatever those rows are, rather than
    // naming one of them.
    const rows = await sql<{ mismatched: number }[]>`
      SELECT count(*)::int AS mismatched
      FROM credit_lots l
      JOIN credit_sources s ON s.id = l.source_id
      WHERE l.source_kind IS DISTINCT FROM s.kind
    `;
    expect(rows[0]!.mismatched).toBe(0);
  });
});
