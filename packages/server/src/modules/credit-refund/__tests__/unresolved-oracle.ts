// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The test oracle for an unresolved failed refund, shared by the judge
 * suites (`assess.test.ts`, `assess-one-shot.test.ts`). Not a test file.
 */

import type { CreditLotLifecycle } from "@breatic/shared";
import type { RefundCopy } from "@server/modules/credit-refund/types.js";

/**
 * The view's definition of an unresolved failed refund (§5.3), as the
 * suites' oracle.
 * @param lifecycle - The lot's state.
 * @param refunds - The payment's refund copies.
 * @returns The unresolved ones.
 */
export function unresolvedOf(lifecycle: CreditLotLifecycle, refunds: readonly RefundCopy[]): RefundCopy[] {
  if (lifecycle !== "refunded" && lifecycle !== "refunding" && lifecycle !== "refund_pending") return [];
  return refunds.filter(
    (r) =>
      (r.status === "failed" || r.status === "canceled") &&
      r.resolvedByOperationId === null &&
      (lifecycle !== "refunded" || r.everSucceeded),
  );
}
