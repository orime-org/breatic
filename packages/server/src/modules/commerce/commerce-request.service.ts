// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-Breatic-Source-Available-2.0

/**
 * Running each write the billing service asks of the product once per key
 * (inner#1993 §3.3, §8.2). The write runs in the transaction that claims the
 * key, and its answer, a refusal included, is stored with the claim; the same
 * key and request replays it, a different request under the key gets 422.
 */

import { db, type DbTx } from "@breatic/core";
import * as commerceRequestRepo from "@server/modules/commerce/commerce-request.repo.js";
import type { StoredAnswer } from "@server/modules/commerce/commerce-request.repo.js";

/** Which request this is. */
export interface CommerceRequestIdentity {
  /** The idempotency key, such as `grant:<paymentId>`. */
  key: string;
  /** What kind of write it is. */
  kind: string;
  /** The request's fingerprint. */
  hash: string;
}

/** What a run decided. */
export interface CommerceRunResult extends StoredAnswer {
  status: "applied" | "refused";
}

/**
 * Answer a request once per key.
 * @param identity - The key, kind and request fingerprint.
 * @param run - Performs the write in the claiming transaction and says what to answer.
 * @returns The answer: this run's, the stored one, or 422 for a reused key.
 * @throws {Error} When the run or the database fails; nothing is stored then.
 */
export async function answerOnce(
  identity: CommerceRequestIdentity,
  run: (tx: DbTx) => Promise<CommerceRunResult>,
): Promise<StoredAnswer> {
  return db.transaction(async (tx) => {
    await commerceRequestRepo.lockKey(identity.key, tx);
    const previous = await commerceRequestRepo.findRequest(identity.key, tx);
    if (previous !== null) {
      return previous.requestHash === identity.hash
        ? previous.answer
        : { httpStatus: 422, body: { code: "idempotency_key_reused" } };
    }
    const result = await run(tx);
    const answer: StoredAnswer = { httpStatus: result.httpStatus, body: result.body };
    await commerceRequestRepo.insertRequest({ ...identity, status: result.status, answer }, tx);
    return answer;
  });
}
