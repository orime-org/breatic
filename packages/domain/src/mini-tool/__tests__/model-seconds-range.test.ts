// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * inner#1306 execution design §11.5: the seconds a vendor takes per call are written once, as provider rejects with a
 * `seconds` limit; `modelSecondsRange` hands them to the panel limits, admission and the product guide.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { modelSecondsRange } from "@domain/mini-tool/model-call-admission.js";
import { restoreProcessEnv, useFullCatalog } from "@domain/model-catalog/__tests__/catalog-env.js";

beforeAll(() => { useFullCatalog(); });
afterAll(() => { restoreProcessEnv(); });

describe("a model's seconds per call", () => {
  it("reads the eraser's 1–5 s from its rejects", () => {
    expect(modelSecondsRange("bria-video-eraser-mask")).toEqual({ minSeconds: 1, maxSeconds: 5 });
  });

  it("reads a ceiling alone as a range from zero", () => {
    expect(modelSecondsRange("sam3-video-rle")).toEqual({ minSeconds: 0, maxSeconds: 600 });
    expect(modelSecondsRange("bria-fibo-video-background-remover")).toEqual({ minSeconds: 0, maxSeconds: 60 });
  });

  it("states no ceiling for a model whose rejects state none", () => {
    expect(modelSecondsRange("wan-2.1-14b-vace").maxSeconds).toBeNull();
  });
});
