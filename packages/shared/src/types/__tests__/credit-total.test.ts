// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from "vitest";
import { accountTotal } from "@shared/types/credit.js";

/**
 * Build an overview carrying the precise wire amounts.
 * @param assigned - Credits assigned to studios.
 * @param unassigned - Credits outside a live studio.
 * @param underRefund - Credits held by an in-flight refund.
 * @returns The complete account overview fixture.
 */
function overview(assigned: string, unassigned: string, underRefund: string): Parameters<typeof accountTotal>[0] {
  return {
    assignedCredits: assigned,
    unassignedCredits: unassigned,
    underRefundCredits: underRefund,
    billing: true,
    studios: [],
  } as unknown as Parameters<typeof accountTotal>[0];
}

describe("exact account total (inner#1411)", () => {
  it("adds two large credit lots without concatenating their decimal strings", () => {
    expect(accountTotal(overview("9007199254.740000", "9007199254.730000", "0.000000")))
      .toBe("18014398509.470000");
  });

  it("counts the credits held by an in-flight refund", () => {
    expect(accountTotal(overview("20.000000", "30.000000", "50.000000"))).toBe("100.000000");
  });

  it("returns canonical zero from three empty balances", () => {
    expect(accountTotal(overview("0.000000", "0.000000", "0.000000"))).toBe("0.000000");
  });

  it("retains one micro-credit in a sum above a single stored row", () => {
    expect(accountTotal(overview("99999999999999.999999", "99999999999999.999999", "0.000001")))
      .toBe("199999999999999.999999");
  });
});
