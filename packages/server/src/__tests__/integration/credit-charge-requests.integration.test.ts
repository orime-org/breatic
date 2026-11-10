// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * Charge requests on a real Postgres (inner#1617).
 *
 * A delivered result is charged through a `credit_charge_requests` row that
 * commits with the delivery and is settled exactly once, by whoever gets to it
 * first: the process that delivered, a re-entered task, or the sweep. Every
 * guarantee here is a transaction or a row lock, which a stubbed query builder
 * cannot answer.
 */

import { describe, it, expect, beforeAll, afterAll, inject, vi } from "vitest";

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

import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { db, initCore, loadLocales } from "@breatic/core";
import { creditHoldService, creditLotService, taskService } from "@breatic/domain";
import { waitUntilBlockedOn } from "@server/__tests__/integration/lock-probe.js";
import {
  seedDesignatedLot,
  seedStudioFixture,
  type StudioFixture,
} from "@server/__tests__/integration/studio-credit-fixtures.js";

const APP = "credit-charge-requests-test";
const HOUR = 3_600_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

let sql: ReturnType<typeof postgres>;

/**
 * Turn payments on or off for what follows.
 * @param enabled - Whether payments are on.
 */
function payments(enabled: boolean): void {
  initCore({
    ...process.env,
    PAYMENT_ENABLED: enabled ? "true" : "false",
    STRIPE_SECRET_KEY: "sk_test_unused_by_this_suite",
    STRIPE_WEBHOOK_SECRET: "whsec_unused_by_this_suite",
  });
}

beforeAll(() => {
  payments(true);
  loadLocales();
  sql = postgres(inject("DATABASE_URL"), { max: 6, prepare: false, connection: { application_name: APP } });
});

afterAll(async () => {
  await sql?.end({ timeout: 1 });
  initCore(process.env);
});

/**
 * A studio with one designated purchase.
 * @param credits - What the purchase grants.
 * @returns The fixture and its lot.
 */
async function studioWith(credits: number): Promise<StudioFixture & { lotId: string }> {
  const fx = await seedStudioFixture(sql, "charge-req");
  const lotId = await seedDesignatedLot(sql, fx, credits);
  return { ...fx, lotId };
}

/**
 * A reference no other case uses.
 * @param label - What it stands for.
 * @returns The reference.
 */
function ref(label: string): string {
  return `${label}-${randomUUID()}`;
}

type RequestInput = Parameters<typeof creditLotService.requestCharge>[0];

/**
 * Register a request in a transaction of its own.
 * @param input - The request.
 * @returns The new row's id, or null when the key already existed.
 */
async function request(input: RequestInput): Promise<string | null> {
  return db.transaction((tx) => creditLotService.requestCharge(input, tx));
}

/**
 * A task-kind request for a fixture.
 * @param fx - Whose studio pays.
 * @param referenceId - The delivery's key.
 * @param amount - What it costs.
 * @param extra - Anything else the request carries.
 * @returns The request input.
 */
function taskCharge(fx: StudioFixture, referenceId: string, amount: number, extra: Partial<RequestInput> = {}): RequestInput {
  return { kind: "task", referenceId, actorUserId: fx.userId, projectId: fx.projectId, amount, ...extra };
}

interface RequestRow {
  status: string;
  attempts: number;
  last_error: string | null;
  settled: boolean;
  updated_at: Date;
}

/**
 * A request row as stored.
 * @param id - The request.
 * @returns The row, or undefined when there is none.
 */
async function readRequest(id: string): Promise<RequestRow | undefined> {
  const [row] = await sql<RequestRow[]>`
    SELECT status, attempts, last_error, (settled_at IS NOT NULL) AS settled, updated_at
    FROM credit_charge_requests WHERE id = ${id}
  `;
  return row;
}

/**
 * Every request row filed under a reference.
 * @param referenceId - The delivery's key.
 * @returns The rows' kind, actor and status.
 */
async function requestsFor(referenceId: string): Promise<{ kind: string; actor_user_id: string; status: string }[]> {
  return sql<{ kind: string; actor_user_id: string; status: string }[]>`
    SELECT kind, actor_user_id, status FROM credit_charge_requests WHERE reference_id = ${referenceId} ORDER BY created_at
  `;
}

/**
 * Ledger rows a reference wrote.
 * @param referenceId - The delivery's key.
 * @returns Entry type and amount of each row.
 */
async function ledgerFor(referenceId: string): Promise<{ entry_type: string; amount: string }[]> {
  return sql<{ entry_type: string; amount: string }[]>`
    SELECT entry_type, amount::text AS amount FROM credit_ledger WHERE reference_id = ${referenceId} ORDER BY entry_type
  `;
}

/**
 * What is left on a lot.
 * @param lotId - The lot.
 * @returns Its remaining credits.
 */
async function remaining(lotId: string): Promise<string> {
  const [row] = await sql<{ remaining_credits: string }[]>`SELECT remaining_credits::text AS remaining_credits FROM credit_lots WHERE id = ${lotId}`;
  return row!.remaining_credits;
}

/**
 * Hold rows of one reference.
 * @param referenceId - The hold's key.
 * @returns Status of each.
 */
async function holdStatus(referenceId: string): Promise<string[]> {
  const rows = await sql<{ status: string }[]>`SELECT status FROM credit_holds WHERE reference_id = ${referenceId}`;
  return rows.map((r) => r.status);
}

/**
 * Make ledger writes for one description fail until the returned function runs.
 * @param description - The description whose rows are refused.
 * @returns A function that lifts the block.
 */
async function blockLedger(description: string): Promise<() => Promise<void>> {
  const name = `charge_req_block_${randomUUID().replaceAll("-", "")}`;
  await sql.unsafe(`ALTER TABLE credit_ledger ADD CONSTRAINT ${name} CHECK (description IS DISTINCT FROM '${description}') NOT VALID`);
  return async () => {
    await sql.unsafe(`ALTER TABLE credit_ledger DROP CONSTRAINT ${name}`);
  };
}

/**
 * Hold a row lock from a separate connection until released.
 * @param lock - The locking statement to run.
 * @returns A function that lets go.
 */
async function holdLock(lock: (tx: postgres.TransactionSql) => Promise<unknown>): Promise<() => Promise<void>> {
  const gate = postgres(inject("DATABASE_URL"), { max: 1, prepare: false, connection: { application_name: `${APP}-gate` } });
  let release: () => void = () => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  let acquired: () => void = () => {};
  const lockHeld = new Promise<void>((resolve) => {
    acquired = resolve;
  });
  const done = gate.begin(async (tx) => {
    await lock(tx);
    acquired();
    await held;
  });
  await lockHeld;
  return async () => {
    release();
    await done;
    await gate.end({ timeout: 1 });
  };
}

/**
 * Insert a pending canvas task for a fixture.
 * @param fx - Whose project.
 * @returns The task id.
 */
async function seedTask(fx: StudioFixture): Promise<string> {
  const [task] = await sql<{ id: string }[]>`
    INSERT INTO tasks (user_id, project_id, space_id, task_type, mode, status)
    VALUES (${fx.userId}, ${fx.projectId}, ${randomUUID()}, 'image', 'overwrite', 'processing')
    RETURNING id
  `;
  return task!.id;
}

describe("credit_charge_requests schema", () => {
  it("refuses an unknown kind, an unknown status and an amount that is not above zero", async () => {
    const fx = await studioWith(10);
    const insert = (kind: string, status: string, amount: string): Promise<unknown> => sql`
      INSERT INTO credit_charge_requests (kind, actor_user_id, reference_id, project_id, amount, status)
      VALUES (${kind}, ${fx.userId}, ${ref("schema")}, ${fx.projectId}, ${amount}, ${status})
    `;
    await expect(insert("refund", "pending", "1")).rejects.toThrow(/violates check constraint/);
    await expect(insert("task", "failed", "1")).rejects.toThrow(/violates check constraint/);
    await expect(insert("task", "pending", "0")).rejects.toThrow(/violates check constraint/);
    await expect(insert("task", "pending", "-1")).rejects.toThrow(/violates check constraint/);
    await expect(insert("task", "pending", "1")).resolves.toHaveLength(0);
  });

  it("keeps one row per kind, actor and reference", async () => {
    const fx = await studioWith(10);
    const reference = ref("unique");
    const insert = (): Promise<unknown> => sql`
      INSERT INTO credit_charge_requests (kind, actor_user_id, reference_id, amount)
      VALUES ('operation', ${fx.userId}, ${reference}, 1)
    `;
    await insert();
    await expect(insert()).rejects.toThrow(/duplicate key value violates unique constraint/);
  });

  it("indexes pending rows by updated_at for the sweep", async () => {
    const rows = await sql<{ indexdef: string }[]>`
      SELECT indexdef FROM pg_indexes WHERE tablename = 'credit_charge_requests'
    `;
    const partial = rows.map((r) => r.indexdef).filter((d) => /\(updated_at\)/.test(d) && /WHERE/i.test(d));
    expect(partial).toHaveLength(1);
    expect(partial[0]).toMatch(/status\)?::text = 'pending'/);
  });
});

describe("requestCharge", () => {
  it("leaves no row when its transaction rolls back", async () => {
    const fx = await studioWith(100);
    const reference = ref("rollback");
    await expect(
      db.transaction(async (tx) => {
        const id = await creditLotService.requestCharge(taskCharge(fx, reference, 10), tx);
        expect(id).toMatch(UUID);
        throw new Error("delivery rolled back");
      }),
    ).rejects.toThrow("delivery rolled back");
    expect(await requestsFor(reference)).toEqual([]);
    expect(await ledgerFor(reference)).toEqual([]);
  });

  it("returns null for a key that already exists and keeps the one row", async () => {
    const fx = await studioWith(100);
    const reference = ref("dup");
    const first = await request(taskCharge(fx, reference, 10));
    const second = await request(taskCharge(fx, reference, 25));
    expect(first).toMatch(UUID);
    expect(second).toBeNull();
    expect(await requestsFor(reference)).toEqual([{ kind: "task", actor_user_id: fx.userId, status: "pending" }]);
    const [row] = await sql<{ amount: string }[]>`SELECT amount::text AS amount FROM credit_charge_requests WHERE id = ${first}`;
    expect(row!.amount).toBe("10.000000");
  });

  it("scopes the key by actor and kind", async () => {
    const a = await studioWith(100);
    const b = await studioWith(100);
    const reference = ref("scope");
    expect(await request(taskCharge(a, reference, 1))).toMatch(UUID);
    expect(await request(taskCharge(b, reference, 1))).toMatch(UUID);
    expect(await request({ ...taskCharge(a, reference, 1), kind: "operation" })).toMatch(UUID);
    expect(await requestsFor(reference)).toHaveLength(3);
  });

  it("writes nothing to the ledger, the lots or the holds until settled", async () => {
    const fx = await studioWith(100);
    const reference = ref("inert");
    await creditHoldService.reserveCredits({ projectId: fx.projectId, actorUserId: fx.userId, referenceId: reference, amount: 40, ttlMs: HOUR });
    await request(taskCharge(fx, reference, 30, { releaseHold: reference }));
    expect(await ledgerFor(reference)).toEqual([]);
    expect(await remaining(fx.lotId)).toBe("100.000000");
    expect(await holdStatus(reference)).toEqual(["held"]);
  });
});

describe("settleCharge", () => {
  it("charges once, marks the row settled and returns null on every later call", async () => {
    const fx = await studioWith(100);
    const reference = ref("settle");
    const id = (await request(taskCharge(fx, reference, 30, { model: "seedream-4.0", provider: "volcengine", description: "Image" })))!;

    const outcome = await creditLotService.settleCharge(id);

    expect(outcome).toEqual({ billed: true, charged: "30.000000", shortfall: "0.000000", studioId: fx.studioId, lotIds: [fx.lotId] });
    expect(await readRequest(id)).toMatchObject({ status: "settled", attempts: 0, last_error: null, settled: true });
    expect(await ledgerFor(reference)).toEqual([{ entry_type: "spend", amount: "-30.000000" }]);
    const [row] = await sql<{ model: string; provider: string; description: string; actor_user_id: string; project_id: string }[]>`
      SELECT model, provider, description, actor_user_id, project_id FROM credit_ledger WHERE reference_id = ${reference}
    `;
    expect(row).toEqual({ model: "seedream-4.0", provider: "volcengine", description: "Image", actor_user_id: fx.userId, project_id: fx.projectId });

    expect(await creditLotService.settleCharge(id)).toBeNull();
    expect(await creditLotService.settleCharge(id)).toBeNull();
    expect(await ledgerFor(reference)).toEqual([{ entry_type: "spend", amount: "-30.000000" }]);
    expect(await remaining(fx.lotId)).toBe("70.000000");
  });

  it("books what the lots cannot cover as debt, in the same settlement", async () => {
    const fx = await studioWith(20);
    const reference = ref("short");
    const id = (await request(taskCharge(fx, reference, 50)))!;
    const outcome = await creditLotService.settleCharge(id);
    expect(outcome).toMatchObject({ billed: true, charged: "20.000000", shortfall: "30.000000", studioId: fx.studioId });
    expect(await ledgerFor(reference)).toEqual([
      { entry_type: "debt_incurred", amount: "-30.000000" },
      { entry_type: "spend", amount: "-20.000000" },
    ]);
    expect(await readRequest(id)).toMatchObject({ status: "settled" });
  });

  it("settles a request whose project was deleted as having no studio", async () => {
    const fx = await studioWith(100);
    const reference = ref("gone");
    const id = (await request(taskCharge(fx, reference, 15)))!;
    await sql`UPDATE projects SET deleted_at = now() WHERE id = ${fx.projectId}`;
    const outcome = await creditLotService.settleCharge(id);
    expect(outcome).toMatchObject({ billed: false, charged: "0.000000", shortfall: "15.000000", studioId: null, lotIds: [] });
    expect(await readRequest(id)).toMatchObject({ status: "settled" });
    expect(await ledgerFor(reference)).toEqual([{ entry_type: "spend", amount: "-15.000000" }]);
    expect(await remaining(fx.lotId)).toBe("100.000000");
  });

  it("settles a request with no project as standalone usage", async () => {
    const fx = await studioWith(100);
    const reference = ref("noproject");
    const id = (await request({ kind: "operation", referenceId: reference, actorUserId: fx.userId, projectId: null, amount: 4 }))!;
    const outcome = await creditLotService.settleCharge(id);
    expect(outcome).toEqual({ billed: false, charged: "0.000000", shortfall: "4.000000", studioId: null, lotIds: [] });
    expect(await readRequest(id)).toMatchObject({ status: "settled" });
    const rows = await sql<{ lot_id: string | null; payer_user_id: string; amount: string }[]>`
      SELECT lot_id, payer_user_id, amount::text AS amount FROM credit_ledger WHERE reference_id = ${reference}
    `;
    expect(rows).toEqual([{ lot_id: null, payer_user_id: fx.userId, amount: "-4.000000" }]);
  });

  it("charges once when two settlements of one row run at the same time", async () => {
    // The first settlement takes the request row and parks on the studio's
    // debt row; the second must then wait on the request row, not on the debt
    // row. Without the request row lock the second reaches the debt row too,
    // the probe below never sees anyone parked on the request row, and both
    // charge.
    const fx = await studioWith(100);
    const reference = ref("race");
    const id = (await request(taskCharge(fx, reference, 30)))!;
    await sql`INSERT INTO studio_credit_debts (studio_id, amount) VALUES (${fx.studioId}, 0) ON CONFLICT (studio_id) DO NOTHING`;
    const open = await holdLock((tx) => tx`SELECT id FROM studio_credit_debts WHERE studio_id = ${fx.studioId} FOR UPDATE`);

    const first = creditLotService.settleCharge(id);
    await waitUntilBlockedOn(sql, ["studio_credit_debts", "for update"], 1);
    const second = creditLotService.settleCharge(id);
    await waitUntilBlockedOn(sql, ["credit_charge_requests", "for update"], 1);

    await open();
    const outcomes = await Promise.all([first, second]);

    expect(outcomes.filter((o) => o === null)).toHaveLength(1);
    expect(outcomes.find((o) => o !== null)).toMatchObject({ charged: "30.000000" });
    expect(await ledgerFor(reference)).toEqual([{ entry_type: "spend", amount: "-30.000000" }]);
    expect(await remaining(fx.lotId)).toBe("70.000000");
    expect(await readRequest(id)).toMatchObject({ status: "settled" });
  });

  it("leaves the row pending, counts the failure and charges nothing when the settlement fails", async () => {
    const fx = await studioWith(100);
    const description = `boom-${randomUUID()}`;
    const reference = ref("fail");
    const id = (await request(taskCharge(fx, reference, 30, { description })))!;
    const unblock = await blockLedger(description);
    try {
      await expect(creditLotService.settleCharge(id)).rejects.toMatchObject({ cause: expect.objectContaining({ message: expect.stringMatching(/charge_req_block_/) }) });
    } finally {
      await unblock();
    }
    const row = (await readRequest(id))!;
    expect(row).toMatchObject({ status: "pending", attempts: 1, settled: false });
    expect(row.last_error).toMatch(/charge_req_block_/);
    expect(await ledgerFor(reference)).toEqual([]);
    expect(await remaining(fx.lotId)).toBe("100.000000");
  });

  it("counts every failed settlement, keeps the latest error and moves the row to the back of the sweep", async () => {
    const fx = await studioWith(100);
    const description = `boom-again-${randomUUID()}`;
    const id = (await request(taskCharge(fx, ref("record"), 5, { description })))!;
    await sql`UPDATE credit_charge_requests SET updated_at = now() - interval '1 hour' WHERE id = ${id}`;
    const before = (await readRequest(id))!.updated_at;

    const unblock = await blockLedger(description);
    try {
      await expect(creditLotService.settleCharge(id)).rejects.toThrow();
      const once = (await readRequest(id))!;
      expect(once).toMatchObject({ status: "pending", attempts: 1, settled: false });
      expect(once.last_error).toMatch(/^Failed query: .* <- .*charge_req_block_/s);
      expect(once.updated_at.getTime()).toBeGreaterThan(before.getTime() + 30 * 60_000);

      await expect(creditLotService.settleCharge(id)).rejects.toThrow();
      expect((await readRequest(id))!.attempts).toBe(2);
    } finally {
      await unblock();
    }

    expect(await creditLotService.settleCharge(id)).toMatchObject({ charged: "5.000000" });
    expect(await readRequest(id)).toMatchObject({ status: "settled", attempts: 2, settled: true });
  });

  it("leaves a settled row exactly as it was when a later settlement would have failed", async () => {
    const fx = await studioWith(100);
    const description = `late-${randomUUID()}`;
    const id = (await request(taskCharge(fx, ref("settled-record"), 5, { description })))!;
    await creditLotService.settleCharge(id);
    const before = (await readRequest(id))!;

    const unblock = await blockLedger(description);
    try {
      expect(await creditLotService.settleCharge(id)).toBeNull();
    } finally {
      await unblock();
    }

    expect(await readRequest(id)).toEqual(before);
  });

  it("throws both errors when the failure cannot be recorded either", async () => {
    const fx = await studioWith(100);
    const description = `both-${randomUUID()}`;
    const reference = ref("both");
    const id = (await request(taskCharge(fx, reference, 5, { description })))!;
    const unblock = await blockLedger(description);
    const name = `charge_req_record_block_${randomUUID().replaceAll("-", "")}`;
    await sql.unsafe(`ALTER TABLE credit_charge_requests ADD CONSTRAINT ${name} CHECK (attempts = 0 OR reference_id <> '${reference}') NOT VALID`);
    let thrown: unknown = null;
    try {
      await creditLotService.settleCharge(id).catch((err: unknown) => {
        thrown = err;
      });
    } finally {
      await sql.unsafe(`ALTER TABLE credit_charge_requests DROP CONSTRAINT ${name}`);
      await unblock();
    }
    expect(thrown).toBeInstanceOf(AggregateError);
    const errors = (thrown as AggregateError).errors;
    expect(errors).toHaveLength(2);
    expect(errors[0]).toMatchObject({ cause: expect.objectContaining({ message: expect.stringMatching(/charge_req_block_/) }) });
    expect(errors[1]).toMatchObject({ cause: expect.objectContaining({ message: expect.stringContaining(name) }) });
    expect(await readRequest(id)).toMatchObject({ status: "pending", attempts: 0, last_error: null });
  });
});

describe("listSweepableChargeRequests", () => {
  it("lists pending rows older than the minimum age, oldest first, up to the limit, skipping locked ones", async () => {
    const fx = await studioWith(100);
    const ids: string[] = [];
    const refs: string[] = [];
    for (let i = 0; i < 4; i++) {
      refs.push(ref(`sweep-${i}`));
      ids.push((await request(taskCharge(fx, refs[i]!, 1)))!);
    }
    const [a, b, c, d] = ids as [string, string, string, string];
    const fresh = (await request(taskCharge(fx, ref("sweep-fresh"), 1)))!;
    const settled = (await request(taskCharge(fx, ref("sweep-settled"), 1)))!;
    await creditLotService.settleCharge(settled);
    // Older than anything another case leaves pending, so this case's rows
    // lead the sweep's order. Deleted at the end so they do not lead the next run.
    await sql`UPDATE credit_charge_requests SET updated_at = timestamptz '1970-01-01 00:00:03+00' WHERE id = ${a}`;
    await sql`UPDATE credit_charge_requests SET updated_at = timestamptz '1970-01-01 00:00:01+00' WHERE id = ${b}`;
    await sql`UPDATE credit_charge_requests SET updated_at = timestamptz '1970-01-01 00:00:02+00' WHERE id = ${c}`;
    await sql`UPDATE credit_charge_requests SET updated_at = timestamptz '1970-01-01 00:00:04+00' WHERE id = ${d}`;
    await sql`UPDATE credit_charge_requests SET updated_at = timestamptz '1970-01-01 00:00:00+00' WHERE id = ${settled}`;
    try {
      const mine = new Set([a, b, c, d, fresh, settled]);
      const all = await creditLotService.listSweepableChargeRequests(30_000, 10_000);
      expect(all.map((row) => row.id).filter((id) => mine.has(id))).toEqual([b, c, a, d]);
      const firstTwo = await creditLotService.listSweepableChargeRequests(30_000, 2);
      expect(firstTwo.map((row) => row.id)).toEqual([b, c]);
      // What the sweep logs for a stuck charge comes with the row.
      expect(firstTwo[0]).toEqual({ id: b, kind: "task", referenceId: refs[1], actorUserId: fx.userId, amount: "1.000000", attempts: 0 });

      // A row being settled right now is skipped rather than waited on.
      const open = await holdLock((tx) => tx`SELECT id FROM credit_charge_requests WHERE id = ${b} FOR UPDATE`);
      try {
        const listed = await Promise.race([
          creditLotService.listSweepableChargeRequests(30_000, 2),
          new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error("the sweep waited on a locked row")), 5_000)),
        ]);
        expect(listed.map((row) => row.id)).toEqual([c, a]);
      } finally {
        await open();
      }
    } finally {
      await sql`DELETE FROM credit_charge_requests WHERE id IN ${sql([a, b, c, d, fresh, settled])}`;
    }
  });

  it("lists a row only once its age passes the minimum", async () => {
    const fx = await studioWith(100);
    const id = (await request(taskCharge(fx, ref("age"), 1)))!;
    try {
      const ids = async (): Promise<string[]> => (await creditLotService.listSweepableChargeRequests(60_000, 10_000)).map((row) => row.id);
      expect(await ids()).not.toContain(id);
      await sql`UPDATE credit_charge_requests SET updated_at = now() - interval '61 seconds' WHERE id = ${id}`;
      expect(await ids()).toContain(id);
    } finally {
      await sql`DELETE FROM credit_charge_requests WHERE id = ${id}`;
    }
  });
});

describe("markCompletedAndBill with a charge", () => {
  it("completes the task and registers its request in one commit", async () => {
    const fx = await studioWith(100);
    const taskId = await seedTask(fx);
    const won = await taskService.markCompletedAndBill(taskId, { url: "https://example.test/a.png" }, 12, 900, {
      actorUserId: fx.userId,
      projectId: fx.projectId,
      amount: 12,
      model: "seedream-4.0",
      provider: "volcengine",
      releaseHold: taskId,
    });
    expect(won).toBe(true);
    const [task] = await sql<{ status: string; billed: boolean }[]>`SELECT status, (billed_at IS NOT NULL) AS billed FROM tasks WHERE id = ${taskId}`;
    expect(task).toEqual({ status: "completed", billed: true });
    const rows = await sql<{ kind: string; reference_id: string; release_hold: string; amount: string; status: string }[]>`
      SELECT kind, reference_id, release_hold, amount::text AS amount, status FROM credit_charge_requests WHERE reference_id = ${taskId}
    `;
    expect(rows).toEqual([{ kind: "task", reference_id: taskId, release_hold: taskId, amount: "12.000000", status: "pending" }]);
    expect(await creditLotService.pendingChargeRequestId("task", fx.userId, taskId)).toMatch(UUID);
  });

  it("completes a task whose model and provider names are longer than the ledger keeps, cut to the ledger's widths", async () => {
    const fx = await studioWith(100);
    const taskId = await seedTask(fx);
    const model = `m${"x".repeat(299)}`;
    const provider = `p${"y".repeat(119)}`;
    const won = await taskService.markCompletedAndBill(taskId, {}, 7, 900, {
      actorUserId: fx.userId,
      projectId: fx.projectId,
      amount: 7,
      model,
      provider,
    });
    expect(won).toBe(true);
    const [task] = await sql<{ status: string }[]>`SELECT status FROM tasks WHERE id = ${taskId}`;
    expect(task).toEqual({ status: "completed" });
    const [stored] = await sql<{ id: string; model: string; provider: string }[]>`
      SELECT id, model, provider FROM credit_charge_requests WHERE reference_id = ${taskId}
    `;
    expect(stored).toEqual({ id: stored!.id, model: model.slice(0, 100), provider: provider.slice(0, 50) });

    expect(await creditLotService.settleCharge(stored!.id)).toMatchObject({ billed: true, charged: "7.000000" });
    const ledger = await sql<{ model: string; provider: string; amount: string }[]>`
      SELECT model, provider, amount::text AS amount FROM credit_ledger WHERE reference_id = ${taskId}
    `;
    expect(ledger).toEqual([{ model: model.slice(0, 100), provider: provider.slice(0, 50), amount: "-7.000000" }]);
    expect(await readRequest(stored!.id)).toMatchObject({ status: "settled" });
  });

  it("rolls the completion back when the request cannot be written", async () => {
    const fx = await studioWith(100);
    const taskId = await seedTask(fx);
    // An actor that does not exist fails the request's foreign key.
    await expect(
      taskService.markCompletedAndBill(taskId, { url: "https://example.test/b.png" }, 12, 900, {
        actorUserId: randomUUID(),
        projectId: fx.projectId,
        amount: 12,
      }),
    ).rejects.toMatchObject({ cause: expect.objectContaining({ message: expect.stringMatching(/foreign key/) }) });
    const [task] = await sql<{ status: string; billed: boolean }[]>`SELECT status, (billed_at IS NOT NULL) AS billed FROM tasks WHERE id = ${taskId}`;
    expect(task).toEqual({ status: "processing", billed: false });
    expect(await requestsFor(taskId)).toEqual([]);
  });

  it("registers nothing when the transition was already taken", async () => {
    const fx = await studioWith(100);
    const taskId = await seedTask(fx);
    const charge = { actorUserId: fx.userId, projectId: fx.projectId, amount: 12, releaseHold: taskId };
    expect(await taskService.markCompletedAndBill(taskId, {}, 12, 900, charge)).toBe(true);
    expect(await taskService.markCompletedAndBill(taskId, {}, 12, 900, charge)).toBe(false);
    expect(await requestsFor(taskId)).toHaveLength(1);
  });

  it("registers nothing for a free run or a null charge", async () => {
    const fx = await studioWith(100);
    const free = await seedTask(fx);
    const none = await seedTask(fx);
    expect(await taskService.markCompletedAndBill(free, {}, 0, 900, { actorUserId: fx.userId, projectId: fx.projectId, amount: 0 })).toBe(true);
    expect(await taskService.markCompletedAndBill(none, {}, 5, 900, null)).toBe(true);
    expect(await requestsFor(free)).toEqual([]);
    expect(await requestsFor(none)).toEqual([]);
  });

  it("keeps the run's hold until the request is settled, and releases it in that settlement", async () => {
    const fx = await studioWith(100);
    const taskId = await seedTask(fx);
    await creditHoldService.reserveCredits({ projectId: fx.projectId, actorUserId: fx.userId, referenceId: taskId, amount: 40, ttlMs: HOUR });
    const description = `hold-boom-${randomUUID()}`;
    await taskService.markCompletedAndBill(taskId, {}, 25, 900, {
      actorUserId: fx.userId,
      projectId: fx.projectId,
      amount: 25,
      description,
      releaseHold: taskId,
    });
    expect(await holdStatus(taskId)).toEqual(["held"]);

    const id = (await creditLotService.pendingChargeRequestId("task", fx.userId, taskId))!;
    const unblock = await blockLedger(description);
    try {
      await expect(creditLotService.settleCharge(id)).rejects.toMatchObject({ cause: expect.objectContaining({ message: expect.stringMatching(/charge_req_block_/) }) });
    } finally {
      await unblock();
    }
    expect(await holdStatus(taskId)).toEqual(["held"]);

    await creditLotService.settleCharge(id);
    expect(await holdStatus(taskId)).toEqual(["released"]);
    expect(await creditHoldService.getCreditPosition(fx.studioId)).toEqual({ spendable: "75.000000", held: "0.000000", available: "75.000000" });
    expect(await creditLotService.pendingChargeRequestId("task", fx.userId, taskId)).toBeNull();
  });
});

describe("chargeOnce", () => {
  it("charges a key once and answers null the second time", async () => {
    const fx = await studioWith(100);
    const key = `turn:${randomUUID()}:1`;
    const input = { projectId: fx.projectId, actorUserId: fx.userId, amount: 10, description: "Agent chat" };

    const first = await creditLotService.chargeOnce("operation", key, input);
    const second = await creditLotService.chargeOnce("operation", key, input);

    expect(first).toEqual({ billed: true, charged: "10.000000", shortfall: "0.000000", studioId: fx.studioId, lotIds: [fx.lotId] });
    expect(second).toBeNull();
    expect(await ledgerFor(key)).toEqual([{ entry_type: "spend", amount: "-10.000000" }]);
    expect(await requestsFor(key)).toEqual([{ kind: "operation", actor_user_id: fx.userId, status: "settled" }]);
    expect(await remaining(fx.lotId)).toBe("90.000000");
  });

  it("refuses a malformed key before writing anything", async () => {
    const fx = await studioWith(100);
    await expect(
      creditLotService.chargeOnce("operation", "turn with spaces", { projectId: fx.projectId, actorUserId: fx.userId, amount: 1 }),
    ).rejects.toThrow(/refKey/);
    expect(await requestsFor("turn with spaces")).toEqual([]);
  });

  it("records a failed settlement on the row and rethrows, and the row settles later", async () => {
    const fx = await studioWith(100);
    const key = `turn:${randomUUID()}:2`;
    const description = `once-boom-${randomUUID()}`;
    const input = { projectId: fx.projectId, actorUserId: fx.userId, amount: 10, description };
    const unblock = await blockLedger(description);
    try {
      await expect(creditLotService.chargeOnce("operation", key, input)).rejects.toMatchObject({ cause: expect.objectContaining({ message: expect.stringMatching(/charge_req_block_/) }) });
    } finally {
      await unblock();
    }
    const id = (await creditLotService.pendingChargeRequestId("operation", fx.userId, key))!;
    expect(id).toMatch(UUID);
    const row = (await readRequest(id))!;
    expect(row).toMatchObject({ status: "pending", attempts: 1 });
    expect(row.last_error).toContain("charge_req_block_");
    expect(await ledgerFor(key)).toEqual([]);

    // A retry of the same call is not a second charge: the key is taken.
    expect(await creditLotService.chargeOnce("operation", key, input)).toBeNull();
    // The sweep's settlement is the one that charges.
    expect(await creditLotService.settleCharge(id)).toMatchObject({ charged: "10.000000" });
    expect(await ledgerFor(key)).toEqual([{ entry_type: "spend", amount: "-10.000000" }]);
  });
});

describe("pendingChargeRequestId", () => {
  it("finds a pending request by its key and stops finding it once settled", async () => {
    const fx = await studioWith(100);
    const reference = ref("pending");
    expect(await creditLotService.pendingChargeRequestId("task", fx.userId, reference)).toBeNull();
    const id = (await request(taskCharge(fx, reference, 3)))!;
    expect(await creditLotService.pendingChargeRequestId("task", fx.userId, reference)).toBe(id);
    expect(await creditLotService.pendingChargeRequestId("operation", fx.userId, reference)).toBeNull();
    expect(await creditLotService.pendingChargeRequestId("task", randomUUID(), reference)).toBeNull();
    await creditLotService.settleCharge(id);
    expect(await creditLotService.pendingChargeRequestId("task", fx.userId, reference)).toBeNull();
  });
});
