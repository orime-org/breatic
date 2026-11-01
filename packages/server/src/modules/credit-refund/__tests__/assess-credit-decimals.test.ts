// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { describe, expect, it } from "vitest";
import { assessRefundCreate } from "@server/modules/credit-refund/assess.js";
import type { AssessInput, AssessResult } from "@server/modules/credit-refund/assess.js";

type DecimalInput = Omit<AssessInput, "lot"> & {
  lot: { lifecycle: "refund_pending"; remainingCredits: string; ledgerSum: string };
};

/** Exercise the stored-credit boundary while retaining the original cash-unit judgement. */
function assess(remainingCredits: string, ledgerSum: string): AssessResult {
  const input: DecimalInput = { kind: "approve", lot: { lifecycle: "refund_pending", remainingCredits, ledgerSum },
    payment: { status: "completed", stripePaymentIntentId: "pi_decimal_assessment", paidCents: 1000 },
    ops: [], refunds: [], confirmedRefundIds: [] };
  return (assessRefundCreate as unknown as (value: DecimalInput) => AssessResult)(input);
}

describe("refund assessment with exact stored amounts", () => {
  it.each(["100.000000", "9007199254.740000"])("P25 preserves the cash amount for matching remaining and ledger %s", (credits) => {
    expect(assess(credits, credits)).toEqual({ outcome: "create_refund", amountCents: 1000 });
  });

  it.each([
    ["100.000000", "99.999999"], ["9007199254.740000", "9007199254.740001"],
    ["99999999999999.990000", "99999999999999.990001"],
  ])("P25 rejects an exact remaining-ledger difference between %s and %s", (remaining, ledger) => {
    expect(assess(remaining, ledger)).toEqual({ outcome: "blocked", code: "lot_state_changed" });
  });
});
