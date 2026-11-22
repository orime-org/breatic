// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Requeueing dead letters (inner#1993 §5.2): an operator picks dead-lettered
 * outbox rows by id, or by reason and since when they failed, and each goes
 * back into `commerce_outbox` as a new unsent row with the same type,
 * aggregate and payload, while the dead letter stays. Requeueing twice makes
 * two rows; the billing service's inbox dedupes them by its own rules.
 */

import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, inject, it } from "vitest";
import { closeDb, commerceOutboxRepo, db, initCore } from "@breatic/core";

let sql: ReturnType<typeof postgres>;

beforeAll(() => {
  initCore(process.env);
  sql = postgres(inject("DATABASE_URL"), { max: 2, prepare: false, connection: { application_name: "commerce-requeue-test" } });
});

beforeEach(async () => {
  // Rows other files left would be claimed alongside this file's own.
  await sql`DELETE FROM commerce_outbox`;
});

afterAll(async () => {
  await sql?.end({ timeout: 1 });
  await closeDb();
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

describe("requeueing dead letters", () => {
  it("puts a dead letter back as a new unsent row with the same payload and keeps the dead letter", async () => {
    const letter = await deadLetter("attempts_exhausted");

    const listed = await commerceOutboxRepo.listDeadLetters({ ids: [letter.id] });
    expect(listed).toEqual([expect.objectContaining({ id: letter.id, aggregateKey: letter.aggregateKey, type: "referral_binding", reason: "attempts_exhausted" })]);

    const requeued = await commerceOutboxRepo.requeueDeadLetters(listed.map((r) => r.id));

    const rows = await unsent(letter.aggregateKey);
    expect(rows).toEqual([{ id: requeued[0]!.outboxId, type: "referral_binding", payload: letter.payload, attempts: 0 }]);
    expect(requeued).toEqual([{ deadLetterId: letter.id, outboxId: expect.any(String) }]);
    expect(requeued[0]!.outboxId).not.toBe(letter.id);
    const [kept] = await sql`SELECT id FROM commerce_outbox_dead_letters WHERE id = ${letter.id}`;
    expect(kept).toBeDefined();
    // The relay's own claim takes it.
    const claimed = await db.transaction(async (tx) => commerceOutboxRepo.claimNextDue(tx));
    expect(claimed).toMatchObject({ aggregateKey: letter.aggregateKey, payload: letter.payload });
  });

  it("makes a second row when requeued twice", async () => {
    const letter = await deadLetter("refused");

    await commerceOutboxRepo.requeueDeadLetters([letter.id]);
    await commerceOutboxRepo.requeueDeadLetters([letter.id]);

    const rows = await unsent(letter.aggregateKey);
    expect(rows).toHaveLength(2);
    expect(new Set(rows.map((r) => r.id)).size).toBe(2);
    expect(rows.map((r) => r.payload)).toEqual([letter.payload, letter.payload]);
  });

  it("selects by reason and since when they failed", async () => {
    const recent = await deadLetter("permanent_failure_requeue_case");
    const old = await deadLetter("permanent_failure_requeue_case", 10);
    const other = await deadLetter("refused_requeue_case");

    const listed = await commerceOutboxRepo.listDeadLetters({ reason: "permanent_failure_requeue_case", since: new Date(Date.now() - 24 * 3600 * 1000) });

    expect(listed.map((r) => r.id)).toEqual([recent.id]);
    expect(old.id).not.toBe(other.id);
  });

  it("leaves a lot lifecycle dead letter to the lot's current state: it is not copied back", async () => {
    const id = randomUUID();
    const lotId = randomUUID();
    const [next] = await sql<{ seq: string }[]>`SELECT (COALESCE(MAX(seq), 0) + 1000000)::text AS seq FROM commerce_outbox_dead_letters`;
    await sql`
      INSERT INTO commerce_outbox_dead_letters(id,seq,aggregate_key,type,payload,attempts,last_error,reason,created_at,failed_at)
      VALUES (${id},${next!.seq},${`lot:${lotId}`},'lot_refund_lifecycle',${sql.json({ lotId, paymentId: randomUUID(), userId: randomUUID(), lifecycle: "refunded" })},50,'unavailable','attempts_exhausted',now(),now())`;

    expect(await commerceOutboxRepo.requeueDeadLetters([id])).toEqual([]);
    expect(await unsent(`lot:${lotId}`)).toEqual([]);
  });

  it("requeues nothing for ids that are not dead letters", async () => {
    expect(await commerceOutboxRepo.listDeadLetters({ ids: [randomUUID()] })).toEqual([]);
    expect(await commerceOutboxRepo.requeueDeadLetters([randomUUID()])).toEqual([]);
  });
});
