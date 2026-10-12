// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The one definition of an unresolved failed refund (inner#1410 §5.3).
 *
 * The preview, the judgement table, both endpoints that answer for such a
 * refund, and the back office list all ask this function, so a refund cannot
 * be listed by one and refused by another. The daily reconcile selects the
 * same refunds in SQL (`reconcile.repo.ts`); a change here changes it too.
 */

import type { CreditLotLifecycle } from "@breatic/shared";
import type { RefundCopy } from "@server/modules/credit-refund/types.js";

/**
 * The payment's failed or canceled refunds no disposition has answered for.
 * On a refunded lot only the ones that had succeeded count: booking answers
 * for whatever had failed by then (§5.5), so these failed after it. A lot not
 * yet booked counts every one; any other lot has none.
 * @param lifecycle - The lot's lifecycle.
 * @param refunds - The payment's refund copies.
 * @returns The matching copies, in input order.
 */
export function pickUnresolvedFailedRefunds(
  lifecycle: CreditLotLifecycle,
  refunds: readonly RefundCopy[],
): RefundCopy[] {
  if (lifecycle !== "refunded" && lifecycle !== "refunding" && lifecycle !== "refund_pending") return [];
  return refunds.filter(
    (r) =>
      (r.status === "failed" || r.status === "canceled") &&
      r.resolvedByOperationId === null &&
      (lifecycle !== "refunded" || r.everSucceeded),
  );
}
