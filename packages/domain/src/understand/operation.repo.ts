// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { randomUUID } from "node:crypto";
import { and, asc, eq, inArray, isNull, lte, sql } from "drizzle-orm";
import {
  db,
  mediaUnderstandingOperations,
} from "@breatic/core";
import type { UnderstandOperationEvent, UnderstandOperationStatus } from "@domain/understand/operation-state.js";
import { reduceUnderstandOperation } from "@domain/understand/operation-state.js";
import type { UnderstandDispatchEvent, UnderstandDispatchState } from "@domain/understand/dispatch-state.js";
import { reduceUnderstandDispatch } from "@domain/understand/dispatch-state.js";

/** Immutable identity and execution inputs for opening one long-media operation. */
export interface OpenUnderstandOperationInput {
  actorUserId: string;
  projectId?: string | null;
  originKind: "agent_turn" | "canvas_task";
  originKey: string;
  requestDigest: string;
  sources: Record<string, unknown>[];
  question: string;
  mode: string;
  locale: string;
  model: string;
  promptVersion: string;
  deadlineAt: Date;
  recoveryGroupId: string;
  logicalRequestId: string;
  userActionId: string;
}

type OperationRow = typeof mediaUnderstandingOperations.$inferSelect;

/** A worker's exclusive execution lease, fenced by operation epoch. */
export type UnderstandOperationLease =
  | { kind: "claimed"; token: string; epoch: number; revision: number; expiresAt: Date }
  | { kind: "busy" | "blocked" | "closed" | "expired" };

/** The result of renewing or releasing one fenced operation lease. */
export type UnderstandOperationLeaseMutation =
  | { kind: "applied"; revision: number; expiresAt?: Date }
  | { kind: "stale" | "closed" };

/** One due durable queue wake selected for Redis delivery. */
export interface DueUnderstandDispatch {
  operationId: string;
  revision: number;
  sequence: number;
}

/**
 * Open or idempotently recover a long-media operation for one trusted user action.
 * @param input - Authenticated origin, immutable request facts and absolute deadline.
 * @returns The existing matching operation or the newly created root operation.
 * @throws {Error} when the same trusted action key is reused for different input facts.
 */
export async function openUnderstandOperation(
  input: OpenUnderstandOperationInput,
): Promise<OperationRow> {
  return db.transaction(async (tx) => {
    const id = randomUUID();
    const inserted = await tx
      .insert(mediaUnderstandingOperations)
      .values({
        id,
        actorUserId: input.actorUserId,
        projectId: input.projectId ?? null,
        originKind: input.originKind,
        originKey: input.originKey,
        requestDigest: input.requestDigest,
        sources: input.sources,
        question: input.question,
        mode: input.mode,
        locale: input.locale,
        model: input.model,
        promptVersion: input.promptVersion,
        deadlineAt: input.deadlineAt,
        recoveryGroupId: input.recoveryGroupId,
        logicalRequestId: input.logicalRequestId,
        logicalRootOperationId: id,
        userActionId: input.userActionId,
        rootDeadlineAt: input.deadlineAt,
      })
      .onConflictDoNothing()
      .returning();
    if (inserted[0]) return inserted[0];

    const existing = await tx
      .select()
      .from(mediaUnderstandingOperations)
      .where(and(
        eq(mediaUnderstandingOperations.actorUserId, input.actorUserId),
        eq(mediaUnderstandingOperations.userActionId, input.userActionId),
        eq(mediaUnderstandingOperations.logicalRequestId, input.logicalRequestId),
        isNull(mediaUnderstandingOperations.deletedAt),
      ))
      .limit(1);
    if (!existing[0] || existing[0].requestDigest !== input.requestDigest) {
      throw new Error("The trusted user action is already bound to different media-understanding input.");
    }
    return existing[0];
  });
}

/**
 * Read an operation by its stable identifier, excluding soft-deleted rows.
 * @param id - Operation UUID.
 * @returns The active operation, or null when it does not exist.
 */
export async function getUnderstandOperation(id: string): Promise<OperationRow | null> {
  const rows = await db
    .select()
    .from(mediaUnderstandingOperations)
    .where(and(eq(mediaUnderstandingOperations.id, id), isNull(mediaUnderstandingOperations.deletedAt)))
    .limit(1);
  return rows[0] ?? null;
}

/**
 * Claim a queued or recoverable running operation under a database-clock lease.
 * @param id - Operation UUID.
 * @param leaseDurationMs - Configured lease duration.
 * @returns A new fenced lease, or the reason no lease was granted.
 * @throws {RangeError} when the lease duration or epoch cannot advance safely.
 * @throws {Error} when the operation does not exist or its database update loses.
 */
export async function claimUnderstandOperationLease(
  id: string,
  leaseDurationMs: number,
): Promise<UnderstandOperationLease> {
  if (!Number.isSafeInteger(leaseDurationMs) || leaseDurationMs < 1) {
    throw new RangeError("The operation lease duration must be a positive safe integer.");
  }
  return db.transaction(async (tx) => {
    const rows = await tx
      .select()
      .from(mediaUnderstandingOperations)
      .where(and(eq(mediaUnderstandingOperations.id, id), isNull(mediaUnderstandingOperations.deletedAt)))
      .for("update")
      .limit(1);
    const current = rows[0];
    if (!current) throw new Error("The media-understanding operation does not exist.");
    const clockRows = await tx.execute(sql`SELECT clock_timestamp() AS now`);
    if (!clockRows[0]) throw new Error("The database clock could not be read.");
    const now = new Date(String(clockRows[0].now));
    const terminal = current.status === "ready" || current.status === "partial" || current.status === "failed" ||
      current.status === "cancelled" || current.status === "expired";
    if (terminal) return { kind: "closed" };
    if (now.getTime() >= current.deadlineAt.getTime()) {
      const expired = reduceUnderstandOperation({
        status: current.status as UnderstandOperationStatus,
        revision: current.revision,
        deadlineAtMs: current.deadlineAt.getTime(),
      }, { type: "deadline", expectedRevision: current.revision, atMs: now.getTime() });
      await tx.update(mediaUnderstandingOperations)
        .set({ status: expired.status, revision: expired.revision, leaseToken: null, leaseExpiresAt: null, updatedAt: now })
        .where(eq(mediaUnderstandingOperations.id, id));
      return { kind: "expired" };
    }
    if (current.status === "blocked") return { kind: "blocked" };
    if (current.leaseToken !== null && current.leaseExpiresAt !== null && current.leaseExpiresAt.getTime() > now.getTime()) {
      return { kind: "busy" };
    }
    if (current.leaseEpoch >= Number.MAX_SAFE_INTEGER) {
      throw new RangeError("The operation lease epoch cannot increase safely.");
    }
    const token = randomUUID();
    const epoch = current.leaseEpoch + 1;
    const status = current.status === "queued" ? "running" : current.status;
    const expiresAt = new Date(Math.min(now.getTime() + leaseDurationMs, current.deadlineAt.getTime()));
    const revision = current.revision + 1;
    const updated = await tx.update(mediaUnderstandingOperations)
      .set({ status, revision, leaseEpoch: epoch, leaseToken: token, leaseExpiresAt: expiresAt, updatedAt: now })
      .where(and(eq(mediaUnderstandingOperations.id, id), eq(mediaUnderstandingOperations.revision, current.revision)))
      .returning();
    if (!updated[0]) throw new Error("The operation changed before its lease was committed.");
    return { kind: "claimed", token, epoch, revision, expiresAt };
  });
}

/**
 * Renew an unexpired lease held by its current fenced owner.
 * @param id - Operation UUID.
 * @param token - The lease owner's unguessable token.
 * @param epoch - The lease fencing epoch.
 * @param leaseDurationMs - Configured lease duration.
 * @returns The renewed expiry or a stale/closed result.
 * @throws {RangeError} when the lease duration is invalid.
 * @throws {Error} when the operation is missing.
 */
export async function renewUnderstandOperationLease(
  id: string,
  token: string,
  epoch: number,
  leaseDurationMs: number,
): Promise<UnderstandOperationLeaseMutation> {
  if (!Number.isSafeInteger(leaseDurationMs) || leaseDurationMs < 1) {
    throw new RangeError("The operation lease duration must be a positive safe integer.");
  }
  return mutateUnderstandOperationLease(id, (current, now) => {
    if (current.status === "ready" || current.status === "partial" || current.status === "failed" ||
      current.status === "cancelled" || current.status === "expired") return { kind: "closed" };
    if (now.getTime() >= current.deadlineAt.getTime()) return { kind: "stale" };
    if (current.leaseToken !== token || current.leaseEpoch !== epoch || current.leaseExpiresAt === null ||
      current.leaseExpiresAt.getTime() <= now.getTime()) return { kind: "stale" };
    const expiresAt = new Date(Math.min(now.getTime() + leaseDurationMs, current.deadlineAt.getTime()));
    return { kind: "applied", revision: current.revision + 1, expiresAt };
  });
}

/**
 * Release the current lease without changing ownership held by a newer epoch.
 * @param id - Operation UUID.
 * @param token - The lease owner's unguessable token.
 * @param epoch - The lease fencing epoch.
 * @returns Whether this owner released its lease or no longer owns it.
 * @throws {Error} when the operation is missing.
 */
export async function releaseUnderstandOperationLease(
  id: string,
  token: string,
  epoch: number,
): Promise<UnderstandOperationLeaseMutation> {
  return mutateUnderstandOperationLease(id, (current) => {
    if (current.leaseToken !== token || current.leaseEpoch !== epoch) return { kind: "stale" };
    if (current.status === "ready" || current.status === "partial" || current.status === "failed" ||
      current.status === "cancelled" || current.status === "expired") return { kind: "closed" };
    return { kind: "applied", revision: current.revision + 1 };
  });
}

/**
 * Serialize a lease mutation against claim and terminal operation changes.
 * @param id - Operation UUID.
 * @param decide - The locked row and database time decision.
 * @returns The persisted lease mutation result.
 * @throws {Error} when the operation is missing or the update loses.
 */
async function mutateUnderstandOperationLease(
  id: string,
  decide: (current: OperationRow, now: Date) => UnderstandOperationLeaseMutation,
): Promise<UnderstandOperationLeaseMutation> {
  return db.transaction(async (tx) => {
    const rows = await tx.select().from(mediaUnderstandingOperations)
      .where(and(eq(mediaUnderstandingOperations.id, id), isNull(mediaUnderstandingOperations.deletedAt)))
      .for("update").limit(1);
    const current = rows[0];
    if (!current) throw new Error("The media-understanding operation does not exist.");
    const clockRows = await tx.execute(sql`SELECT clock_timestamp() AS now`);
    if (!clockRows[0]) throw new Error("The database clock could not be read.");
    const now = new Date(String(clockRows[0].now));
    const decision = decide(current, now);
    if (decision.kind !== "applied") return decision;
    const updated = await tx.update(mediaUnderstandingOperations)
      .set({
        ...(decision.expiresAt === undefined
          ? { leaseToken: null, leaseExpiresAt: null }
          : { leaseExpiresAt: decision.expiresAt }),
        revision: decision.revision,
        updatedAt: now,
      })
      .where(and(eq(mediaUnderstandingOperations.id, id), eq(mediaUnderstandingOperations.revision, current.revision)))
      .returning();
    if (!updated[0]) throw new Error("The operation changed before its lease mutation was committed.");
    return decision;
  });
}

/**
 * Find due outbox wakes that still belong to active operations.
 * @param limit - Maximum number of wake candidates to return.
 * @returns Pending or sent wake identities in due-time order.
 * @throws {RangeError} when the requested batch limit is invalid.
 */
export async function listDueUnderstandDispatches(limit: number): Promise<DueUnderstandDispatch[]> {
  if (!Number.isSafeInteger(limit) || limit < 1) throw new RangeError("The dispatch scan limit must be a positive integer.");
  const rows = await db
    .select({
      operationId: mediaUnderstandingOperations.id,
      revision: mediaUnderstandingOperations.revision,
      sequence: mediaUnderstandingOperations.dispatchSequence,
    })
    .from(mediaUnderstandingOperations)
    .where(and(
      inArray(mediaUnderstandingOperations.status, ["queued", "running"]),
      inArray(mediaUnderstandingOperations.dispatchState, ["pending", "sent"]),
      lte(mediaUnderstandingOperations.dispatchDueAt, sql`clock_timestamp()`),
      isNull(mediaUnderstandingOperations.deletedAt),
    ))
    .orderBy(asc(mediaUnderstandingOperations.dispatchDueAt), asc(mediaUnderstandingOperations.createdAt))
    .limit(limit);
  return rows;
}

/**
 * Apply one lifecycle event under a row lock and persist its revision with compare-and-set.
 * @param id - Operation UUID.
 * @param event - Event carrying the revision and evidence expected by the reducer.
 * @returns The resulting persisted operation.
 * @throws {Error} when the operation is missing or the event loses revision/deadline arbitration.
 */
export async function applyUnderstandOperationEvent(
  id: string,
  event: UnderstandOperationEvent,
): Promise<OperationRow> {
  return db.transaction(async (tx) => {
    const rows = await tx
      .select()
      .from(mediaUnderstandingOperations)
      .where(and(eq(mediaUnderstandingOperations.id, id), isNull(mediaUnderstandingOperations.deletedAt)))
      .for("update")
      .limit(1);
    const current = rows[0];
    if (!current) throw new Error("The media-understanding operation does not exist.");
    const clockRows = await tx.execute(sql`SELECT clock_timestamp() AS now`);
    if (!clockRows[0]) throw new Error("The database clock could not be read.");
    const now = new Date(String(clockRows[0].now));

    const next = reduceUnderstandOperation({
      status: current.status as UnderstandOperationStatus,
      revision: current.revision,
      deadlineAtMs: current.deadlineAt.getTime(),
    }, { ...event, atMs: now.getTime() });
    if (next.revision === current.revision) return current;

    const ended = isTerminalUnderstandOperation(next.status);
    const updated = await tx
      .update(mediaUnderstandingOperations)
      .set({
        status: next.status,
        revision: next.revision,
        ...(ended ? { leaseToken: null, leaseExpiresAt: null } : {}),
        updatedAt: now,
      })
      .where(and(
        eq(mediaUnderstandingOperations.id, id),
        eq(mediaUnderstandingOperations.revision, event.expectedRevision),
      ))
      .returning();
    if (!updated[0]) throw new Error("The media-understanding operation revision changed before the event committed.");
    return updated[0];
  });
}

/**
 * Apply one durable queue-delivery event under the operation row lock.
 * @param id - Operation UUID.
 * @param event - The outbox event and expected operation revision.
 * @returns The operation with the persisted outbox state.
 * @throws {Error} when the operation is missing or the event loses revision arbitration.
 */
export async function applyUnderstandDispatchEvent(
  id: string,
  event: UnderstandDispatchEvent,
): Promise<OperationRow> {
  return db.transaction(async (tx) => {
    const rows = await tx
      .select()
      .from(mediaUnderstandingOperations)
      .where(and(eq(mediaUnderstandingOperations.id, id), isNull(mediaUnderstandingOperations.deletedAt)))
      .for("update")
      .limit(1);
    const current = rows[0];
    if (!current) throw new Error("The media-understanding operation does not exist.");
    const operationClosed = isTerminalUnderstandOperation(current.status as UnderstandOperationStatus);
    if (operationClosed && event.type === "approved-handoff") {
      throw new Error("Cannot create an approved handoff for a closed operation.");
    }
    if (operationClosed && event.type !== "operation-ended") return current;

    const clockRows = await tx.execute(sql`SELECT clock_timestamp() AS now`);
    if (!clockRows[0]) throw new Error("The database clock could not be read.");
    const now = new Date(String(clockRows[0].now));
    const state: UnderstandDispatchState = {
      status: current.dispatchState as UnderstandDispatchState["status"],
      sequence: current.dispatchSequence,
      revision: current.revision,
      dueAtMs: current.dispatchDueAt.getTime(),
    };
    const reducedEvent = event.type === "dispatch" ? { ...event, atMs: now.getTime() } : event;
    const next = reduceUnderstandDispatch(state, reducedEvent);
    if (next.revision === current.revision) return current;

    const updated = await tx
      .update(mediaUnderstandingOperations)
      .set({
        dispatchState: next.status,
        dispatchSequence: next.sequence,
        dispatchDueAt: new Date(next.dueAtMs),
        revision: next.revision,
        updatedAt: now,
      })
      .where(and(
        eq(mediaUnderstandingOperations.id, id),
        eq(mediaUnderstandingOperations.revision, event.expectedRevision),
      ))
      .returning();
    if (!updated[0]) throw new Error("The operation revision changed before its dispatch event committed.");
    return updated[0];
  });
}

/**
 * Tell whether an operation status ends execution permanently.
 * @param status - The persisted lifecycle status.
 * @returns True when new execution work must be rejected.
 */
function isTerminalUnderstandOperation(status: UnderstandOperationStatus): boolean {
  return status === "ready" || status === "partial" || status === "failed" || status === "cancelled" ||
    status === "expired";
}
