// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from "vitest";
import { trackedMaskErrorSchema, trackedMaskRetryable } from "../tracked-mask-failure.js";

// Execution design §10.3: a failed tracking analysis stores {code, step}; the panel and analysis admission share one
// rule for whether pressing Retry starts a new tracking run.
describe("tracked mask failure (execution design §10.3)", () => {
  it.each([
    ["empty_foreground", false],
    ["tracking_output_mismatch", true],
    ["model_rejected", false],
    ["timeout", true],
    ["failed", true],
  ] as const)("TF01 %s retryable is %s", (code, retryable) => {
    expect(trackedMaskRetryable(code)).toBe(retryable);
  });

  it("TF02 the stored error names a known code and one of the three steps", () => {
    expect(trackedMaskErrorSchema.parse({ code: "timeout", step: "track" })).toEqual({ code: "timeout", step: "track" });
    for (const step of ["prepare", "track", "join"]) expect(trackedMaskErrorSchema.safeParse({ code: "failed", step }).success).toBe(true);
    expect(trackedMaskErrorSchema.safeParse({ code: "no_face", step: "track" }).success).toBe(false);
    expect(trackedMaskErrorSchema.safeParse({ code: "failed", step: "generate" }).success).toBe(false);
    expect(trackedMaskErrorSchema.safeParse({ code: "failed" }).success).toBe(false);
  });
});
