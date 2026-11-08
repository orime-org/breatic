// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

import { describe, expect, it } from "vitest";
import { eraseFailureReasonSchema, expandFailureReasonSchema, modelFailureRetryable, plannedFailureRetryable } from "../model-failure-reason.js";

// Execution design §10.4 and §10.5 failure paragraphs: an erase fails at one step with one category; an expand lists every
// window that did not succeed and the step outside every window.
describe("erase and expand failure reasons (execution design §10.4, §10.5)", () => {
  it("FR01 an erase reason names one of its steps and a category of its table", () => {
    for (const step of ["prepare", "mask", "generate", "composite", "stitch", "expired"]) {
      expect(eraseFailureReasonSchema.safeParse({ kind: "erase", step, category: "failed" }).success).toBe(true);
    }
    for (const category of ["model_rejected", "model_output_mismatch", "timeout", "failed"]) {
      expect(eraseFailureReasonSchema.safeParse({ kind: "erase", step: "generate", category }).success).toBe(true);
    }
    expect(eraseFailureReasonSchema.safeParse({ kind: "erase", step: "window", category: "failed" }).success).toBe(false);
    expect(eraseFailureReasonSchema.safeParse({ kind: "erase", step: "generate", category: "stopped" }).success).toBe(false);
  });

  it("FR02 an expand reason lists windows by index and step, with stopped, and the shared step", () => {
    const reason = { kind: "expand", windows: [{ windowIndex: 3, step: "generate", category: "timeout" }, { windowIndex: 4, step: "generate", category: "stopped" }], shared: null };
    expect(expandFailureReasonSchema.parse(reason)).toEqual(reason);
    for (const step of ["window", "window_mask", "condition", "generate"]) {
      expect(expandFailureReasonSchema.safeParse({ ...reason, windows: [{ windowIndex: 0, step, category: "failed" }] }).success).toBe(true);
    }
    for (const step of ["composite", "stitch", "expired"]) expect(expandFailureReasonSchema.safeParse({ kind: "expand", windows: [], shared: { step, category: "timeout" } }).success).toBe(true);
    expect(expandFailureReasonSchema.safeParse({ ...reason, windows: [{ windowIndex: 0, step: "generate", category: "model_output_mismatch" }] }).success).toBe(false);
    expect(expandFailureReasonSchema.safeParse({ ...reason, windows: [{ windowIndex: -1, step: "generate", category: "failed" }] }).success).toBe(false);
  });

  it.each([
    ["an erase timing out", { kind: "erase", step: "generate", category: "timeout" }, true],
    ["an erase the model rejected", { kind: "erase", step: "generate", category: "model_rejected" }, false],
    ["an erase whose result frame count did not match", { kind: "erase", step: "composite", category: "model_output_mismatch" }, false],
    ["an expand whose window 3 timed out and the rest stopped", { kind: "expand", windows: [{ windowIndex: 3, step: "generate", category: "timeout" }, { windowIndex: 4, step: "generate", category: "stopped" }], shared: null }, true],
    ["an expand window the model rejected", { kind: "expand", windows: [{ windowIndex: 3, step: "generate", category: "model_rejected" }], shared: null }, false],
    ["an expand expiring", { kind: "expand", windows: [], shared: { step: "expired", category: "timeout" } }, true],
  ] as const)("FR03 %s is retryable: %s", (_name, reason, retryable) => {
    expect(modelFailureRetryable(reason)).toBe(retryable);
  });

  // The one decision the terminal commit's pin release, retry admission and the node share (§10.5 last paragraph): each
  // planned model run's reason by its own rule, any other failure (a frames or split output) retryable.
  it.each([
    ["an erase the model rejected", { kind: "erase", step: "generate", category: "model_rejected" }, false],
    ["an erase timing out", { kind: "erase", step: "expired", category: "timeout" }, true],
    ["an expand window the model rejected", { kind: "expand", windows: [{ windowIndex: 0, step: "generate", category: "model_rejected" }], shared: null }, false],
    ["an expand expiring", { kind: "expand", windows: [], shared: { step: "expired", category: "timeout" } }, true],
    ["a lip-sync person without a face", { kind: "lipsync", persons: [{ personId: "p", detectionNumber: 1, step: "faces", category: "no_face" }], shared: null }, false],
    ["a lip-sync stitch failing", { kind: "lipsync", persons: [], shared: { step: "stitch", category: "failed" } }, true],
    ["a frames output failing", { code: "mini_tool_failed" }, true],
  ] as const)("FR04 plannedFailureRetryable: %s is retryable: %s", (_name, reason, retryable) => {
    expect(plannedFailureRetryable(reason)).toBe(retryable);
  });
});
