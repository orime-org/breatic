// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { createHash } from "node:crypto";
import {
  claimUnderstandOperationLease,
  applyUnderstandOperationEvent,
  beginUnderstandBatchAttempt,
  getUnderstandOperation,
  markUnderstandBatchAttemptUnknown,
  markUnderstandBatchAttemptSending,
  openUnderstandOperation,
  renewUnderstandOperationLease,
  releaseUnderstandOperationLease,
  saveUnderstandBatchAttemptResult,
} from "@domain/understand/operation.repo.js";
import type { OpenUnderstandOperationInput } from "@domain/understand/operation.repo.js";
import type { LongMediaBatchCheckpoint } from "@domain/understand/understand-segment-batches.js";
import type { LongMediaSourceReference } from "@breatic/shared";

/** Stable origin facts used to resume completed long-media model batches. */
export interface LongMediaBatchOperationInput {
  actorUserId: string;
  projectId?: string;
  originKind: "agent_turn" | "canvas_task";
  originKey: string;
  userActionKey: string;
  source: LongMediaSourceReference;
  question: string;
  model: string;
  deadlineAt: Date;
}

/** Opened operation, its fenced lease and durable batch checkpoint interface. */
export interface LongMediaBatchOperation {
  operationId: string;
  checkpoint: LongMediaBatchCheckpoint;
  signal: AbortSignal;
  complete(): Promise<void>;
  release(): Promise<void>;
}

/**
 * Open or recover a stable long-media operation and claim its execution lease.
 * @param input - Trusted origin identity and immutable media request facts.
 * @param leaseDurationMs - Configured lease duration.
 * @returns The operation identity, checkpoint adapter and lease release function.
 * @throws {Error} When another executor owns the lease or saved inputs conflict.
 * @throws {RangeError} When the configured lease duration is invalid.
 */
export async function openLongMediaBatchOperation(
  input: LongMediaBatchOperationInput,
  leaseDurationMs: number,
): Promise<LongMediaBatchOperation> {
  const identity = `${input.originKind}:${input.originKey}:${input.userActionKey}`;
  const request: OpenUnderstandOperationInput = {
    actorUserId: input.actorUserId,
    projectId: input.projectId,
    originKind: input.originKind,
    originKey: input.originKey,
    requestDigest: digest({
      source: input.source,
      question: input.question,
      model: input.model,
    }),
    sources: [{
      storageKey: input.source.key,
      sha256: input.source.sha256,
      sizeBytes: input.source.sizeBytes,
      mimeType: input.source.mimeType,
    }],
    question: input.question,
    mode: "understand",
    locale: "und",
    model: input.model,
    promptVersion: "long-media-batch-v1",
    deadlineAt: input.deadlineAt,
    recoveryGroupId: stableUuid(`${identity}:recovery`),
    logicalRequestId: stableUuid(`${identity}:logical`),
    userActionId: stableUuid(`${identity}:action`),
    id: longMediaOperationId(input.originKind, input.originKey, input.userActionKey),
    dispatchState: "retired",
  };
  const operation = await openUnderstandOperation(request);
  const controller = new AbortController();
  const replayingCompleted = operation.status === "ready";
  const lease = replayingCompleted ? null : await claimUnderstandOperationLease(operation.id, leaseDurationMs);
  if (lease !== null && lease.kind !== "claimed" && lease.kind !== "blocked") {
    throw new Error(`The long-media operation lease is ${lease.kind}.`);
  }
  const leaseOwner = lease?.kind === "claimed" ? lease : null;
  let claimed = leaseOwner;
  let heartbeat: NodeJS.Timeout | undefined;
  let renewal = Promise.resolve();
  let leaseFailure: unknown;
  if (leaseOwner) {
    heartbeat = setInterval(() => {
      renewal = renewal.then(async () => {
        const nextLease = await renewUnderstandOperationLease(
          operation.id,
          leaseOwner.token,
          leaseOwner.epoch,
          leaseDurationMs,
        );
        if (nextLease.kind !== "applied") throw new Error("The long-media operation lease could not be renewed.");
      }).catch((err: unknown) => {
        leaseFailure = err;
        controller.abort(err);
      });
    }, Math.max(1, Math.floor(leaseDurationMs / 3)));
    heartbeat.unref();
  }
  const checkpoint: LongMediaBatchCheckpoint = {
    begin: async (batchKey, inputDigest) => beginUnderstandBatchAttempt(
      operation.id,
      batchKey,
      inputDigest,
      leaseOwner?.token ?? null,
      leaseOwner?.epoch ?? operation.leaseEpoch,
    ),
    markSending: async (batchKey, inputDigest, attemptId) => {
      if (!leaseOwner) throw new Error("A read-only long-media operation cannot request model send authority.");
      await markUnderstandBatchAttemptSending(
        operation.id,
        batchKey,
        inputDigest,
        attemptId,
        leaseOwner.token,
        leaseOwner.epoch,
      );
    },
    saveAttempt: async (batchKey, inputDigest, attemptId, answer) => {
      if (!leaseOwner) throw new Error("A read-only long-media operation cannot save a model response.");
      await saveUnderstandBatchAttemptResult(
        operation.id,
        batchKey,
        inputDigest,
        attemptId,
        leaseOwner.token,
        leaseOwner.epoch,
        answer,
      );
    },
    markUnknown: async (batchKey, inputDigest, attemptId) => {
      if (!leaseOwner) return;
      await markUnderstandBatchAttemptUnknown(
        operation.id,
        batchKey,
        inputDigest,
        attemptId,
        leaseOwner.token,
        leaseOwner.epoch,
      );
    },
  };
  return {
    operationId: operation.id,
    checkpoint,
    signal: controller.signal,
    complete: async () => {
      const activeLease = claimed;
      if (!activeLease) return;
      if (heartbeat) {
        clearInterval(heartbeat);
        heartbeat = undefined;
      }
      await renewal;
      if (leaseFailure !== undefined) throw leaseFailure;
      const current = await getUnderstandOperation(operation.id);
      if (!current || current.leaseToken !== activeLease.token || current.leaseEpoch !== activeLease.epoch) {
        throw new Error("The long-media operation lease changed before completion.");
      }
      await applyUnderstandOperationEvent(operation.id, {
        type: "finish",
        expectedRevision: current.revision,
        completeCoverage: true,
        atMs: Date.now(),
      });
      claimed = null;
    },
    release: async () => {
      if (!claimed) return;
      if (heartbeat) clearInterval(heartbeat);
      await renewal;
      const released = await releaseUnderstandOperationLease(operation.id, claimed.token, claimed.epoch);
      if (released.kind === "stale") throw new Error("The long-media operation lease became stale before release.");
      if (leaseFailure !== undefined) throw leaseFailure;
    },
  };
}

/**
 * Derive the stable database and segmentation identity for one user action.
 * @param originKind - The trusted Agent or canvas origin.
 * @param originKey - The existing turn or task identity.
 * @param userActionKey - The stable tool-call or task action identity.
 * @returns A deterministic UUID shared by segmentation and result checkpoints.
 */
export function longMediaOperationId(
  originKind: LongMediaBatchOperationInput["originKind"],
  originKey: string,
  userActionKey: string,
): string {
  return stableUuid(`${originKind}:${originKey}:${userActionKey}:operation`);
}

/**
 * Hash stable JSON facts for operation and batch identity.
 * @param value - The immutable input facts.
 * @returns A lowercase SHA-256 digest.
 */
export function longMediaInputDigest(value: unknown): string {
  return digest(value);
}

/**
 * Derive a UUID-shaped stable identifier within the long-media namespace.
 * @param value - The stable identity string.
 * @returns A deterministic UUID.
 */
function stableUuid(value: string): string {
  const bytes = createHash("sha256").update(`breatic-long-media:${value}`).digest().subarray(0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x50;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/**
 * Serialize identity facts and hash them with SHA-256.
 * @param value - The identity facts.
 * @returns A lowercase SHA-256 digest.
 */
function digest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}
