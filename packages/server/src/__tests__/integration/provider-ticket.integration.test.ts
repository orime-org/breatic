// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * What a task row holds for a media run provider serves (inner#1743): the
 * ticket stored before every paid request, written only over an older one;
 * the mark of a send in flight; a completion whose cost is still being looked
 * up, billed later by its own compare-and-set; and the hold kept alive while
 * it waits.
 *
 * Runs against the testcontainer Postgres started by @breatic/integration-tests/containers, so what
 * it reads is the schema the migration actually produced.
 */

import { describe, it, expect, beforeAll, afterAll, inject } from "vitest";
import postgres from "postgres";
import { db, initCore } from "@breatic/core";
import { creditHoldService, taskRepo, taskService } from "@breatic/domain";

try {
  initCore(process.env);
} catch {
  // already initialised by a sibling suite in this worker — fine.
}

let sql: ReturnType<typeof postgres>;

beforeAll(() => {
  sql = postgres(inject("DATABASE_URL"), { max: 4, prepare: false });
});

afterAll(async () => {
  await sql?.end({ timeout: 1 });
});

/**
 * A user, the studio they created and a task of theirs.
 * @returns The ids.
 */
async function seedTask(): Promise<{ userId: string; studioId: string; taskId: string }> {
  const tag = crypto.randomUUID().slice(0, 8);
  const [user] = await sql<{ id: string }[]>`
    INSERT INTO users (email, email_verified) VALUES (${`ticket-${tag}@test.local`}, true) RETURNING id
  `;
  const [studio] = await sql<{ id: string }[]>`
    INSERT INTO studios (created_by_user_id, slug, type, name)
    VALUES (${user!.id}, ${`ticket-${tag}`}, 'personal', 'Ticket') RETURNING id
  `;
  const [task] = await sql<{ id: string }[]>`
    INSERT INTO tasks (user_id, space_id, task_type, mode, status)
    VALUES (${user!.id}, ${crypto.randomUUID()}, 'image', 'append', 'running') RETURNING id
  `;
  return { userId: user!.id, studioId: studio!.id, taskId: task!.id };
}

/**
 * The task row as stored.
 * @param taskId - The task.
 * @returns Its billing and status columns.
 */
async function rowOf(taskId: string): Promise<{
  status: string;
  billed_at: Date | null;
  billed_credits: number | null;
  credits_used: number;
  result: Record<string, unknown> | null;
  error_message: string | null;
}> {
  const [row] = await sql<
    { status: string; billed_at: Date | null; billed_credits: number | null; credits_used: number; result: Record<string, unknown> | null; error_message: string | null }[]
  >`SELECT status, billed_at, billed_credits, credits_used, result, error_message FROM tasks WHERE id = ${taskId}`;
  return row!;
}

describe("the ticket a task holds", () => {
  it("starts with none, and stores one with its version", async () => {
    const { taskId } = await seedTask();
    expect(await taskRepo.getProviderTicket(taskId)).toEqual({ ticket: null, sendingAt: null });

    expect(await taskRepo.storeTicket(taskId, { version: 1, state: "send" })).toBe(true);

    expect(await taskRepo.getProviderTicket(taskId)).toEqual({ ticket: { version: 1, state: "send" }, sendingAt: null });
  });

  it("writes a ticket only over an older one, so a stale run cannot write back an old ticket", async () => {
    const { taskId } = await seedTask();
    await taskRepo.storeTicket(taskId, { version: 3, state: "running" });

    expect(await taskRepo.storeTicket(taskId, { version: 2, state: "send" })).toBe(false);
    expect(await taskRepo.storeTicket(taskId, { version: 3, state: "send" })).toBe(false);
    expect((await taskRepo.getProviderTicket(taskId)).ticket).toEqual({ version: 3, state: "running" });

    expect(await taskRepo.storeTicket(taskId, { version: 4, state: "running" })).toBe(true);
  });

  it("marks a send in flight and clears the mark", async () => {
    const { taskId } = await seedTask();
    await taskRepo.markSending(taskId);
    expect((await taskRepo.getProviderTicket(taskId)).sendingAt).toBeInstanceOf(Date);

    await taskRepo.clearSending(taskId);
    expect((await taskRepo.getProviderTicket(taskId)).sendingAt).toBeNull();
  });

  it("is never on the task entity a route or a browser reads", async () => {
    const { taskId } = await seedTask();
    await taskRepo.storeTicket(taskId, { version: 1, secret: "upstream state" });

    const entity = await taskRepo.getTaskById(taskId);

    expect(JSON.stringify(entity)).not.toContain("upstream state");
    expect(entity).not.toHaveProperty("providerTicket");
    expect(entity).not.toHaveProperty("providerSendingAt");
  });
});

describe("a completion whose cost is still being looked up", () => {
  const WAITING = { url: "https://x/a.png", costWait: { knownCredits: 2, lookups: 0, servedBy: "fal" }, pendingCosts: [{ state: "pending" }] };

  it("completes the task without billing it, and only the first call wins", async () => {
    const { taskId } = await seedTask();

    expect(await taskService.markCompleted(taskId, WAITING, 1200)).toBe(true);
    expect(await taskService.markCompleted(taskId, WAITING, 1200)).toBe(false);

    const row = await rowOf(taskId);
    expect(row.status).toBe("completed");
    expect(row.billed_at).toBeNull();
    expect(row.result).toEqual(WAITING);
  });

  it("writes what the lookups found back while it waits, and nothing once billed", async () => {
    const { taskId } = await seedTask();
    await taskService.markCompleted(taskId, WAITING, 1200);
    const found = { ...WAITING, costWait: { ...WAITING.costWait, lookups: 1 } };

    expect(await taskRepo.updateCostWait(taskId, found)).toBe(true);
    expect((await rowOf(taskId)).result).toEqual(found);

    await db.transaction((tx) => taskRepo.markBilled(taskId, 5, tx));
    expect(await taskRepo.updateCostWait(taskId, WAITING)).toBe(false);
    expect((await rowOf(taskId)).result).toEqual(found);
  });

  it("is billed once, by whichever call first sets billed_at", async () => {
    const { taskId } = await seedTask();
    await taskService.markCompleted(taskId, WAITING, 1200);

    expect(await db.transaction((tx) => taskRepo.markBilled(taskId, 5.25, tx))).toBe(true);
    expect(await db.transaction((tx) => taskRepo.markBilled(taskId, 9, tx))).toBe(false);

    const row = await rowOf(taskId);
    expect(row.billed_at).toBeInstanceOf(Date);
    expect(row.billed_credits).toBe(5.25);
    expect(row.credits_used).toBe(5.25);
  });

  it("is not turned failed by a stale run's failure while it waits", async () => {
    const { taskId } = await seedTask();
    await taskService.markCompleted(taskId, WAITING, 1200);

    expect(await taskService.markFailed(taskId, "late failure")).toBe(false);

    const row = await rowOf(taskId);
    expect(row.status).toBe("completed");
    expect(row.error_message).toBeNull();
  });

  it("leaves markFailed writing every other row", async () => {
    const { taskId } = await seedTask();

    expect(await taskService.markFailed(taskId, "upstream refused")).toBe(true);

    expect(await rowOf(taskId)).toMatchObject({ status: "failed", error_message: "upstream refused" });
  });
});

describe("the hold of a task waiting on its cost", () => {
  it("is extended to a later expiry and never shortened", async () => {
    const { userId, studioId, taskId } = await seedTask();
    const soon = new Date(Date.now() + 60_000);
    await sql`
      INSERT INTO credit_holds (studio_id, actor_user_id, reference_id, amount, expires_at)
      VALUES (${studioId}, ${userId}, ${taskId}, '3', ${soon})
    `;
    const later = new Date(Date.now() + 3_600_000);

    await creditHoldService.extendHold(taskId, later);
    await creditHoldService.extendHold(taskId, soon);

    const [hold] = await sql<{ expires_at: Date; status: string }[]>`SELECT expires_at, status FROM credit_holds WHERE reference_id = ${taskId}`;
    expect(hold!.expires_at.getTime()).toBe(later.getTime());
    expect(hold!.status).toBe("held");
  });

  it("leaves a released hold released", async () => {
    const { userId, studioId, taskId } = await seedTask();
    await sql`
      INSERT INTO credit_holds (studio_id, actor_user_id, reference_id, amount, expires_at, status, released_at)
      VALUES (${studioId}, ${userId}, ${taskId}, '3', ${new Date(Date.now() + 60_000)}, 'released', now())
    `;

    await creditHoldService.extendHold(taskId, new Date(Date.now() + 3_600_000));

    const [hold] = await sql<{ status: string }[]>`SELECT status FROM credit_holds WHERE reference_id = ${taskId}`;
    expect(hold!.status).toBe("released");
  });
});
