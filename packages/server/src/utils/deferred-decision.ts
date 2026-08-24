// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Refusing a deferred decision without losing what the refusal wrote.
 *
 * The three deferred-request flows (role upgrade, project transfer, studio
 * transfer) all have failure paths that WRITE before they refuse: a request
 * that timed out, or whose premise is gone, is pushed to a terminal status and
 * has its bell entry retired, and only then does the caller hear 409. Nothing
 * else will ever do that write — "expired" is by definition the case where
 * nobody came — so losing it strands the row `pending` forever, holding a
 * uniqueness slot that for a transfer is the entire container.
 *
 * Throwing an error inside `db.transaction` aborts the transaction, which
 * discards exactly that write. The refusal still reaches the client, so the
 * bug is invisible from the outside and invisible to any test with a mocked
 * transaction: the service calls the settle, the mock records it, and the real
 * database never sees it.
 *
 * So a decision transaction does not throw for a business refusal — it RETURNS
 * one, and the caller raises it after the commit. Refusals that write nothing
 * (a caller who lacks standing) travel the same way, because a rule with an
 * exception is a rule nobody applies.
 */

import { ConflictError, ForbiddenError, NotFoundError } from "@breatic/core";
import { t } from "@breatic/shared";

/** Why a decision was refused, carried out of the transaction as a value. */
export type Refusal = "not_found" | "forbidden" | "conflict";

/** A refusal on its way out of a decision transaction. */
export interface Refused {
  refusal: Refusal;
}

/**
 * Turn a refusal carried out of a committed transaction into the error the
 * route layer maps to a status code.
 * @param refusal - Why the decision was refused.
 * @returns The error to throw, now that the transaction has committed.
 */
export function refusalError(refusal: Refusal): Error {
  switch (refusal) {
    case "not_found":
      return new NotFoundError(t("server.error.not_found"));
    case "forbidden":
      return new ForbiddenError(t("server.error.forbidden"));
    case "conflict":
      return new ConflictError(t("server.error.conflict"));
  }
}

/**
 * Narrow a decision transaction's result to the refusal case.
 * @param result - Whatever the transaction returned.
 * @returns True when the decision was refused.
 */
export function isRefused<T extends object>(
  result: T | Refused,
): result is Refused {
  return "refusal" in result;
}
