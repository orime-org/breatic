// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from "vitest";
import * as miniTools from "../index.js";
import { plannedFailureRetryable } from "../execution-record.js";
import { MINI_TOOL_RETRY_TOOLS, miniToolExecutionRetryRequestSchema } from "../planned-request-schema.js";

// frames-split §7.15 end of retryability: a frames or split output's failure is retryable, and the retry request takes
// exactly the tools that have a retry.
describe("planned output retry", () => {
  it.each([
    ["a frames output failing", "video.extract-frames", true],
    ["a split output failing", "video.split", true],
    ["a focus crop failing", "video.focus-crop", false],
  ] as const)("plannedFailureRetryable: %s is retryable: %s", (_name, tool, retryable) => {
    expect(plannedFailureRetryable(tool)).toBe(retryable);
  });

  it("the retry request takes exactly the tools that have a retry", () => {
    expect(miniToolExecutionRetryRequestSchema.shape.tool.options).toEqual([...MINI_TOOL_RETRY_TOOLS]);
  });

  it.each([
    ["a failed split output", { result: { status: "failed", error: { code: "mini_tool_failed" } } }, true],
    ["a failed output a retry took over", { result: { status: "failed", error: { code: "mini_tool_failed" } }, takenOver: true }, false],
    ["an output still running", { result: null }, false],
    ["a registered output", { result: { status: "registered" } }, false],
  ] as const)("plannedOutputRetryable from the mini-tools entry: %s is retryable: %s", (_name, output, retryable) => {
    const api = miniTools as unknown as { plannedOutputRetryable: (tool: string, output: unknown) => boolean };
    expect(api.plannedOutputRetryable("video.split", output)).toBe(retryable);
  });
});
