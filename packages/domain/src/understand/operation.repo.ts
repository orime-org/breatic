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

    const updated = await tx
      .update(mediaUnderstandingOperations)
      .set({ status: next.status, revision: next.revision, updatedAt: now })
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
    const operationClosed = current.status === "ready" || current.status === "partial" || current.status === "failed" ||
      current.status === "cancelled" || current.status === "expired";
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
