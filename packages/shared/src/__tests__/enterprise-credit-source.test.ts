// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-Breatic-Source-Available-2.0

import { describe, expect, it } from "vitest";
import { CREDIT_SOURCE_KINDS, GRANTED_SOURCE_KINDS, isPurchased } from "@shared/types/credit.js";
import { refundRefusal } from "@shared/refund-eligibility.js";

describe("enterprise credit source rights", () => {
  it("includes corporate purchases in purchased funds and excludes them from grants", () => {
    expect(CREDIT_SOURCE_KINDS).toContain("enterprise");
    expect(isPurchased("enterprise")).toBe(true);
    expect(GRANTED_SOURCE_KINDS).toEqual(["compensation", "gift", "discount"]);
  });

  it("keeps corporate purchases on the offline financial channel", () => {
    const candidate = { sourceKind: "enterprise" as const, purchased: true, lifecycle: "active" as const, designated: false, everSpent: false, everRestored: false, refundAttempts: 0, createdAt: "2026-11-19T00:00:00.000Z" };
    expect(refundRefusal(candidate, new Date("2026-11-19T00:00:00.000Z"))).toBe("offline_contract");
  });
});
