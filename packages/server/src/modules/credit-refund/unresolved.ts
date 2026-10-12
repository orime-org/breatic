// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The one definition of an unresolved failed refund (inner#1410 §5.3).
 *
 * The preview, the judgement table, both endpoints that answer for such a
 * refund, and the back office list all ask this function, so a refund cannot
 * be listed by one and refused by another.
 */

import type { CreditLotLifecycle } from "@breatic/shared";
import type { RefundCopy } from "@server/modules/credit-refund/types.js";

/**
 * The refunds that succeeded, then failed after the lot was booked as
 * refunded, and that no disposition has answered for yet.
 * @param lifecycle - The lot's lifecycle; only a refunded lot has any.
 * @param refunds - The payment's refund copies.
 * @returns The matching copies, in input order.
 */
export function pickUnresolvedFailedRefunds(
  lifecycle: CreditLotLifecycle,
  refunds: readonly RefundCopy[],
): RefundCopy[] {
  if (lifecycle !== "refunded") return [];
  return refunds.filter(
    (r) =>
      r.everSucceeded &&
      (r.status === "failed" || r.status === "canceled") &&
      r.resolvedByOperationId === null,
  );
}
