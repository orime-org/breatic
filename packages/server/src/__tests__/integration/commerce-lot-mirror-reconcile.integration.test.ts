// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The daily lot-mirror reconcile (inner#1993 §5.4): every bought lot that
 * changed within the window, whatever its lifecycle, has its current lifecycle
 * appended to the outbox once more, read under the lot's lock, so the billing
 * service's mirror converges even when a delivery was lost.
 */

import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { closeDb, initCore } from "@breatic/core";
import { creditLotService } from "@breatic/domain";

let sql: ReturnType<typeof postgres>;

/** Core configured to sell through a billing service. */
function sellingCore(): void {
  initCore({
    ...process.env,
    CHARGING_ENABLED: "true",
    INTERNAL_API_ENABLED: "true",
    INTERNAL_API_SECRET: "internal-secret-current-0123456789abcdef",
    COMMERCE_API_URL: "http://127.0.0.1:9",
    COMMERCE_API_SECRET: "commerce-secret-current-0123456789abcdef",
  });
}

beforeAll(() => {
  sellingCore();
  sql = postgres(inject("DATABASE_URL"), { max: 2, prepare: false, connection: { application_name: "commerce-lot-mirror-test" } });
});

afterAll(async () => {
  await sql?.end({ timeout: 1 });
  await closeDb();
  initCore(process.env);
});

/**
 * One lot, inserted as it would stand.
 * @param kind - Its source kind.
 * @param lifecycle - Its lifecycle.
 * @param daysAgo - When it last changed.
 * @returns Its id, source and owner.
 */
async function lot(kind: "payment" | "gift", lifecycle: string, daysAgo: number): Promise<{ lotId: string; sourceId: string; userId: string }> {
  const userId = randomUUID();
  const sourceId = randomUUID();
  await sql`INSERT INTO users(id,email) VALUES (${userId},${`${userId}@example.test`})`;
  await sql`INSERT INTO credit_sources(id,kind) VALUES (${sourceId},${kind})`;
  const [row] = await sql<{ id: string }[]>`
    INSERT INTO credit_lots(source_id,source_kind,user_id,purchased_credits,remaining_credits,lifecycle,created_at,updated_at)
    VALUES (${sourceId},${kind},${userId},1000,1000,${lifecycle},now() - make_interval(days => ${daysAgo + 1}),now() - make_interval(days => ${daysAgo}))
    RETURNING id`;
  return { lotId: row!.id, sourceId, userId };
}

/**
 * The lifecycles appended for one lot.
 * @param lotId - The lot.
 * @returns Each event's payload, oldest first.
 */
async function appended(lotId: string): Promise<unknown[]> {
  const rows = await sql<{ payload: unknown }[]>`SELECT payload FROM commerce_outbox WHERE aggregate_key = ${`lot:${lotId}`} ORDER BY seq`;
  return rows.map((r) => r.payload);
}

describe("resendLotMirror", () => {
  it("resends every bought lot changed within the window, and none changed before it", async () => {
    const recent = await lot("payment", "active", 2);
    const refundedRecently = await lot("payment", "refunded", 2);
    const settled = await lot("payment", "active", 90);
    // A lot in a final state reached the mirror on its first delivery; long
    // after, it changes nothing there and is not sent again.
    const refundedLongAgo = await lot("payment", "refunded", 400);
    const depletedLongAgo = await lot("payment", "depleted", 60);
    const deletedRecently = await lot("payment", "depleted", 2);
    await sql`UPDATE credit_lots SET deleted_at = now() WHERE id = ${deletedRecently.lotId}`;
    const gift = await lot("gift", "refunded", 2);

    await creditLotService.resendLotMirror(30);

    expect(await appended(recent.lotId)).toEqual([{ lotId: recent.lotId, paymentId: recent.sourceId, userId: recent.userId, lifecycle: "active" }]);
    expect(await appended(refundedRecently.lotId)).toEqual([
      { lotId: refundedRecently.lotId, paymentId: refundedRecently.sourceId, userId: refundedRecently.userId, lifecycle: "refunded" },
    ]);
    expect(await appended(deletedRecently.lotId)).toHaveLength(1);
    expect(await appended(settled.lotId)).toEqual([]);
    expect(await appended(refundedLongAgo.lotId)).toEqual([]);
    expect(await appended(depletedLongAgo.lotId)).toEqual([]);
    expect(await appended(gift.lotId)).toEqual([]);
  });

  it("resends nothing while the deployment sells nothing", async () => {
    const refunded = await lot("payment", "refunded", 2);
    initCore(process.env);
    try {
      await creditLotService.resendLotMirror(30);
    } finally {
      sellingCore();
    }

    expect(await appended(refunded.lotId)).toEqual([]);
  });
});

describe("resendLotStates", () => {
  it("appends each lot's current lifecycle, whatever an older event said, and skips ids that are no bought lot", async () => {
    // A lot whose refund was later restored: a dead-lettered "refunded" event
    // must not reach the mirror after the "active" one.
    const restored = await lot("payment", "active", 400);
    const gift = await lot("gift", "refunded", 2);

    await creditLotService.resendLotStates([restored.lotId, gift.lotId, randomUUID()]);

    expect(await appended(restored.lotId)).toEqual([{ lotId: restored.lotId, paymentId: restored.sourceId, userId: restored.userId, lifecycle: "active" }]);
    expect(await appended(gift.lotId)).toEqual([]);
  });
});
