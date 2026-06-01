/**
 * Credit-balance critical-path invariants — `creditRepo` balance access
 * against a real Postgres (PR3, migration 0020).
 *
 * The per-user balance moved out of the `users.credits` column into its
 * own `credit_balances` table. `creditRepo` owns ALL balance access; the
 * money-safety contract (CLAUDE.md 关键路径 — 积分扣减 → 100% +
 * invariant + property-based) lives entirely in four functions whose
 * guarantees are SQL-level and can only be verified against real
 * Postgres — a mocked query builder would happily return whatever the
 * test stages regardless of the WHERE/JOIN/ON-CONFLICT clauses:
 *
 *   1. getBalance        — reads 0 for a soft-deleted or row-less user
 *                          (inner-join users + deleted_at IS NULL).
 *   2. deductBalance     — a single conditional UPDATE that can NEVER
 *                          drive the balance negative; returns the new
 *                          balance on success, null when insufficient /
 *                          soft-deleted / no row.
 *   3. addBalance        — UPSERT (INSERT … ON CONFLICT DO UPDATE) so a
 *                          recharge / purchase always lands, even if the
 *                          row was never opened (money in must never
 *                          silently no-op). Intentionally permissive:
 *                          does NOT filter soft-delete.
 *   4. createBalanceRow  — opens a 0 row at registration; idempotent
 *                          (ON CONFLICT DO NOTHING) so a retry can't
 *                          error or clobber an existing balance.
 *
 * Property-based (fast-check): for any random interleaving of add /
 * deduct, the table balance ALWAYS equals initial + Σadds − Σ(successful
 * deducts), is NEVER negative, and deduct returns null IFF the amount
 * would overdraw. This is the invariant a concurrency / off-by-one bug
 * would violate.
 *
 * Runs against the testcontainer Postgres started by global-setup.ts.
 * Seeding uses a narrow raw `postgres` client; the assertions call the
 * real `creditRepo` (core's env-bound `db`, pointed at the same
 * container via the injected config).
 */

import { describe, it, expect, beforeAll, afterAll, inject, vi } from "vitest";

// Mock `ai` BEFORE importing @breatic/core. The core barrel pulls
// agent/llm → the `ai` SDK → @opentelemetry/api, whose ESM build uses
// bare relative imports that Node's native ESM rejects. This suite never
// calls any ai function; the stubs just keep that broken ESM chain from
// loading at import time (same guard auth-role.integration uses).
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
import fc from "fast-check";
import { initCore, db } from "@breatic/core";
import { creditRepo } from "@breatic/domain";

// integration-setup.ts injects the container URLs into process.env but
// cannot call initCore itself (importing the core barrel pulls the `ai`
// SDK → otel). Each integration test injects the validated config so the
// repo's env-bound `db` Proxy resolves to the testcontainer. Guarded
// because the worker process is shared (singleFork) with sibling suites
// that may have already initialised core.
try {
  initCore(process.env);
} catch {
  // already initialised by a sibling suite in this worker — fine.
}

const PG_DRIVER_LOCAL = "credit-balance-test-driver";

let sql: ReturnType<typeof postgres>;

beforeAll(() => {
  const url = inject("DATABASE_URL");
  sql = postgres(url, {
    max: 2,
    prepare: false,
    connection: { application_name: PG_DRIVER_LOCAL },
  });
});

afterAll(async () => {
  await sql?.end({ timeout: 1 });
});

// Unique-email counter so every seeded user is independent. fast-check
// re-runs (incl. shrinking) keep advancing it, so emails never collide.
let userSeq = 0;

/** Insert a fresh user; no balance row, no `users.credits` (dropped in 0020). */
async function insertUser(): Promise<string> {
  const email = `cb-${userSeq++}@example.com`;
  const [row] = await sql<{ id: string }[]>`
    INSERT INTO users (email, email_verified)
    VALUES (${email}, true)
    RETURNING id
  `;
  return row!.id;
}

/** Seed a user WITH a balance row at the given amount (raw, bypasses repo). */
async function userWithBalance(balance: number): Promise<string> {
  const userId = await insertUser();
  await sql`
    INSERT INTO credit_balances (user_id, balance)
    VALUES (${userId}, ${balance})
  `;
  return userId;
}

/** Read the raw stored balance (or null if no row), bypassing the repo's
 *  soft-delete join — lets us prove what physically landed in the table. */
async function rawBalance(userId: string): Promise<number | null> {
  const rows = await sql<{ balance: number }[]>`
    SELECT balance FROM credit_balances WHERE user_id = ${userId}
  `;
  return rows[0]?.balance ?? null;
}

async function softDeleteUser(userId: string): Promise<void> {
  await sql`UPDATE users SET deleted_at = now() WHERE id = ${userId}`;
}

describe("getBalance — reads hide soft-deleted / row-less users", () => {
  it("returns the stored balance for an active user", async () => {
    const userId = await userWithBalance(250);
    expect(await creditRepo.getBalance(userId)).toBe(250);
  });

  it("returns 0 for a user with no balance row (never opened)", async () => {
    const userId = await insertUser();
    expect(await creditRepo.getBalance(userId)).toBe(0);
  });

  it("returns 0 for a soft-deleted user even though the row still holds credits", async () => {
    const userId = await userWithBalance(500);
    expect(await creditRepo.getBalance(userId)).toBe(500);

    await softDeleteUser(userId);
    // Read is hidden by the users-join + deleted_at IS NULL filter…
    expect(await creditRepo.getBalance(userId)).toBe(0);
    // …but the underlying credits are NOT destroyed (soft-delete only).
    expect(await rawBalance(userId)).toBe(500);
  });
});

describe("deductBalance — conditional UPDATE that can never go negative", () => {
  it("deducts when sufficient and returns the new balance", async () => {
    const userId = await userWithBalance(100);
    expect(await creditRepo.deductBalance(userId, 30)).toBe(70);
    expect(await rawBalance(userId)).toBe(70);
  });

  it("allows deducting the exact balance down to zero", async () => {
    const userId = await userWithBalance(40);
    expect(await creditRepo.deductBalance(userId, 40)).toBe(0);
    expect(await rawBalance(userId)).toBe(0);
  });

  it("returns null and leaves the balance untouched when insufficient", async () => {
    const userId = await userWithBalance(20);
    expect(await creditRepo.deductBalance(userId, 21)).toBeNull();
    // The whole point: an overdraw must be a no-op, not a negative row.
    expect(await rawBalance(userId)).toBe(20);
  });

  it("returns null for a user with no balance row", async () => {
    const userId = await insertUser();
    expect(await creditRepo.deductBalance(userId, 1)).toBeNull();
    expect(await rawBalance(userId)).toBeNull();
  });

  it("returns null for a soft-deleted user and leaves the row untouched", async () => {
    const userId = await userWithBalance(100);
    await softDeleteUser(userId);
    expect(await creditRepo.deductBalance(userId, 10)).toBeNull();
    expect(await rawBalance(userId)).toBe(100);
  });
});

describe("deduct atomicity — a deduction is all-or-nothing with its transaction (prohibition #7)", () => {
  // credit.service.deduct / deductOnce run `db.transaction(deductBalance →
  // recordTransaction)`: the balance UPDATE and the ledger INSERT must
  // commit together or not at all. The money-safety invariant is that a
  // failure in the SECOND step (the ledger write) can never leave the
  // FIRST step (the balance already debited) committed — that would charge
  // a user with no audit row. These tests exercise that rollback against a
  // real Postgres transaction; a mocked tx can't prove rollback semantics.

  it("rolls the balance back when the enclosing transaction fails after the deduct", async () => {
    const userId = await userWithBalance(100);

    await expect(
      db.transaction(async (tx) => {
        const after = await creditRepo.deductBalance(userId, 30, tx);
        // The conditional UPDATE applied INSIDE the transaction.
        expect(after).toBe(70);
        // Simulate the ledger write (recordTransaction) failing.
        throw new Error("simulated ledger-write failure");
      }),
    ).rejects.toThrow("simulated ledger-write failure");

    // The debit rolled back with the failed transaction — balance untouched.
    expect(await rawBalance(userId)).toBe(100);
  });

  it("commits the deduction only when the whole transaction succeeds", async () => {
    const userId = await userWithBalance(100);

    await db.transaction(async (tx) => {
      const after = await creditRepo.deductBalance(userId, 30, tx);
      expect(after).toBe(70);
      // A successful second step (the real path also writes the ledger row).
    });

    // Both steps committed — the debit persisted.
    expect(await rawBalance(userId)).toBe(70);
  });
});

describe("addBalance — UPSERT so money in never silently no-ops", () => {
  it("adds to an existing balance row and returns the new total", async () => {
    const userId = await userWithBalance(100);
    expect(await creditRepo.addBalance(userId, 50)).toBe(150);
    expect(await rawBalance(userId)).toBe(150);
  });

  it("creates the row on first credit when none was ever opened", async () => {
    const userId = await insertUser();
    expect(await rawBalance(userId)).toBeNull();
    expect(await creditRepo.addBalance(userId, 75)).toBe(75);
    expect(await rawBalance(userId)).toBe(75);
  });

  it("is intentionally permissive: still credits a soft-deleted user's row (getBalance hides it, money is not lost)", async () => {
    const userId = await userWithBalance(100);
    await softDeleteUser(userId);
    // addBalance does NOT filter soft-delete — the credit lands…
    expect(await creditRepo.addBalance(userId, 25)).toBe(125);
    expect(await rawBalance(userId)).toBe(125);
    // …but the read path still hides it from a deleted account.
    expect(await creditRepo.getBalance(userId)).toBe(0);
  });
});

describe("createBalanceRow — idempotent account opening", () => {
  it("opens a fresh row at 0", async () => {
    const userId = await insertUser();
    await creditRepo.createBalanceRow(userId);
    expect(await rawBalance(userId)).toBe(0);
  });

  it("is idempotent — a second call never errors and never clobbers an existing balance", async () => {
    const userId = await insertUser();
    await creditRepo.createBalanceRow(userId);
    await creditRepo.addBalance(userId, 200);
    // A registration retry must not reset the balance back to 0.
    await expect(creditRepo.createBalanceRow(userId)).resolves.toBeUndefined();
    expect(await rawBalance(userId)).toBe(200);
  });
});

describe("property — random add/deduct interleavings preserve the balance invariant", () => {
  it("balance == Σadds − Σ(successful deducts), never negative, deduct null IFF overdraw", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(
          fc.record({
            op: fc.constantFrom("add" as const, "deduct" as const),
            amount: fc.integer({ min: 1, max: 1000 }),
          }),
          { maxLength: 12 },
        ),
        async (ops) => {
          const userId = await insertUser();
          await creditRepo.createBalanceRow(userId); // open at 0
          let expected = 0;

          for (const { op, amount } of ops) {
            if (op === "add") {
              const newBalance = await creditRepo.addBalance(userId, amount);
              expected += amount;
              expect(newBalance).toBe(expected);
            } else {
              const result = await creditRepo.deductBalance(userId, amount);
              if (amount <= expected) {
                expected -= amount;
                expect(result).toBe(expected);
              } else {
                // Overdraw → null, balance unchanged. The core safety net.
                expect(result).toBeNull();
              }
            }
            // Invariants after every step.
            expect(expected).toBeGreaterThanOrEqual(0);
            expect(await creditRepo.getBalance(userId)).toBe(expected);
          }
        },
      ),
      { numRuns: 25 },
    );
  });
});
