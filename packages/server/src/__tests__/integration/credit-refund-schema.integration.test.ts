// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Migration 0094 (#1410): the tables a refund disposition is recorded in, and
 * the guarantees the design (refund-disposition API §5.1, §6.5, §8, §9) puts
 * on the schema itself rather than on the code that writes it.
 *
 *   1. `credit_lots.refund_requested_at` is a nullable timestamptz, and the
 *      migration fills it from `updated_at` for lots already `refund_pending`
 *      — the rejection mail and the back office's waiting list read it, and
 *      a lot asked for before 0094 would otherwise have no request time.
 *   2. `credit_refund_operations`: kind / status / result are closed sets, a
 *      result exists exactly when the status is `succeeded`, an idempotency
 *      key takes effect once, and a lot has at most one disposition in flight
 *      (`started` or `awaiting_stripe`). The last one is the database half of
 *      §9's first invariant: two concurrent approvals cannot both land.
 *   3. `credit_refund_operation_events` is append-only and stamped by the
 *      database clock.
 *   4. `credit_refunds` is keyed by the Stripe refund id and copies Stripe's
 *      five statuses verbatim.
 *   5. `refund_mail_outbox`: one automatic mail per disposition, resends are
 *      new rows, an idempotency key takes effect once.
 *   6. `credit_refund_reconcile_status` is one row of progress, keyed by name.
 *   7. `notifications.type` takes the three new bell types and nothing else new.
 *   8. None of the five tables can be soft-deleted; all carry `created_at`.
 *   9. v9: `credit_refunds.pending_reason` takes Stripe's three reasons;
 *      `attention_reason` takes `stripe_request_invalid`; `credit_ledger`
 *      takes `refund_reversed`; `refund_amount_cents` is gone; the two views
 *      of §5.3 exist with their columns and a read-only role given default
 *      privileges can SELECT them.
 *
 * Rejections are asserted by SQLSTATE: 23514 check, 23505 unique, 23503
 * foreign key. Against a database without 0094 every case fails on 42P01 /
 * 42703 (the object does not exist), not on a wrong guess about values.
 */

import { describe, it, expect, beforeAll, afterAll, inject } from "vitest";
import { readFile } from "node:fs/promises";
import crypto from "node:crypto";
import postgres from "postgres";
import { openPaymentSource } from "./payment-source.js";

const MIGRATION = new URL(
  "../../../../core/src/db/migrations/0094_credit_refund_operations.sql",
  import.meta.url,
);

const NEW_TABLES = [
  "credit_refund_operations",
  "credit_refund_operation_events",
  "credit_refunds",
  "refund_mail_outbox",
  "credit_refund_reconcile_status",
] as const;

const OP_KINDS = [
  "approve",
  "reject",
  "settle",
  "send_back",
  "retry",
  "resolve_outside",
  "restore_credits",
] as const;
const OP_RESULTS = ["refunded", "rejected", "sent_back", "resolved_outside", "restored"] as const;
const ATTENTION_REASONS = [
  "partial_refund",
  "unexpected_external_refund",
  "stripe_refund_failed_later",
  "attempts_exhausted",
  "stripe_result_unknown",
  "already_refunded_elsewhere",
  "stripe_declined",
  "stripe_request_invalid",
  "state_mismatch",
] as const;
const MAIL_KINDS = ["refund_completed", "refund_rejected", "refund_restored"] as const;
const BELL_TYPES = ["credit.refund_completed", "credit.refund_rejected", "credit.refund_restored"] as const;
const PENDING_REASONS = ["processing", "insufficient_funds", "charge_pending"] as const;
const VIEWS = ["credit_refunds_unresolved_failed", "credit_lot_refund_failures"] as const;
const STRIPE_REFUND_STATUSES = [
  "pending",
  "requires_action",
  "succeeded",
  "failed",
  "canceled",
] as const;
const MAIL_STATUSES = ["pending", "sending", "sent", "failed", "skipped", "unknown"] as const;

let sql: ReturnType<typeof postgres>;

beforeAll(() => {
  sql = postgres(inject("DATABASE_URL"), {
    max: 4,
    prepare: false,
    connection: { application_name: "credit-refund-schema-test" },
  });
});

afterAll(async () => {
  await sql?.end({ timeout: 1 });
});

interface ColumnShape {
  column_name: string;
  data_type: string;
  is_nullable: string;
  column_default: string | null;
}

/**
 * Every column of a table, as the database reports it.
 * @param table - Table name in the public schema.
 * @returns The columns keyed by name.
 */
async function columnsOf(table: string): Promise<Map<string, ColumnShape>> {
  const rows = await sql<ColumnShape[]>`
    SELECT column_name, data_type, is_nullable, column_default
    FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = ${table}
  `;
  return new Map(rows.map((row) => [row.column_name, row]));
}

/**
 * The primary key columns of a table, in key order.
 * @param table - Table name in the public schema.
 * @returns Column names; empty when the table or its key is missing.
 */
async function primaryKeyOf(table: string): Promise<string[]> {
  const rows = await sql<{ attname: string }[]>`
    SELECT a.attname
    FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    CROSS JOIN LATERAL unnest(c.conkey) WITH ORDINALITY AS k(attnum, ord)
    JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.attnum
    WHERE n.nspname = 'public' AND t.relname = ${table} AND c.contype = 'p'
    ORDER BY k.ord
  `;
  return rows.map((row) => row.attname);
}

interface ForeignKeyShape {
  column: string;
  references: string;
  on_delete: string;
}

/**
 * Single-column foreign keys of a table.
 * @param table - Table name in the public schema.
 * @returns Column, referenced table, and `confdeltype` ('r' restrict, 'a' no action, 'c' cascade, 'n' set null).
 */
async function foreignKeysOf(table: string): Promise<ForeignKeyShape[]> {
  return sql<ForeignKeyShape[]>`
    SELECT a.attname AS column, rt.relname AS references, c.confdeltype AS on_delete
    FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    JOIN pg_class rt ON rt.oid = c.confrelid
    JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = c.conkey[1]
    WHERE n.nspname = 'public' AND t.relname = ${table}
      AND c.contype = 'f' AND cardinality(c.conkey) = 1
    ORDER BY a.attname
  `;
}

/**
 * The SQLSTATE a statement fails with.
 * @param query - The pending statement.
 * @returns The error code, or null when the statement succeeded.
 */
async function codeOf(query: PromiseLike<unknown>): Promise<string | null> {
  try {
    await query;
    return null;
  } catch (err) {
    return (err as { code?: string }).code ?? String(err);
  }
}

let seq = 0;

interface Lot {
  userId: string;
  paymentId: string;
  lotId: string;
}

/**
 * A buyer, a completed payment and the lot it opened.
 * @param lifecycle - The lot's state; refund states are undesignated.
 * @returns The three ids.
 */
async function seedLot(lifecycle = "refund_pending"): Promise<Lot> {
  seq += 1;
  const [user] = await sql<{ id: string }[]>`
    INSERT INTO users (email, email_verified)
    VALUES (${`refund-schema-${Date.now()}-${seq}@example.test`}, true) RETURNING id
  `;
  const sourceId = await openPaymentSource(sql);
  await sql`
    INSERT INTO payments (id, user_id, amount_cents, status, credits_granted)
    VALUES (${sourceId}, ${user!.id}, 1000, 'completed', 880)
  `;
  const [lot] = await sql<{ id: string }[]>`
    INSERT INTO credit_lots
      (source_id, source_kind, user_id, purchased_credits, remaining_credits, lifecycle)
    VALUES (${sourceId}, 'payment', ${user!.id}, 880, 880, ${lifecycle})
    RETURNING id
  `;
  return { userId: user!.id, paymentId: sourceId, lotId: lot!.id };
}

interface OperationRow {
  id?: string;
  kind?: string;
  status?: string;
  result?: string | null;
  attentionReason?: string | null;
  idempotencyKey?: string;
}

/**
 * Insert one disposition row directly.
 * @param lot - The lot (and its payment) it disposes of.
 * @param row - Columns that differ from an open `needs_attention` approval.
 * @returns The pending insert, resolving to the new row's id.
 */
function insertOperation(lot: Lot, row: OperationRow = {}): postgres.PendingQuery<{ id: string }[]> {
  return sql<{ id: string }[]>`
    INSERT INTO credit_refund_operations
      (id, lot_id, payment_id, kind, status, result, attention_reason,
       idempotency_key, request_hash, requested_by, reason, notify)
    VALUES (
      ${row.id ?? crypto.randomUUID()}, ${lot.lotId}, ${lot.paymentId},
      ${row.kind ?? "approve"}, ${row.status ?? "needs_attention"},
      ${row.result ?? null}, ${row.attentionReason ?? null},
      ${row.idempotencyKey ?? crypto.randomUUID()}, ${crypto.randomBytes(32).toString("hex")},
      ${crypto.randomUUID()}, 'schema test', true
    )
    RETURNING id
  `;
}

/**
 * A lot with one finished disposition on it.
 * @returns The lot and the disposition id.
 */
async function seedOperation(): Promise<Lot & { operationId: string }> {
  const lot = await seedLot();
  const [op] = await insertOperation(lot, { kind: "reject", status: "succeeded", result: "rejected" });
  return { ...lot, operationId: op!.id };
}

interface MailRow {
  kind?: string;
  origin?: string;
  status?: string;
  idempotencyKey?: string;
}

/**
 * Insert one outbox row directly. `resend` rows carry the request columns,
 * `auto` rows leave them empty (§5.1).
 * @param operationId - The disposition the mail reports.
 * @param row - Columns that differ from a pending `auto` completion mail.
 * @returns The pending insert.
 */
function insertMail(operationId: string, row: MailRow = {}): postgres.PendingQuery<postgres.Row[]> {
  const origin = row.origin ?? "auto";
  const resend = origin === "resend";
  return sql`
    INSERT INTO refund_mail_outbox
      (operation_id, kind, origin, status, requested_by, reason, idempotency_key, request_hash)
    VALUES (
      ${operationId}, ${row.kind ?? "refund_completed"}, ${origin}, ${row.status ?? "pending"},
      ${resend ? crypto.randomUUID() : null}, ${resend ? "resend test" : null},
      ${row.idempotencyKey ?? (resend ? crypto.randomUUID() : null)},
      ${resend ? crypto.randomBytes(32).toString("hex") : null}
    )
  `;
}

/**
 * Insert one refund copy directly.
 * @param lot - The lot and payment the refund belongs to.
 * @param status - Stripe's status, verbatim.
 * @param extra - Optional refund id, the disposition that answered for it, and the pending reason.
 * @returns The pending insert.
 */
function insertRefund(
  lot: Lot,
  status: string,
  extra: { stripeRefundId?: string; resolvedBy?: string | null; operationId?: string | null; pendingReason?: string | null } = {},
): postgres.PendingQuery<postgres.Row[]> {
  const row: Record<string, string | number | boolean | null> = {
    stripe_refund_id: extra.stripeRefundId ?? `re_${crypto.randomUUID().replaceAll("-", "")}`,
    payment_id: lot.paymentId,
    lot_id: lot.lotId,
    operation_id: extra.operationId ?? null,
    amount_cents: 1000,
    currency: "usd",
    status,
    ever_succeeded: status === "succeeded",
    resolved_by_operation_id: extra.resolvedBy ?? null,
  };
  // Written only when given, so the other cases do not depend on the v9 column.
  if (extra.pendingReason !== undefined) row.pending_reason = extra.pendingReason;
  return sql`INSERT INTO credit_refunds ${sql(row)}`;
}

describe("credit_lots.refund_requested_at", () => {
  it("is a nullable timestamptz", async () => {
    const col = (await columnsOf("credit_lots")).get("refund_requested_at");
    expect(col?.data_type, "credit_lots.refund_requested_at does not exist").toBe(
      "timestamp with time zone",
    );
    // Only L1 writes it; every lot that was never asked about stays NULL.
    expect(col?.is_nullable).toBe("YES");
  });
});

class Rollback extends Error {}

describe("migration 0094 on existing lots", () => {
  it("backfills refund_requested_at from updated_at for refund_pending lots only", async () => {
    // Replayed inside a rolled-back transaction from the schema as it was
    // before 0094: the five tables and the column are dropped first. The
    // notifications CHECK is left in place — 0094 drops and re-adds it, as
    // every migration that widened it has (0082). If 0094 grows objects §5.1
    // does not list, add them to the undo here.
    const statements = (await readFile(MIGRATION, "utf8")).split("--> statement-breakpoint");
    const pending = await seedLot("refund_pending");
    const active = await seedLot("active");
    const askedAt = "2026-03-04T05:06:07.000Z";

    let rows: { id: string; refund_requested_at: Date | null }[] = [];
    await sql
      .begin(async (tx) => {
        await tx.unsafe(`DROP TABLE ${NEW_TABLES.join(", ")} CASCADE`);
        await tx`ALTER TABLE credit_lots DROP COLUMN refund_requested_at`;
        await tx`UPDATE credit_lots SET updated_at = ${askedAt} WHERE id IN (${pending.lotId}, ${active.lotId})`;
        for (const statement of statements) await tx.unsafe(statement);
        rows = await tx<{ id: string; refund_requested_at: Date | null }[]>`
          SELECT id, refund_requested_at FROM credit_lots
          WHERE id IN (${pending.lotId}, ${active.lotId})
        `;
        throw new Rollback();
      })
      .catch((err: unknown) => {
        if (!(err instanceof Rollback)) throw err;
      });

    const byId = new Map(rows.map((r) => [r.id, r.refund_requested_at]));
    expect(byId.get(pending.lotId)?.toISOString()).toBe(askedAt);
    expect(byId.has(active.lotId)).toBe(true);
    expect(byId.get(active.lotId)).toBeNull();
  });
});

describe("credit_refund_operations", () => {
  it("carries every column §5.1 names", async () => {
    const cols = await columnsOf("credit_refund_operations");
    expect(cols.size, "credit_refund_operations does not exist").toBeGreaterThan(0);
    for (const name of [
      "id", "lot_id", "payment_id", "kind", "status", "result",
      "attention_reason", "attention_detail", "attention_closed_at", "attention_closed_by",
      "idempotency_key", "request_hash", "requested_by", "reason", "notify",
      "confirmed_refund_ids", "confirmed_succeeded_cents", "settled_succeeded_cents",
      "stripe_refund_id", "first_called_at", "attempt_count", "next_attempt_at", "last_error",
      "lease_token", "locked_until", "created_at", "updated_at", "finished_at",
      "failed_refund_ids", "refund_requested_at",
    ]) {
      expect(cols.has(name), `credit_refund_operations.${name}`).toBe(true);
    }
    // v9: the product never sends an amount, so the column is gone (§5.2).
    expect(cols.has("refund_amount_cents"), "credit_refund_operations.refund_amount_cents").toBe(false);
    expect(cols.get("confirmed_refund_ids")?.data_type).toBe("ARRAY");
    expect(await primaryKeyOf("credit_refund_operations")).toEqual(["id"]);
  });

  it("takes each of the seven kinds", async () => {
    const lot = await seedLot();
    for (const kind of OP_KINDS) {
      expect(await codeOf(insertOperation(lot, { kind })), kind).toBeNull();
    }
  });

  it("refuses a kind outside the seven, refund_again included (v9 removed it)", async () => {
    const lot = await seedLot();
    for (const kind of ["refund", "cancel", "resend", "refund_again"]) {
      expect(await codeOf(insertOperation(lot, { kind })), kind).toBe("23514");
    }
  });

  it("takes the four statuses and refuses any other", async () => {
    for (const status of ["started", "awaiting_stripe", "needs_attention"]) {
      expect(await codeOf(insertOperation(await seedLot(), { status })), status).toBeNull();
    }
    expect(
      await codeOf(insertOperation(await seedLot(), { status: "succeeded", result: "refunded" })),
    ).toBeNull();
    for (const status of ["pending", "failed", "done"]) {
      expect(await codeOf(insertOperation(await seedLot(), { status })), status).toBe("23514");
    }
  });

  it("has a result exactly when it succeeded, and only one of the five", async () => {
    const lot = await seedLot();
    for (const result of OP_RESULTS) {
      expect(
        await codeOf(insertOperation(lot, { status: "succeeded", result })),
        result,
      ).toBeNull();
    }
    expect(await codeOf(insertOperation(lot, { status: "succeeded", result: null }))).toBe("23514");
    expect(await codeOf(insertOperation(lot, { status: "succeeded", result: "failed" }))).toBe(
      "23514",
    );
    for (const status of ["started", "awaiting_stripe", "needs_attention"]) {
      expect(
        await codeOf(insertOperation(await seedLot(), { status, result: "refunded" })),
        status,
      ).toBe("23514");
    }
  });

  it("takes each attention reason of §5.4, stripe_request_invalid included, and refuses any other", async () => {
    for (const attentionReason of ATTENTION_REASONS) {
      expect(await codeOf(insertOperation(await seedLot(), { attentionReason })), attentionReason).toBeNull();
    }
    expect(await codeOf(insertOperation(await seedLot(), { attentionReason: "stripe_unreachable" }))).toBe("23514");
  });

  it("lets an idempotency key take effect once, across lots", async () => {
    const key = crypto.randomUUID();
    expect(await codeOf(insertOperation(await seedLot(), { idempotencyKey: key }))).toBeNull();
    expect(await codeOf(insertOperation(await seedLot(), { idempotencyKey: key }))).toBe("23505");
  });

  it("holds at most one started or awaiting_stripe disposition per lot", async () => {
    const lot = await seedLot();
    const [first] = await insertOperation(lot, { status: "started" });
    expect(await codeOf(insertOperation(lot, { status: "started" }))).toBe("23505");
    expect(await codeOf(insertOperation(lot, { status: "awaiting_stripe" }))).toBe("23505");
    // Finished and parked ones do not count.
    expect(await codeOf(insertOperation(lot, { status: "needs_attention" }))).toBeNull();
    expect(
      await codeOf(insertOperation(lot, { status: "succeeded", result: "sent_back" })),
    ).toBeNull();
    // Once the first one finishes, the lot is free for the next.
    await sql`
      UPDATE credit_refund_operations SET status = 'succeeded', result = 'sent_back'
      WHERE id = ${first!.id}
    `;
    expect(await codeOf(insertOperation(lot, { status: "awaiting_stripe" }))).toBeNull();
    // Another lot is never blocked by this one.
    expect(await codeOf(insertOperation(await seedLot(), { status: "started" }))).toBeNull();
  });

  it("restricts deleting the lot or payment it disposes of", async () => {
    const fks = await foreignKeysOf("credit_refund_operations");
    expect(fks).toEqual(
      expect.arrayContaining([
        { column: "lot_id", references: "credit_lots", on_delete: "r" },
        { column: "payment_id", references: "payments", on_delete: "r" },
      ]),
    );
    const { lotId } = await seedOperation();
    expect(await codeOf(sql`DELETE FROM credit_lots WHERE id = ${lotId}`)).toBe("23503");
  });

  it("refuses a lot that does not exist", async () => {
    const lot = await seedLot();
    expect(
      await codeOf(insertOperation({ ...lot, lotId: crypto.randomUUID() })),
    ).toBe("23503");
  });
});

describe("credit_refund_operation_events", () => {
  it("is append-only and stamped by the database clock", async () => {
    const cols = await columnsOf("credit_refund_operation_events");
    expect(cols.size, "credit_refund_operation_events does not exist").toBeGreaterThan(0);
    for (const name of ["id", "operation_id", "created_at", "event", "from_status", "to_status", "detail"]) {
      expect(cols.has(name), `credit_refund_operation_events.${name}`).toBe(true);
    }
    expect(cols.get("created_at")?.is_nullable).toBe("NO");
    expect(cols.get("created_at")?.column_default).toMatch(/now\(\)/);
    expect(cols.get("detail")?.data_type).toBe("jsonb");
    expect(cols.has("updated_at")).toBe(false);

    const { operationId } = await seedOperation();
    const [row] = await sql.begin(
      (tx) => tx<{ stamped: boolean }[]>`
        INSERT INTO credit_refund_operation_events (operation_id, event, from_status, to_status, detail)
        VALUES (${operationId}, 'claimed', 'started', 'started', '{}'::jsonb)
        RETURNING created_at = now() AS stamped
      `,
    );
    expect(row?.stamped).toBe(true);
  });

  it("refuses an event for a disposition that does not exist", async () => {
    expect(
      await codeOf(sql`
        INSERT INTO credit_refund_operation_events (operation_id, event, from_status, to_status, detail)
        VALUES (${crypto.randomUUID()}, 'claimed', 'started', 'started', '{}'::jsonb)
      `),
    ).toBe("23503");
    expect(await foreignKeysOf("credit_refund_operation_events")).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ column: "operation_id", references: "credit_refund_operations" }),
      ]),
    );
  });
});

describe("credit_refunds", () => {
  it("is keyed by the Stripe refund id and points at its payment, lot and dispositions", async () => {
    const cols = await columnsOf("credit_refunds");
    expect(cols.size, "credit_refunds does not exist").toBeGreaterThan(0);
    for (const name of [
      "stripe_refund_id", "payment_id", "lot_id", "operation_id", "amount_cents", "currency",
      "status", "failure_reason", "ever_succeeded", "resolved_by_operation_id",
      "pending_reason", "created_at", "updated_at",
    ]) {
      expect(cols.has(name), `credit_refunds.${name}`).toBe(true);
    }
    expect(cols.get("pending_reason")?.is_nullable).toBe("YES");
    // A refund made on the Stripe dashboard has no disposition behind it.
    expect(cols.get("operation_id")?.is_nullable).toBe("YES");
    expect(cols.get("resolved_by_operation_id")?.is_nullable).toBe("YES");
    expect(await primaryKeyOf("credit_refunds")).toEqual(["stripe_refund_id"]);
    expect(await foreignKeysOf("credit_refunds")).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ column: "payment_id", references: "payments" }),
        expect.objectContaining({ column: "lot_id", references: "credit_lots" }),
        expect.objectContaining({ column: "operation_id", references: "credit_refund_operations" }),
        expect.objectContaining({
          column: "resolved_by_operation_id",
          references: "credit_refund_operations",
        }),
      ]),
    );
  });

  it("refuses a second copy of the same Stripe refund", async () => {
    const lot = await seedLot();
    const id = `re_${crypto.randomUUID().replaceAll("-", "")}`;
    expect(await codeOf(insertRefund(lot, "pending", { stripeRefundId: id }))).toBeNull();
    expect(await codeOf(insertRefund(lot, "succeeded", { stripeRefundId: id }))).toBe("23505");
  });

  it("takes Stripe's five statuses verbatim and refuses any other", async () => {
    const lot = await seedLot();
    for (const status of STRIPE_REFUND_STATUSES) {
      expect(await codeOf(insertRefund(lot, status)), status).toBeNull();
    }
    for (const status of ["refunded", "cancelled", "processing"]) {
      expect(await codeOf(insertRefund(lot, status)), status).toBe("23514");
    }
  });

  it("takes Stripe's three pending reasons and null, and refuses any other (v9 §5.1)", async () => {
    const lot = await seedLot();
    for (const pendingReason of PENDING_REASONS) {
      expect(await codeOf(insertRefund(lot, "pending", { pendingReason })), pendingReason).toBeNull();
    }
    expect(await codeOf(insertRefund(lot, "succeeded", { pendingReason: null }))).toBeNull();
    for (const pendingReason of ["expired_card", "unknown", ""]) {
      expect(await codeOf(insertRefund(lot, "pending", { pendingReason })), pendingReason).toBe("23514");
    }
  });

  it("answers a failed refund only with a disposition that exists", async () => {
    const { operationId, ...lot } = await seedOperation();
    expect(await codeOf(insertRefund(lot, "failed", { resolvedBy: operationId }))).toBeNull();
    expect(await codeOf(insertRefund(lot, "failed", { resolvedBy: crypto.randomUUID() }))).toBe(
      "23503",
    );
  });
});

describe("refund_mail_outbox", () => {
  it("carries every column §5.1 names", async () => {
    const cols = await columnsOf("refund_mail_outbox");
    expect(cols.size, "refund_mail_outbox does not exist").toBeGreaterThan(0);
    for (const name of [
      "id", "operation_id", "kind", "origin", "requested_by", "reason", "idempotency_key",
      "request_hash", "status", "last_error", "sent_at", "created_at", "updated_at",
    ]) {
      expect(cols.has(name), `refund_mail_outbox.${name}`).toBe(true);
    }
    // Empty on `auto` rows.
    for (const name of ["requested_by", "reason", "idempotency_key", "request_hash"]) {
      expect(cols.get(name)?.is_nullable, name).toBe("YES");
    }
  });

  it("takes the three kinds and refuses any other", async () => {
    for (const kind of MAIL_KINDS) {
      const { operationId } = await seedOperation();
      expect(await codeOf(insertMail(operationId, { kind })), kind).toBeNull();
    }
    const { operationId } = await seedOperation();
    expect(await codeOf(insertMail(operationId, { kind: "refund_failed" }))).toBe("23514");
  });

  it("takes the two origins and refuses any other", async () => {
    const { operationId } = await seedOperation();
    expect(await codeOf(insertMail(operationId, { origin: "auto" }))).toBeNull();
    expect(await codeOf(insertMail(operationId, { origin: "resend" }))).toBeNull();
    expect(await codeOf(insertMail(operationId, { origin: "manual" }))).toBe("23514");
  });

  it("takes the six statuses of §6.5 and refuses any other", async () => {
    const { operationId } = await seedOperation();
    for (const status of MAIL_STATUSES) {
      expect(await codeOf(insertMail(operationId, { origin: "resend", status })), status).toBeNull();
    }
    expect(await codeOf(insertMail(operationId, { origin: "resend", status: "queued" }))).toBe(
      "23514",
    );
  });

  it("sends one automatic mail per disposition, and any number of resends", async () => {
    const { operationId } = await seedOperation();
    expect(await codeOf(insertMail(operationId))).toBeNull();
    expect(await codeOf(insertMail(operationId, { status: "failed" }))).toBe("23505");
    expect(await codeOf(insertMail(operationId, { origin: "resend" }))).toBeNull();
    expect(await codeOf(insertMail(operationId, { origin: "resend" }))).toBeNull();
  });

  it("lets a resend's idempotency key take effect once", async () => {
    const key = crypto.randomUUID();
    const { operationId } = await seedOperation();
    expect(await codeOf(insertMail(operationId, { origin: "resend", idempotencyKey: key }))).toBeNull();
    expect(await codeOf(insertMail(operationId, { origin: "resend", idempotencyKey: key }))).toBe(
      "23505",
    );
  });

  it("refuses a mail for a disposition that does not exist", async () => {
    expect(await codeOf(insertMail(crypto.randomUUID()))).toBe("23503");
  });
});

describe("credit_refund_reconcile_status", () => {
  it("is one row of progress keyed by name", async () => {
    const cols = await columnsOf("credit_refund_reconcile_status");
    expect(cols.size, "credit_refund_reconcile_status does not exist").toBeGreaterThan(0);
    for (const name of [
      "name", "last_started_at", "last_finished_at", "last_ok_at", "last_error",
      "failing_payment_ids", "next_retry_at", "created_at", "updated_at",
    ]) {
      expect(cols.has(name), `credit_refund_reconcile_status.${name}`).toBe(true);
    }
    expect(cols.get("failing_payment_ids")?.data_type).toBe("ARRAY");
    expect(cols.get("updated_at")?.is_nullable).toBe("NO");
    expect(await primaryKeyOf("credit_refund_reconcile_status")).toEqual(["name"]);
  });
});

describe("notifications.type (0094)", () => {
  it("takes the three refund bell types and still refuses one nobody defined", async () => {
    const { userId } = await seedLot();
    for (const type of BELL_TYPES) {
      expect(
        await codeOf(sql`
          INSERT INTO notifications (user_id, type, payload)
          VALUES (${userId}, ${type}, ${sql.json({ lotId: crypto.randomUUID() })})
        `),
        type,
      ).toBeNull();
    }
    expect(
      await codeOf(sql`
        INSERT INTO notifications (user_id, type, payload)
        VALUES (${userId}, 'credit.refund_failed', '{}'::jsonb)
      `),
    ).toBe("23514");
  });
});

describe("none of the five new tables can be soft-deleted", () => {
  it("none can be soft-deleted, and every one has created_at", async () => {
    for (const table of NEW_TABLES) {
      const cols = await columnsOf(table);
      expect(cols.size, `${table} does not exist`).toBeGreaterThan(0);
      expect(cols.has("deleted_at"), `${table}.deleted_at`).toBe(false);
      expect(cols.get("created_at")?.is_nullable, `${table}.created_at`).toBe("NO");
    }
  });
});

describe("credit_ledger.entry_type (v9 §5.1)", () => {
  it("takes refund_reversed and still refuses a type nobody defined", async () => {
    const lot = await seedLot("active");
    expect(
      await codeOf(sql`
        INSERT INTO credit_ledger (payer_user_id, lot_id, entry_type, amount, reference_id)
        VALUES (${lot.userId}, ${lot.lotId}, 'refund_reversed', 0, ${crypto.randomUUID()})
      `),
    ).toBeNull();
    expect(
      await codeOf(sql`
        INSERT INTO credit_ledger (payer_user_id, lot_id, entry_type, amount, reference_id)
        VALUES (${lot.userId}, ${lot.lotId}, 'refund_restored', 0, ${crypto.randomUUID()})
      `),
    ).toBe("23514");
  });
});

describe("the two views of §5.3 (v9)", () => {
  it("both exist, the unresolved one with the columns the back office reads", async () => {
    const rows = await sql<{ table_name: string }[]>`
      SELECT table_name FROM information_schema.views
      WHERE table_schema = 'public' AND table_name IN ${sql([...VIEWS])}
    `;
    expect(rows.map((r) => r.table_name).sort()).toEqual([...VIEWS].sort());
    const cols = await columnsOf("credit_refunds_unresolved_failed");
    for (const name of ["lot_id", "payment_id", "stripe_refund_id", "amount_cents", "currency", "status"]) {
      expect(cols.has(name), `credit_refunds_unresolved_failed.${name}`).toBe(true);
    }
    expect((await columnsOf("credit_lot_refund_failures")).has("lot_id"), "credit_lot_refund_failures.lot_id").toBe(true);
  });

  it("a read-only role given default SELECT on tables can read both views as 0094 creates them (ALTER DEFAULT PRIVILEGES covers views, §5.1)", async () => {
    // Replayed inside a rolled-back transaction: a fresh role stands in for
    // backoffice_ro, the default privilege the deploy step grants is set,
    // and 0094's view statements run again so they are created under it.
    const statements = (await readFile(MIGRATION, "utf8"))
      .split("--> statement-breakpoint")
      .filter((s) => /CREATE\s+(OR\s+REPLACE\s+)?VIEW/i.test(s));
    expect(statements.length, "0094 creates the views").toBeGreaterThanOrEqual(2);
    const role = `bo_ro_test_${crypto.randomUUID().replaceAll("-", "").slice(0, 12)}`;

    let read: { unresolved: number; failures: number } | null = null;
    await sql
      .begin(async (tx) => {
        await tx.unsafe(`DROP VIEW IF EXISTS credit_lot_refund_failures, credit_refunds_unresolved_failed CASCADE`);
        await tx.unsafe(`CREATE ROLE ${role} NOLOGIN`);
        await tx.unsafe(`ALTER DEFAULT PRIVILEGES GRANT SELECT ON TABLES TO ${role}`);
        for (const statement of statements) await tx.unsafe(statement);
        await tx.unsafe(`SET LOCAL ROLE ${role}`);
        const [u] = await tx.unsafe<{ n: number }[]>(`SELECT count(*)::int AS n FROM credit_refunds_unresolved_failed`);
        const [f] = await tx.unsafe<{ n: number }[]>(`SELECT count(*)::int AS n FROM credit_lot_refund_failures`);
        read = { unresolved: u!.n, failures: f!.n };
        throw new Rollback();
      })
      .catch((err: unknown) => {
        if (!(err instanceof Rollback)) throw err;
      });

    expect(read).not.toBeNull();
    expect(read!.unresolved).toBeGreaterThanOrEqual(0);
    expect(read!.failures).toBeGreaterThanOrEqual(0);
  });
});
