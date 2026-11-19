// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * An analysis freezes who pays at admission (inner#1306 test plan §67.2 A03; frames-split design §5.5 「配置」行, §10.12
 * analysis.service.ts row): `miniToolFrozenAnalysisSchema` carries `chargeTo`, `platform` or `user`, and nothing else;
 * the public analysis record (`analysis-record.ts`) does not gain it.
 */
import { describe, expect, it } from "vitest";
import { miniToolAnalysisRecordSchema } from "@breatic/shared/mini-tools";
import { miniToolFrozenAnalysisSchema } from "../analysis.service.js";

describe("the frozen analysis payer (§67.2 A03)", () => {
  it("A03: miniToolFrozenAnalysisSchema has a required chargeTo of platform or user", () => {
    const shape = miniToolFrozenAnalysisSchema.shape as Record<string, { safeParse: (value: unknown) => { success: boolean } } | undefined>;
    expect(Object.keys(shape)).toContain("chargeTo");
    const chargeTo = shape.chargeTo!;
    expect(["platform", "user"].map((value) => chargeTo.safeParse(value).success)).toEqual([true, true]);
    expect([undefined, "studio", ""].map((value) => chargeTo.safeParse(value).success)).toEqual([false, false, false]);
  });

  it("A03: the public analysis record does not carry the payer", () => {
    expect(Object.keys(miniToolAnalysisRecordSchema.shape)).not.toContain("chargeTo");
  });
});
