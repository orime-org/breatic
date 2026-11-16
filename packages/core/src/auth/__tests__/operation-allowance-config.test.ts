// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * A changed monthly allowance in `config/membership.yaml` is used by the next
 * decision (inner#1968, test spec C-24).
 *
 * The spec places C-24 at domain integration with the config reloaded in the
 * same process. The membership config has no reload entry, so this pins the
 * part that decides it: the allowance is read from the tier config on every
 * call, never captured once. The config module is mocked so that the second
 * read returns pro with `monthly_operations: 10`.
 */

import { describe, expect, it, vi } from "vitest";
import type * as MembershipConfig from "../../config/membership.js";

const override = vi.hoisted(() => ({ proMonthly: null as number | null }));

vi.mock("../../config/membership.js", async (importOriginal) => {
  const original = await importOriginal<typeof MembershipConfig>();
  return {
    ...original,
    getMembershipLimits: (tier: Parameters<typeof original.getMembershipLimits>[0]) => {
      const limits = original.getMembershipLimits(tier);
      return tier === "pro" && override.proMonthly !== null ? { ...limits, monthly_operations: override.proMonthly } : limits;
    },
  };
});

import { resolveMembershipReading, operationAllowanceOf } from "../membership-reading.js";

/**
 * The monthly allowance of a manually assigned pro account, read now.
 * @returns The allowance's monthly number.
 */
function proMonthly(): number {
  const clock = { now: new Date("2026-11-15T12:00:00.000Z"), staleAfterMs: 0 };
  const reading = resolveMembershipReading("pro", null, [], clock);
  return operationAllowanceOf(reading, {
    userCreatedAt: new Date("2026-05-03T07:00:00.000Z"),
    enterprise: null,
    subscriptions: [],
    clock,
    paymentEnabled: true,
  }).monthly;
}

describe("operationAllowanceOf and the tier config", () => {
  it("C-24 uses pro.monthly_operations as configured at the moment of each decision", () => {
    expect(proMonthly()).toBe(4000);
    override.proMonthly = 10;
    expect(proMonthly()).toBe(10);
  });
});
