// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The assertions every cell of the §6.2 table repeats (inner#1410), shared
 * by `credit-refund-op-*.integration.test.ts`. Not a test file.
 *
 * Three shapes of cell:
 *
 * - **impossible** — `transitionOperation` throws `ImpossibleTransitionError`
 *   naming the status it found and the event, and writes nothing. The call
 *   runs in a transaction that catches the throw and commits, so a write
 *   made before the throw would survive and show.
 * - **stays** (不变 / 不影响 / 丢弃 / 留 with nothing to record) — every row
 *   is as it was except one new event row on this disposition, with
 *   `from_status = to_status`. Only `updated_at` of the disposition may move.
 * - **moves** — asserted in the case itself.
 */

import { randomUUID } from "node:crypto";
import { expect } from "vitest";
import {
  transitionOperation,
  ImpossibleTransitionError,
  type OperationEvent,
  type StripeFailure,
} from "@server/modules/credit-refund/operation-transitions.js";
import {
  CREDITS,
  EVENT_NAME,
  bellsOf,
  copiesOf,
  inTx,
  ledgerOf,
  mailsOf,
  readLot,
  readOp,
  refusedAndCommitted,
  refundObject,
  reId,
  worldOf,
  type OpStatus,
  type RefundFixture,
  type SeededLot,
  type Sql,
  type WorldState,
} from "./credit-refund-fixtures.js";

export type EventType = OperationEvent["type"];

/**
 * A Stripe failure whose message has two lines, so "the first line" is
 * observable in `attention_detail`.
 * @param httpStatus - The status code Stripe answered.
 * @param extra - `code`, `type`, `shouldRetry`.
 * @returns The failure.
 */
export function failure(httpStatus: number, extra: Partial<StripeFailure> = {}): StripeFailure {
  return {
    message: `Stripe answered ${httpStatus} ${randomUUID().slice(0, 8)}\nrequest req_second_line`,
    httpStatus,
    ...extra,
  };
}

/**
 * A well-formed event of each type, for the cells where only the type
 * matters (impossible, stays).
 * @param type - E2 … E17.
 * @param refund - The refund object E2 … E6 carry.
 * @param closedBy - The disposition E14 names.
 * @returns The event.
 */
export function eventOf(
  type: Exclude<EventType, "E1">,
  refund: RefundFixture = refundObject(reId("any"), "succeeded", 1080),
  closedBy: string = randomUUID(),
): OperationEvent {
  switch (type) {
    case "E2":
    case "E3":
      return { type, refund: { ...refund, status: "succeeded" }, actor: "loop" };
    case "E4":
      return { type, refund: { ...refund, status: "succeeded" }, reason: "partial_refund", actor: "loop" };
    case "E5":
      return { type, refund: { ...refund, status: "pending" }, actor: "loop" };
    case "E6":
      return { type, refund: { ...refund, status: "failed" }, actor: "loop" };
    case "E7":
      return { type, failure: failure(409), actor: "loop" };
    case "E8":
      return { type, failure: failure(502), actor: "loop" };
    case "E9":
      return { type, failure: failure(400, { code: "charge_already_refunded" }), actor: "loop" };
    case "E16":
      return { type, failure: failure(503), actor: "loop" };
    case "E17":
      return { type, failure: failure(402), actor: "loop" };
    case "E10":
    case "E11":
    case "E12":
    case "E13":
      return { type, actor: "loop" };
    case "E14":
      return { type, closedBy, actor: "request" };
  }
}

/**
 * An impossible cell: a typed refusal and nothing written.
 * @param sql - Raw client.
 * @param lot - The lot whose rows must not change.
 * @param op - The disposition, or null for "no row".
 * @param from - The status the error must name (null for no row).
 * @param event - The event.
 */
export async function expectImpossible(
  sql: Sql,
  lot: SeededLot,
  op: { id: string } | null,
  from: OpStatus | null,
  event: OperationEvent,
): Promise<void> {
  const before = await worldOf(sql, lot);
  const err = await refusedAndCommitted((tx) => transitionOperation(tx, op, event));
  expect(err).toBeInstanceOf(ImpossibleTransitionError);
  expect(err).toMatchObject({ from, event: event.type });
  expect(await worldOf(sql, lot)).toEqual(before);
}

/** The world with the disposition's `updated_at` and the events left out. */
function withoutEventsAndTouch(world: WorldState): Omit<WorldState, "events"> {
  const { events: _events, ops, ...rest } = world;
  return { ...rest, ops: ops.map(({ updated_at: _u, ...op }) => op) };
}

/**
 * A cell that leaves everything as it was and appends one event row.
 * @param sql - Raw client.
 * @param lot - The lot.
 * @param opId - The disposition.
 * @param status - Its status before and after.
 * @param event - The event.
 * @param eventName - The `event` column expected (E15 cells pass `late_answer`).
 */
export async function expectStays(
  sql: Sql,
  lot: SeededLot,
  opId: string,
  status: OpStatus,
  event: OperationEvent,
  eventName: string = EVENT_NAME[event.type],
): Promise<void> {
  const before = await worldOf(sql, lot);
  const returned = await inTx((tx) => transitionOperation(tx, { id: opId }, event));
  const after = await worldOf(sql, lot);

  expect(returned).toMatchObject({ id: opId, status });
  expect(withoutEventsAndTouch(after)).toEqual(withoutEventsAndTouch(before));
  const added = after.events.slice(before.events.length);
  expect(after.events.slice(0, before.events.length)).toEqual(before.events);
  expect(added).toHaveLength(1);
  expect(added[0]).toMatchObject({
    operation_id: opId,
    event: eventName,
    from_status: status,
    to_status: status,
  });
}

/**
 * The event rows appended to one disposition by the call under test.
 * @param sql - Raw client.
 * @param lot - The lot.
 * @param before - The world before the call.
 * @param opId - The disposition.
 * @returns `{ event, from_status, to_status }` of each new row on it.
 */
export async function newEventsOn(
  sql: Sql,
  lot: SeededLot,
  before: WorldState,
  opId: string,
): Promise<{ event: unknown; from_status: unknown; to_status: unknown }[]> {
  const after = await worldOf(sql, lot);
  return after.events
    .slice(before.events.length)
    .filter((e) => e.operation_id === opId)
    .map((e) => ({ event: e.event, from_status: e.from_status, to_status: e.to_status }));
}

/**
 * The lot booked by this disposition (§5.5): `refunded`, nothing left, one
 * `refund` row of minus what was left referencing `refundId`, the disposition
 * `succeeded/refunded` with the succeeded sum, and the bell and auto mail
 * exactly when `notify` holds.
 * @param sql - Raw client.
 * @param lot - The lot.
 * @param opId - The disposition that booked it.
 * @param expected - What the booking rests on.
 * @param expected.refundId - The ledger row's reference.
 * @param expected.settledCents - `settled_succeeded_cents`.
 * @param expected.notify - Whether the buyer is told.
 * @param expected.amountCents - The refund amount the bell names.
 */
export async function expectBooked(
  sql: Sql,
  lot: SeededLot,
  opId: string,
  expected: { refundId: string; settledCents: number; notify: boolean; amountCents: number },
): Promise<void> {
  const op = await readOp(sql, opId);
  expect(op).toMatchObject({
    status: "succeeded",
    result: "refunded",
    settled_succeeded_cents: expected.settledCents,
  });
  expect(op.finished_at).not.toBeNull();
  expect(await readLot(sql, lot.lotId)).toEqual({
    lifecycle: "refunded",
    remaining: "0.000000",
    attempts: 0,
  });
  const refundRows = (await ledgerOf(sql, lot.lotId)).filter((r) => r.entry_type === "refund");
  expect(refundRows).toEqual([
    { entry_type: "refund", amount: `-${CREDITS}.000000`, reference_id: expected.refundId },
  ]);
  if (expected.notify) {
    await expectCompletedBell(sql, lot, expected.amountCents);
    expect(await mailsOf(sql, lot.lotId)).toEqual([autoMail(opId, "refund_completed")]);
  } else {
    expect(await bellsOf(sql, lot.userId)).toEqual([]);
    expect(await mailsOf(sql, lot.lotId)).toEqual([]);
  }
}

/**
 * Exactly one `credit.refund_completed` bell, informational, payload per §8.
 * @param sql - Raw client.
 * @param lot - The lot and buyer.
 * @param amountCents - The refund amount it names.
 */
export async function expectCompletedBell(
  sql: Sql,
  lot: SeededLot,
  amountCents: number,
): Promise<void> {
  const bells = await bellsOf(sql, lot.userId);
  expect(bells).toHaveLength(1);
  expect(bells[0]).toMatchObject({
    type: "credit.refund_completed",
    expires_at: null,
    project_id: null,
  });
  expect(Object.keys(bells[0]!.payload).sort()).toEqual([
    "amountCents",
    "credits",
    "currency",
    "lotId",
  ]);
  expect(bells[0]!.payload.lotId).toBe(lot.lotId);
  expect(Number(bells[0]!.payload.credits)).toBe(CREDITS);
  expect(bells[0]!.payload.amountCents).toBe(amountCents);
  expect(bells[0]!.payload.currency).toBe("usd");
}

/**
 * The automatic mail row a finishing disposition inserts (§6.5 M0).
 * @param opId - The disposition.
 * @param kind - Which mail.
 * @returns The row as `mailsOf` reads it.
 */
export function autoMail(
  opId: string,
  kind: "refund_completed" | "refund_rejected" | "refund_restored",
): {
  operation_id: string;
  kind: string;
  origin: string;
  status: string;
  requested_by: null;
  idempotency_key: null;
} {
  return {
    operation_id: opId,
    kind,
    origin: "auto",
    status: "pending",
    requested_by: null,
    idempotency_key: null,
  };
}

/**
 * An earlier disposition closed by a later one (E14): closed time and closer
 * written, still `needs_attention` with its reason, and one
 * `attention_closed` row on it.
 * @param sql - Raw client.
 * @param lot - The lot.
 * @param before - The world before the call.
 * @param closedId - The disposition that was open.
 * @param closerId - The one whose finish closed it.
 */
export async function expectClosedBy(
  sql: Sql,
  lot: SeededLot,
  before: WorldState,
  closedId: string,
  closerId: string,
): Promise<void> {
  const closed = await readOp(sql, closedId);
  expect(closed.status).toBe("needs_attention");
  expect(closed.attention_reason).not.toBeNull();
  expect(closed.attention_closed_at).not.toBeNull();
  expect(closed.attention_closed_by).toBe(closerId);
  expect(await newEventsOn(sql, lot, before, closedId)).toEqual([
    { event: "attention_closed", from_status: "needs_attention", to_status: "needs_attention" },
  ]);
}

/**
 * The lot restored by a restore_credits disposition (v9 §5.3 row 5, §6.3
 * L9, §8): the disposition `succeeded/restored`; the lot `active` with its
 * credits back and `refund_attempts` unchanged; one `refund_reversed` ledger
 * row naming the disposition, worth the negation of the lot's `refund` row
 * when it had been booked and 0 when not; the failed refunds it answered
 * for resolved by it; one `credit.refund_restored` bell and one auto
 * `refund_restored` mail row.
 * @param sql - Raw client.
 * @param lot - The lot.
 * @param opId - The restore_credits disposition.
 * @param expected - What the restore rests on.
 * @param expected.wasBooked - True when the lot was `refunded` (a `refund` row exists).
 * @param expected.resolved - The refunds it answered for.
 * @param expected.attempts - `refund_attempts` before the restore; it must not move.
 * @param expected.mailStatuses - Statuses the auto mail row may already have reached; `pending` when absent.
 */
export async function expectRestored(
  sql: Sql,
  lot: SeededLot,
  opId: string,
  expected: { wasBooked: boolean; resolved: readonly string[]; attempts?: number; mailStatuses?: readonly string[] },
): Promise<void> {
  const op = await readOp(sql, opId);
  expect(op).toMatchObject({ kind: "restore_credits", status: "succeeded", result: "restored", notify: true });
  expect(op.finished_at).not.toBeNull();
  expect(await readLot(sql, lot.lotId)).toEqual({
    lifecycle: "active",
    remaining: `${CREDITS}.000000`,
    attempts: expected.attempts ?? 0,
  });
  const ledger = await ledgerOf(sql, lot.lotId);
  expect(ledger.filter((r) => r.entry_type === "refund_reversed")).toEqual([
    {
      entry_type: "refund_reversed",
      amount: expected.wasBooked ? `${CREDITS}.000000` : "0.000000",
      reference_id: opId,
    },
  ]);
  expect(ledger.filter((r) => r.entry_type === "refund")).toHaveLength(expected.wasBooked ? 1 : 0);
  const resolvedBy = new Map((await copiesOf(sql, lot.lotId)).map((c) => [c.stripe_refund_id, c.resolved_by_operation_id]));
  for (const id of expected.resolved) expect(resolvedBy.get(id)).toBe(opId);
  await expectRestoredBell(sql, lot);
  const mails = await mailsOf(sql, lot.lotId);
  expect(mails.filter((m) => m.operation_id === opId)).toEqual([
    { ...autoMail(opId, "refund_restored"), status: expect.any(String) },
  ]);
  const status = mails.find((m) => m.operation_id === opId)!.status;
  expect(expected.mailStatuses ?? ["pending"]).toContain(status);
}

/**
 * Exactly one `credit.refund_restored` bell (v9 §8): informational, no
 * expiry, payload `lotId` and `credits`.
 * @param sql - Raw client.
 * @param lot - The lot and buyer.
 */
export async function expectRestoredBell(sql: Sql, lot: SeededLot): Promise<void> {
  const bells = (await bellsOf(sql, lot.userId)).filter((b) => b.type === "credit.refund_restored");
  expect(bells).toHaveLength(1);
  expect(bells[0]).toMatchObject({ type: "credit.refund_restored", expires_at: null, project_id: null });
  expect(Object.keys(bells[0]!.payload).sort()).toEqual(["credits", "lotId"]);
  expect(bells[0]!.payload.lotId).toBe(lot.lotId);
  expect(Number(bells[0]!.payload.credits)).toBe(CREDITS);
}
