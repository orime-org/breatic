// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from "vitest";
import { modelRunRetryable } from "../model-run-retryable.js";

const items = (categories: string[]): { category: string }[] => categories.map((category) => ({ category }));

// Execution design §10.5 last paragraph: stopped items are ignored, and the run is retryable when every other item
// and the shared one is a timeout (expiry included, as §9.4) or failed.
describe("modelRunRetryable (execution design §10.5)", () => {
  it("RR01 an expand whose window 3 timed out and windows 4–19 were stopped is retryable", () => {
    expect(modelRunRetryable({ items: items(["timeout", ...Array<string>(16).fill("stopped")]), shared: null })).toBe(true);
  });

  it("RR02 an expand whose window 3 was rejected by the model is not retryable", () => {
    expect(modelRunRetryable({ items: items(["model_rejected", ...Array<string>(16).fill("stopped")]), shared: null })).toBe(false);
  });

  it("RR03 a lip-sync with one no_face person and the others stopped is not retryable", () => {
    expect(modelRunRetryable({ items: items(["no_face", "stopped", "stopped"]), shared: null })).toBe(false);
  });

  it("RR04 a whole-run expiry is retryable", () => {
    expect(modelRunRetryable({ items: [], shared: { category: "timeout" } })).toBe(true);
  });

  it("RR05 an erase whose result frame count did not match is not retryable", () => {
    expect(modelRunRetryable({ items: items(["model_output_mismatch"]), shared: null })).toBe(false);
  });

  it("RR06 failed and timeout items mixed are retryable; nothing failed is not", () => {
    expect(modelRunRetryable({ items: items(["failed", "timeout"]), shared: { category: "failed" } })).toBe(true);
    expect(modelRunRetryable({ items: [], shared: null })).toBe(false);
  });
});
