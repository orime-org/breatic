// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-Breatic-Source-Available-2.0

/**
 * Requeueing dead letters (inner#1993 §5.2): an operator picks dead-lettered
 * outbox rows by id, or by reason and since when they failed, and each goes
 * back into `commerce_outbox` as a new unsent row with the same type,
 * aggregate and payload, while the dead letter stays, marked requeued, in the
 * same transaction as everything else the requeue writes. A requeued row has
 * a new id and seq, so the billing service applies it again; requeueing twice
 * makes two rows, and each event type must be idempotent there.
 */

import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, inject, it } from "vitest";
import { closeDb, commerceOutboxRepo, db, initCore } from "@breatic/core";

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

/**
 * A lot resender that must not be reached.
 * @returns Never.
 * @throws {Error} Always.
 */
async function noLots(): Promise<number> {
  throw new Error("no lot was expected");
}

beforeAll(() => {
  sellingCore();
  sql = postgres(inject("DATABASE_URL"), { max: 2, prepare: false, connection: { application_name: "commerce-requeue-test" } });
});

beforeEach(async () => {
  // Rows other files left would be claimed alongside this file's own.
  await sql`DELETE FROM commerce_outbox`;
});

afterAll(async () => {
  await sql?.end({ timeout: 1 });
  await closeDb();
  initCore(process.env);
});

/**
 * One dead-lettered row, as the relay leaves it.
 * @param reason - Why it was given up.
 * @param failedDaysAgo - How many days ago it was given up.
 * @returns Its id, aggregate and payload.
 */
async function deadLetter(reason: string, failedDaysAgo = 0): Promise<{ id: string; aggregateKey: string; payload: Record<string, unknown> }> {
  const id = randomUUID();
  const userId = randomUUID();
  const aggregateKey = `referral:${userId}`;
  const payload = { userId, code: "PROMO1", source: "email", requestedAt: "2026-11-20T10:00:00.000Z" };
  const [next] = await sql<{ seq: string }[]>`SELECT (COALESCE(MAX(seq), 0) + 1000000)::text AS seq FROM commerce_outbox_dead_letters`;
  await sql`
    INSERT INTO commerce_outbox_dead_letters(id,seq,aggregate_key,type,payload,attempts,last_error,reason,created_at,failed_at)
    VALUES (${id},${next!.seq},${aggregateKey},'referral_binding',${sql.json(payload)},50,'unavailable',${reason},now() - interval '3 days',now() - make_interval(days => ${failedDaysAgo}))`;
  return { id, aggregateKey, payload };
}

/**
 * The unsent outbox rows of one aggregate.
 * @param aggregateKey - The aggregate.
 * @returns Each row, oldest first.
 */
async function unsent(aggregateKey: string): Promise<Array<{ id: string; type: string; payload: unknown; attempts: number }>> {
  return await sql<Array<{ id: string; type: string; payload: unknown; attempts: number }>>`
    SELECT id, type, payload, attempts FROM commerce_outbox
    WHERE aggregate_key = ${aggregateKey} AND sent_at IS NULL ORDER BY seq`;
}

/**
 * When a dead letter was marked requeued.
 * @param id - The dead letter.
 * @returns The instant, or null.
 */
async function requeuedAt(id: string): Promise<Date | null> {
  const [row] = await sql<{ requeued_at: Date | null }[]>`SELECT requeued_at FROM commerce_outbox_dead_letters WHERE id = ${id}`;
  return row!.requeued_at;
}

/**
 * One dead-lettered lot lifecycle event.
 * @returns Its id and lot.
 */
async function lotDeadLetter(): Promise<{ id: string; lotId: string }> {
  const id = randomUUID();
  const lotId = randomUUID();
  const [next] = await sql<{ seq: string }[]>`SELECT (COALESCE(MAX(seq), 0) + 1000000)::text AS seq FROM commerce_outbox_dead_letters`;
  await sql`
    INSERT INTO commerce_outbox_dead_letters(id,seq,aggregate_key,type,payload,attempts,last_error,reason,created_at,failed_at)
    VALUES (${id},${next!.seq},${`lot:${lotId}`},'lot_refund_lifecycle',${sql.json({ lotId, paymentId: randomUUID(), userId: randomUUID(), lifecycle: "refunded" })},50,'unavailable','attempts_exhausted',now(),now())`;
  return { id, lotId };
}

describe("requeueing dead letters", () => {
  it("puts a dead letter back as a new unsent row with the same payload, keeps the dead letter and marks it requeued", async () => {
    const letter = await deadLetter("attempts_exhausted");

    const listed = await commerceOutboxRepo.listDeadLetters({ ids: [letter.id] });
    expect(listed).toEqual([expect.objectContaining({ id: letter.id, aggregateKey: letter.aggregateKey, type: "referral_binding", reason: "attempts_exhausted", requeuedAt: null })]);

    const result = await commerceOutboxRepo.requeueDeadLetters(listed.map((r) => r.id), noLots);

    const rows = await unsent(letter.aggregateKey);
    expect(rows).toEqual([{ id: result.requeued[0]!.outboxId, type: "referral_binding", payload: letter.payload, attempts: 0 }]);
    expect(result).toEqual({ requeued: [{ deadLetterId: letter.id, outboxId: expect.any(String) }], lotsResent: 0 });
    expect(result.requeued[0]!.outboxId).not.toBe(letter.id);
    expect(await requeuedAt(letter.id)).toBeInstanceOf(Date);
    const [again] = await commerceOutboxRepo.listDeadLetters({ ids: [letter.id] });
    expect(again!.requeuedAt).toBeInstanceOf(Date);
    // The relay's own claim takes it.
    const claimed = await db.transaction(async (tx) => commerceOutboxRepo.claimNextDue(tx));
    expect(claimed).toMatchObject({ aggregateKey: letter.aggregateKey, payload: letter.payload });
  });

  it("makes a second row when requeued twice", async () => {
    const letter = await deadLetter("refused");

    await commerceOutboxRepo.requeueDeadLetters([letter.id], noLots);
    await commerceOutboxRepo.requeueDeadLetters([letter.id], noLots);

    const rows = await unsent(letter.aggregateKey);
    expect(rows).toHaveLength(2);
    expect(new Set(rows.map((r) => r.id)).size).toBe(2);
    expect(rows.map((r) => r.payload)).toEqual([letter.payload, letter.payload]);
  });

  it("selects by reason and since when they failed, listing the ones already requeued with when", async () => {
    const recent = await deadLetter("permanent_failure_requeue_case");
    const done = await deadLetter("permanent_failure_requeue_case");
    const old = await deadLetter("permanent_failure_requeue_case", 10);
    const other = await deadLetter("refused_requeue_case");
    await commerceOutboxRepo.requeueDeadLetters([done.id], noLots);

    const listed = await commerceOutboxRepo.listDeadLetters({ reason: "permanent_failure_requeue_case", since: new Date(Date.now() - 24 * 3600 * 1000) });

    expect(listed.map((r) => [r.id, r.requeuedAt === null])).toEqual([
      [recent.id, true],
      [done.id, false],
    ]);
    expect(old.id).not.toBe(other.id);
  });

  it("resends a lot lifecycle dead letter as its lot's current state, never copying it back, and marks it requeued", async () => {
    const letter = await lotDeadLetter();
    const asked: string[][] = [];

    const result = await commerceOutboxRepo.requeueDeadLetters([letter.id], async (lotIds) => {
      asked.push(lotIds);
      return lotIds.length;
    });

    expect(result).toEqual({ requeued: [], lotsResent: 1 });
    expect(asked).toEqual([[letter.lotId]]);
    expect(await unsent(`lot:${letter.lotId}`)).toEqual([]);
    expect(await requeuedAt(letter.id)).toBeInstanceOf(Date);
  });

  it("writes nothing at all when resending a lot fails", async () => {
    const letter = await deadLetter("attempts_exhausted");
    const lotLetter = await lotDeadLetter();

    await expect(
      commerceOutboxRepo.requeueDeadLetters([letter.id, lotLetter.id], async () => {
        throw new Error("lock timeout");
      }),
    ).rejects.toThrow("lock timeout");

    expect(await unsent(letter.aggregateKey)).toEqual([]);
    expect(await requeuedAt(letter.id)).toBeNull();
    expect(await requeuedAt(lotLetter.id)).toBeNull();
  });

  it("refuses where nothing is sold, since no relay would send the rows", async () => {
    const letter = await deadLetter("attempts_exhausted");
    initCore(process.env);
    try {
      await expect(commerceOutboxRepo.requeueDeadLetters([letter.id], noLots)).rejects.toThrow(/COMMERCE_API_URL is not set/);
    } finally {
      sellingCore();
    }

    expect(await unsent(letter.aggregateKey)).toEqual([]);
    expect(await requeuedAt(letter.id)).toBeNull();
  });

  it("requeues nothing for ids that are not dead letters", async () => {
    expect(await commerceOutboxRepo.listDeadLetters({ ids: [randomUUID()] })).toEqual([]);
    expect(await commerceOutboxRepo.requeueDeadLetters([randomUUID()], noLots)).toEqual({ requeued: [], lotsResent: 0 });
  });
});
