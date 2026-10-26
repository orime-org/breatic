// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { randomUUID } from "node:crypto";
import { and, asc, desc, eq, inArray, isNull, lte, sql } from "drizzle-orm";
import {
  db,
  mediaUnderstandingAttempts,
  mediaUnderstandingOperations,
  mediaUnderstandingSteps,
} from "@breatic/core";
import type { UnderstandAtAnswer } from "@domain/understand/understand-at.js";
import type { LongMediaBatchStart } from "@domain/understand/understand-segment-batches.js";
import type { UnderstandOperationEvent, UnderstandOperationStatus } from "@domain/understand/operation-state.js";
import { reduceUnderstandOperation } from "@domain/understand/operation-state.js";
import type { UnderstandDispatchEvent, UnderstandDispatchState } from "@domain/understand/dispatch-state.js";
import { reduceUnderstandDispatch } from "@domain/understand/dispatch-state.js";

/** Immutable identity and execution inputs for opening one long-media operation. */
export interface OpenUnderstandOperationInput {
  id?: string;
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
  dispatchState?: "pending" | "sent" | "claimed" | "retired";
}

type OperationRow = typeof mediaUnderstandingOperations.$inferSelect;
type BatchAnswer = Pick<UnderstandAtAnswer, "text" | "kind" | "kinds">;

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
    const id = input.id ?? randomUUID();
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
        ...(input.dispatchState === undefined ? {} : { dispatchState: input.dispatchState }),
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
 * Reserve a batch's single model request or return its durable state.
 * @param operationId - Stable long-media operation identity.
 * @param batchKey - Ordered batch key within the operation.
 * @param inputDigest - Digest of the question, model and ordered segment inputs.
 * @param leaseToken - Current operation lease token, or null for read-only recovery.
 * @param leaseEpoch - Current operation lease epoch.
 * @returns A send permit, persisted answer, unknown outcome or active-owner result.
 * @throws {Error} when inputs conflict, the lease is stale, or persisted data is malformed.
 */
export async function beginUnderstandBatchAttempt(
  operationId: string,
  batchKey: string,
  inputDigest: string,
  leaseToken: string | null,
  leaseEpoch: number,
): Promise<LongMediaBatchStart> {
  return db.transaction(async (tx) => {
    const operationRows = await tx.select().from(mediaUnderstandingOperations)
      .where(and(eq(mediaUnderstandingOperations.id, operationId), isNull(mediaUnderstandingOperations.deletedAt)))
      .for("update").limit(1);
    const operation = operationRows[0];
    if (!operation) throw new Error("The media-understanding operation does not exist.");
    const existingRows = await tx.select().from(mediaUnderstandingSteps).where(and(
      eq(mediaUnderstandingSteps.operationId, operationId),
      eq(mediaUnderstandingSteps.stepKey, batchKey),
      isNull(mediaUnderstandingSteps.deletedAt),
    )).for("update").limit(1);
    const existing = existingRows[0];
    if (existing && existing.inputDigest !== inputDigest) {
      throw new Error("The long-media batch key is already bound to different request inputs.");
    }
    if (operation.status === "blocked" || operation.status === "ready") {
      if (!existing) throw new Error("The long-media batch step is missing from its closed operation.");
      if (existing.status === "ready") return { kind: "ready", answer: parseBatchAnswer(existing.result) };
      if (operation.status === "blocked" && existing.activeAttemptId !== null) {
        const attemptRows = await tx.select().from(mediaUnderstandingAttempts).where(and(
          eq(mediaUnderstandingAttempts.id, existing.activeAttemptId),
          isNull(mediaUnderstandingAttempts.deletedAt),
        )).for("update").limit(1);
        if (attemptRows[0]?.requestState === "unknown") return { kind: "unknown" };
      }
      throw new Error("The long-media operation is closed without a complete batch answer.");
    }
    if (leaseToken === null || operation.status !== "running" || operation.leaseToken !== leaseToken ||
      operation.leaseEpoch !== leaseEpoch) {
      throw new Error("The long-media batch does not hold the current operation lease.");
    }
    if (!existing) {
      await tx.insert(mediaUnderstandingSteps).values({
        operationId,
        stepKey: batchKey,
        kind: "read_batch",
        inputDigest,
      }).onConflictDoNothing();
    }
    const stepRows = await tx.select().from(mediaUnderstandingSteps).where(and(
      eq(mediaUnderstandingSteps.operationId, operationId),
      eq(mediaUnderstandingSteps.stepKey, batchKey),
      isNull(mediaUnderstandingSteps.deletedAt),
    )).for("update").limit(1);
    const step = stepRows[0];
    if (!step) throw new Error("The long-media batch step could not be created.");
    if (step.status === "ready") return { kind: "ready", answer: parseBatchAnswer(step.result) };
    if (step.activeAttemptId !== null) {
      const attemptRows = await tx.select().from(mediaUnderstandingAttempts).where(and(
        eq(mediaUnderstandingAttempts.id, step.activeAttemptId),
        isNull(mediaUnderstandingAttempts.deletedAt),
      )).for("update").limit(1);
      const attempt = attemptRows[0];
      if (!attempt || attempt.inputDigest !== inputDigest) {
        throw new Error("The active long-media batch attempt is missing or has different inputs.");
      }
      if (attempt.requestState === "unknown") return { kind: "unknown" };
      if (attempt.requestState === "prepared") {
        if (attempt.sendAuthorityEpoch === leaseEpoch) return { kind: "busy" };
        if (attempt.sendAuthorityEpoch > leaseEpoch) {
          throw new Error("The prepared long-media attempt belongs to a newer lease.");
        }
        await tx.update(mediaUnderstandingAttempts).set({ requestState: "rejected" })
          .where(eq(mediaUnderstandingAttempts.id, attempt.id));
        await tx.update(mediaUnderstandingSteps).set({ status: "pending", activeAttemptId: null })
          .where(eq(mediaUnderstandingSteps.id, step.id));
      } else if (attempt.requestState !== "sending") {
        throw new Error("The active long-media batch attempt has an invalid request state.");
      } else {
        if (attempt.sendAuthorityEpoch === leaseEpoch) return { kind: "busy" };
        if (attempt.sendAuthorityEpoch > leaseEpoch) {
          throw new Error("The active long-media batch attempt belongs to a newer lease.");
        }
        await tx.update(mediaUnderstandingAttempts).set({ requestState: "unknown" })
          .where(eq(mediaUnderstandingAttempts.id, attempt.id));
        await tx.update(mediaUnderstandingSteps).set({ status: "failed" })
          .where(eq(mediaUnderstandingSteps.id, step.id));
        const clockRows = await tx.execute(sql`SELECT clock_timestamp() AS now`);
        if (!clockRows[0]) throw new Error("The database clock could not be read.");
        const atMs = new Date(String(clockRows[0].now)).getTime();
        const unknownEvent: UnderstandOperationEvent = atMs >= operation.deadlineAt.getTime()
          ? { type: "deadline", expectedRevision: operation.revision, atMs }
          : { type: "unknown", expectedRevision: operation.revision, atMs };
        const nextOperation = reduceUnderstandOperation({
          status: operation.status,
          revision: operation.revision,
          deadlineAtMs: operation.deadlineAt.getTime(),
        }, unknownEvent);
        const updated = await tx.update(mediaUnderstandingOperations)
          .set({ status: nextOperation.status, revision: nextOperation.revision })
          .where(and(eq(mediaUnderstandingOperations.id, operationId), eq(mediaUnderstandingOperations.revision, operation.revision)))
          .returning({ id: mediaUnderstandingOperations.id });
        if (!updated[0]) throw new Error("The operation changed while its batch outcome was being blocked.");
        return { kind: "unknown" };
      }
    }
    const priorAttempts = await tx.select({ attemptNo: mediaUnderstandingAttempts.attemptNo })
      .from(mediaUnderstandingAttempts).where(and(
        eq(mediaUnderstandingAttempts.stepId, step.id),
        isNull(mediaUnderstandingAttempts.deletedAt),
      )).orderBy(desc(mediaUnderstandingAttempts.attemptNo)).limit(1);
    const attemptNo = (priorAttempts[0]?.attemptNo ?? 0) + 1;
    const inserted = await tx.insert(mediaUnderstandingAttempts).values({
      operationId,
      stepId: step.id,
      attemptNo,
      inputDigest,
      epoch: leaseEpoch,
      requestState: "prepared",
      sendAuthorityEpoch: leaseEpoch,
    }).returning({ id: mediaUnderstandingAttempts.id });
    const attemptId = inserted[0]?.id;
    if (!attemptId) throw new Error("The long-media batch attempt could not be created.");
    await tx.update(mediaUnderstandingSteps).set({ status: "running", activeAttemptId: attemptId })
      .where(eq(mediaUnderstandingSteps.id, step.id));
    return { kind: "prepared", attemptId };
  });
}

/**
 * Persist model-send authority immediately before issuing the provider request.
 * @param operationId - Stable long-media operation identity.
 * @param batchKey - Ordered batch key within the operation.
 * @param inputDigest - Digest of the question, model and ordered segment inputs.
 * @param attemptId - The prepared attempt receiving send authority.
 * @param leaseToken - Current operation lease token.
 * @param leaseEpoch - Current operation lease epoch.
 * @returns Nothing after send authority is durable.
 * @throws {Error} when the lease, step or attempt is no longer current.
 */
export async function markUnderstandBatchAttemptSending(
  operationId: string,
  batchKey: string,
  inputDigest: string,
  attemptId: string,
  leaseToken: string,
  leaseEpoch: number,
): Promise<void> {
  await db.transaction(async (tx) => {
    const operationRows = await tx.select().from(mediaUnderstandingOperations).where(and(
      eq(mediaUnderstandingOperations.id, operationId),
      isNull(mediaUnderstandingOperations.deletedAt),
    )).for("update").limit(1);
    const operation = operationRows[0];
    if (!operation || operation.status !== "running" || operation.leaseToken !== leaseToken ||
      operation.leaseEpoch !== leaseEpoch) {
      throw new Error("The long-media operation lease changed before model send authority was recorded.");
    }
    const stepRows = await tx.select().from(mediaUnderstandingSteps).where(and(
      eq(mediaUnderstandingSteps.operationId, operationId),
      eq(mediaUnderstandingSteps.stepKey, batchKey),
      eq(mediaUnderstandingSteps.inputDigest, inputDigest),
      eq(mediaUnderstandingSteps.activeAttemptId, attemptId),
      eq(mediaUnderstandingSteps.status, "running"),
      isNull(mediaUnderstandingSteps.deletedAt),
    )).for("update").limit(1);
    const step = stepRows[0];
    if (!step) throw new Error("The long-media batch attempt lost its send slot.");
    const attempts = await tx.select().from(mediaUnderstandingAttempts).where(and(
      eq(mediaUnderstandingAttempts.id, attemptId),
      eq(mediaUnderstandingAttempts.stepId, step.id),
      eq(mediaUnderstandingAttempts.sendAuthorityEpoch, leaseEpoch),
      eq(mediaUnderstandingAttempts.requestState, "prepared"),
      isNull(mediaUnderstandingAttempts.deletedAt),
    )).for("update").limit(1);
    if (!attempts[0]) throw new Error("The long-media batch attempt is not prepared for this lease.");
    await tx.update(mediaUnderstandingAttempts).set({ requestState: "sending" })
      .where(eq(mediaUnderstandingAttempts.id, attemptId));
  });
}

/**
 * Atomically accept a full model answer and its batch checkpoint.
 * @param operationId - Stable long-media operation identity.
 * @param batchKey - Ordered batch key within the operation.
 * @param inputDigest - Digest of the question, model and ordered segment inputs.
 * @param attemptId - The attempt that held the send authority.
 * @param leaseToken - Current operation lease token.
 * @param leaseEpoch - Current operation lease epoch.
 * @param answer - Complete answer text and its media kinds.
 * @returns Nothing after the result is durably saved.
 * @throws {Error} when the lease or attempt is stale, its input changed, or its update loses.
 */
export async function saveUnderstandBatchAttemptResult(
  operationId: string,
  batchKey: string,
  inputDigest: string,
  attemptId: string,
  leaseToken: string,
  leaseEpoch: number,
  answer: BatchAnswer,
): Promise<void> {
  await db.transaction(async (tx) => {
    const operationRows = await tx.select().from(mediaUnderstandingOperations).where(and(
      eq(mediaUnderstandingOperations.id, operationId),
      isNull(mediaUnderstandingOperations.deletedAt),
    )).for("update").limit(1);
    const operation = operationRows[0];
    if (!operation || operation.status !== "running" || operation.leaseToken !== leaseToken ||
      operation.leaseEpoch !== leaseEpoch) {
      throw new Error("The long-media operation lease changed before its answer was saved.");
    }
    const stepRows = await tx.select().from(mediaUnderstandingSteps).where(and(
      eq(mediaUnderstandingSteps.operationId, operationId),
      eq(mediaUnderstandingSteps.stepKey, batchKey),
      eq(mediaUnderstandingSteps.inputDigest, inputDigest),
      isNull(mediaUnderstandingSteps.deletedAt),
    )).for("update").limit(1);
    const step = stepRows[0];
    if (!step || step.activeAttemptId !== attemptId || step.status !== "running") {
      throw new Error("The long-media batch attempt lost its active result slot.");
    }
    const attemptRows = await tx.select().from(mediaUnderstandingAttempts).where(and(
      eq(mediaUnderstandingAttempts.id, attemptId),
      eq(mediaUnderstandingAttempts.stepId, step.id),
      eq(mediaUnderstandingAttempts.sendAuthorityEpoch, leaseEpoch),
      eq(mediaUnderstandingAttempts.requestState, "sending"),
      isNull(mediaUnderstandingAttempts.deletedAt),
    )).for("update").limit(1);
    if (!attemptRows[0]) throw new Error("The long-media batch attempt lost its send authority.");
    await tx.update(mediaUnderstandingAttempts).set({
      requestState: "responded",
      response: answer,
      finishReason: "stop",
    }).where(eq(mediaUnderstandingAttempts.id, attemptId));
    await tx.update(mediaUnderstandingSteps).set({
      status: "ready",
      acceptedAttemptId: attemptId,
      result: answer,
    }).where(eq(mediaUnderstandingSteps.id, step.id));
  });
}

/**
 * Mark an attempt's external outcome unknown while its lease still owns the operation.
 * @param operationId - Stable long-media operation identity.
 * @param batchKey - Ordered batch key within the operation.
 * @param inputDigest - Digest of the question, model and ordered segment inputs.
 * @param attemptId - The attempt whose response could not be durably accepted.
 * @param leaseToken - Current operation lease token.
 * @param leaseEpoch - Current operation lease epoch.
 * @returns Nothing after the unknown state is durably recorded.
 * @throws {Error} when persisted attempt facts are inconsistent.
 */
export async function markUnderstandBatchAttemptUnknown(
  operationId: string,
  batchKey: string,
  inputDigest: string,
  attemptId: string,
  leaseToken: string,
  leaseEpoch: number,
): Promise<void> {
  await db.transaction(async (tx) => {
    const operationRows = await tx.select().from(mediaUnderstandingOperations).where(and(
      eq(mediaUnderstandingOperations.id, operationId),
      isNull(mediaUnderstandingOperations.deletedAt),
    )).for("update").limit(1);
    const operation = operationRows[0];
    if (!operation) throw new Error("The media-understanding operation does not exist.");
    if (operation.leaseToken !== leaseToken || operation.leaseEpoch !== leaseEpoch) return;
    const stepRows = await tx.select().from(mediaUnderstandingSteps).where(and(
      eq(mediaUnderstandingSteps.operationId, operationId),
      eq(mediaUnderstandingSteps.stepKey, batchKey),
      eq(mediaUnderstandingSteps.inputDigest, inputDigest),
      eq(mediaUnderstandingSteps.activeAttemptId, attemptId),
      isNull(mediaUnderstandingSteps.deletedAt),
    )).for("update").limit(1);
    const step = stepRows[0];
    if (!step || step.status === "ready") return;
    const attemptRows = await tx.select().from(mediaUnderstandingAttempts).where(and(
      eq(mediaUnderstandingAttempts.id, attemptId),
      eq(mediaUnderstandingAttempts.stepId, step.id),
      eq(mediaUnderstandingAttempts.requestState, "sending"),
      isNull(mediaUnderstandingAttempts.deletedAt),
    )).for("update").limit(1);
    if (!attemptRows[0]) return;
    await tx.update(mediaUnderstandingAttempts).set({ requestState: "unknown" })
      .where(eq(mediaUnderstandingAttempts.id, attemptId));
    await tx.update(mediaUnderstandingSteps).set({ status: "failed" })
      .where(eq(mediaUnderstandingSteps.id, step.id));
    const clockRows = await tx.execute(sql`SELECT clock_timestamp() AS now`);
    if (!clockRows[0]) throw new Error("The database clock could not be read.");
    const atMs = new Date(String(clockRows[0].now)).getTime();
    const unknownEvent: UnderstandOperationEvent = atMs >= operation.deadlineAt.getTime()
      ? { type: "deadline", expectedRevision: operation.revision, atMs }
      : { type: "unknown", expectedRevision: operation.revision, atMs };
    const nextOperation = reduceUnderstandOperation({
      status: operation.status as UnderstandOperationStatus,
      revision: operation.revision,
      deadlineAtMs: operation.deadlineAt.getTime(),
    }, unknownEvent);
    const updated = await tx.update(mediaUnderstandingOperations)
      .set({ status: nextOperation.status, revision: nextOperation.revision })
      .where(and(eq(mediaUnderstandingOperations.id, operationId), eq(mediaUnderstandingOperations.revision, operation.revision)))
      .returning({ id: mediaUnderstandingOperations.id });
    if (!updated[0]) throw new Error("The operation changed while its batch outcome was being blocked.");
  });
}

/**
 * Validate one persisted batch answer before returning it to the caller.
 * @param result - Stored JSON value from a ready batch step.
 * @returns A validated immutable answer.
 * @throws {Error} when the saved long-media batch result is malformed.
 */
function parseBatchAnswer(result: Record<string, unknown> | null): BatchAnswer {
  if (!result || typeof result.text !== "string" ||
    (result.kind !== "audio" && result.kind !== "video" && result.kind !== "image") ||
    !Array.isArray(result.kinds) || result.kinds.some((kind) => kind !== "audio" && kind !== "video" && kind !== "image")) {
    throw new Error("The saved long-media batch result is malformed.");
  }
  return { text: result.text, kind: result.kind, kinds: result.kinds };
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
      const steps = await tx.select().from(mediaUnderstandingSteps).where(and(
        eq(mediaUnderstandingSteps.operationId, id),
        isNull(mediaUnderstandingSteps.deletedAt),
      )).orderBy(asc(mediaUnderstandingSteps.stepKey)).for("update");
      const activeSteps = steps.filter((step) => step.status === "running" && step.activeAttemptId !== null);
      const activeAttemptIds = activeSteps.map((step) => step.activeAttemptId!);
      const activeAttempts = activeAttemptIds.length === 0
        ? []
        : await tx.select().from(mediaUnderstandingAttempts).where(and(
          inArray(mediaUnderstandingAttempts.id, activeAttemptIds),
          isNull(mediaUnderstandingAttempts.deletedAt),
        )).orderBy(asc(mediaUnderstandingAttempts.attemptNo), asc(mediaUnderstandingAttempts.id)).for("update");
      const attemptsById = new Map(activeAttempts.map((attempt) => [attempt.id, attempt]));
      for (const step of activeSteps) {
        const attempt = attemptsById.get(step.activeAttemptId!);
        if (!attempt || attempt.stepId !== step.id) {
          throw new Error("The active long-media step has no matching attempt at operation expiry.");
        }
        if (attempt.requestState === "sending") {
          await tx.update(mediaUnderstandingAttempts).set({ requestState: "unknown" })
            .where(eq(mediaUnderstandingAttempts.id, attempt.id));
        } else if (attempt.requestState === "prepared") {
          await tx.update(mediaUnderstandingAttempts).set({ requestState: "rejected" })
            .where(eq(mediaUnderstandingAttempts.id, attempt.id));
        } else {
          throw new Error("The active long-media step has an invalid attempt state at operation expiry.");
        }
        await tx.update(mediaUnderstandingSteps).set({ status: "failed" })
          .where(eq(mediaUnderstandingSteps.id, step.id));
      }
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
