// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * Admitting an operation from a route (inner#1968, design 3.3): the domain
 * answer turned into the refusals a user reads.
 */

import { AppError, getOperationsConfig, logger } from "@breatic/core";
import type { DbTx } from "@breatic/core";
import { operationService } from "@breatic/domain";
import { formatCredits, getActiveLocale, t } from "@breatic/shared";

/** A refusal the web client tells apart by `error.reason`. */
export class ReasonedError extends AppError {
  /**
   * Build the refusal.
   * @param statusCode - Its HTTP status.
   * @param message - The sentence, already translated.
   * @param reason - What the client branches on.
   */
  constructor(statusCode: number, message: string, readonly reason: string) {
    super(statusCode, message);
  }
}

/** The month's operations are used up and the studio cannot pay for one more. */
export class OperationsExhaustedError extends ReasonedError {
  /** Build the refusal, naming the overage price. */
  constructor() {
    super(402, t("server.operation.exhausted", { credits: formatCredits(getOperationsConfig().overage_credits, getActiveLocale()) }), "operations_exhausted");
  }
}

/** The operation key already has a row: this operation ran before. */
export class OperationKeyTakenError extends ReasonedError {
  /** Build the refusal. */
  constructor() {
    super(409, t("server.operation.key_taken"), "operation_key_taken");
  }
}

/**
 * Admit an operation or refuse it the way a route answers.
 * @param input - The operation.
 * @param tx - The entry's transaction, when the admission is its first statement.
 * @returns The admission: not metered, covered or held.
 * @throws {OperationsExhaustedError} 402 when the studio cannot hold the overage price.
 * @throws {OperationKeyTakenError} 409 when the key already has a row.
 */
export async function admitOperationOrRefuse(
  input: operationService.AdmitInput,
  tx?: DbTx,
): Promise<Exclude<operationService.AdmitOutcome, { kind: "refused" | "taken" }>> {
  const outcome = await operationService.admitOperation(input, tx);
  if (outcome.kind === "refused") throw new OperationsExhaustedError();
  if (outcome.kind === "taken") refuseTakenKey(input.actorUserId, input.projectId ?? null, input.key);
  return outcome;
}

/**
 * Log and refuse a key that already ran.
 * @param userId - Who sent it.
 * @param projectId - Where, when in a project.
 * @param key - The key.
 * @throws {OperationKeyTakenError} Always.
 */
function refuseTakenKey(userId: string, projectId: string | null, key: string): never {
  logger.warn({ userId, projectId, key }, "operation_key_taken");
  throw new OperationKeyTakenError();
}

/**
 * Refuse an operation key that already has a row before any work for it
 * starts: an upload with such a key is neither deduplicated nor granted.
 * @param key - The key.
 * @param userId - Who sent it.
 * @param projectId - Where, when in a project.
 * @throws {OperationKeyTakenError} 409 when the key has a row.
 */
export async function assertOperationKeyFree(key: string, userId: string, projectId: string | null): Promise<void> {
  if ((await operationService.operationStatus(key)) !== null) refuseTakenKey(userId, projectId, key);
}
