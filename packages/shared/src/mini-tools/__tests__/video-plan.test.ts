// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import fc from "fast-check";
import { describe, expect, it } from "vitest";
import * as miniTools from "@shared/mini-tools/index.js";

interface PlanApi {
  chunkVideoOutputs: <T>(outputs: readonly T[], chunkSize: number) => T[][];
}
const api = miniTools as unknown as PlanApi;
describe("complete video tool execution plans", () => {
  it("exports every shared plan entry point", () => {
    expect(["planVideoFrames", "planVideoSplit", "chunkVideoOutputs"].filter((key) => !(key in miniTools))).toEqual([]);
  });

  describe("bounded container chunks", () => {
    it("keeps all seventeen output identities and recipes across eight-output jobs", () => {
      const outputs = Array.from({ length: 17 }, (_, outputIndex) => ({ outputIndex, recipe: { kind: "split", start: outputIndex, end: outputIndex + 1 } }));
      const chunks = api.chunkVideoOutputs(outputs, 8);
      expect(chunks.map((chunk) => chunk.length)).toEqual([8, 8, 1]);
      expect(chunks.flat()).toEqual(outputs);
      expect(chunks[2]).toEqual([outputs[16]]);
    });

    it("preserves arbitrary complete output sequences without mutation", () => {
      fc.assert(fc.property(fc.array(fc.integer()), fc.integer({ min: 1, max: 16 }), (outputs, cap) => {
        const before = [...outputs];
        const chunks = api.chunkVideoOutputs(outputs, cap);
        expect(chunks.flat()).toEqual(before);
        expect(outputs).toEqual(before);
        expect(chunks.map((chunk) => chunk.length)).toEqual(Array.from({ length: Math.ceil(outputs.length / cap) }, (_, index) => Math.min(cap, outputs.length - index * cap)));
      }));
    });

    it.each([0, -1, 0.5, Number.NaN, Number.POSITIVE_INFINITY])("rejects an invalid per-job capacity %s", (cap) => {
      expect(() => api.chunkVideoOutputs([1, 2], cap)).toThrow();
    });
  });
});
