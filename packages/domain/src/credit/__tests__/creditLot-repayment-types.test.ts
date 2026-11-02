// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from "vitest";
import { parseCreditDecimal } from "@breatic/shared";
import { toMicroCredits } from "@domain/credit/credit-math.js";
import type { repayDesignatedLot } from "@domain/credit/creditLot.service.js";

type OwedMicro = Parameters<typeof repayDesignatedLot>[0]["owedMicro"];

describe("repayDesignatedLot owedMicro unit (inner#1411 Q01)", () => {
  it("accepts micro-credits from both existing conversion helpers", () => {
    const parsedDebt: OwedMicro = parseCreditDecimal("0.000001");
    const convertedDebt: OwedMicro = toMicroCredits("0.000001");

    expect([parsedDebt, convertedDebt]).toEqual([1n, 1n]);
  });

  it("rejects a bare bigint without the micro-credit unit", () => {
    // @ts-expect-error -- repayment debt must preserve its micro-credit unit.
    const owedMicro: OwedMicro = 1n;

    expect(owedMicro).toBe(1n);
  });
});
