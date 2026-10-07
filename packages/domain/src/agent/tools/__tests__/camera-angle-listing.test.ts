// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The agent learns from the model listing what each camera-angle value of
 * Qwen Image Multiple Angles means, so a proposal for "the right side" lands on
 * the subject's right rather than on the viewer's.
 */

import { afterAll, beforeEach, describe, expect, it } from "vitest";

import {
  generationModels,
  renderGenerationModelsForModel,
  type PricedModelsForMode,
} from "@domain/agent/tools/generation-models.js";
import {
  allProviderKeyNames,
  restoreProcessEnv,
  useEnvWithKeys,
} from "@domain/model-catalog/__tests__/catalog-env.js";

beforeEach(() => {
  restoreProcessEnv();
  useEnvWithKeys(allProviderKeyNames());
});

afterAll(() => {
  restoreProcessEnv();
});

/**
 * The listing of Qwen Image Multiple Angles in the image-to-image mode: its
 * line and the parameter lines under it.
 * @returns The block, or the empty string when it is not listed.
 */
async function qwenBlock(): Promise<string> {
  const execute = (generationModels as unknown as {
    execute: (i: unknown, o: object) => Promise<PricedModelsForMode>;
  }).execute;
  const answer = await execute({ nodeType: "image", mode: "i2i" }, {});
  const lines = renderGenerationModelsForModel(answer).split("\n");
  const start = lines.findIndex((l) => l.includes("(qwen-image-edit-multiple-angles)"));
  if (start < 0) return "";
  const end = lines.findIndex((l, i) => i > start && l.startsWith("- "));
  return lines.slice(start, end < 0 ? undefined : end).join("\n");
}

describe("camera angles in the model listing", () => {
  it("says which side 90 and 270 are, on the grid the model takes", async () => {
    const line = await qwenBlock();
    expect(line).not.toBe("");
    expect(line).toContain("90 the subject's own right side");
    expect(line).toContain("270 the subject's own left side");
    expect(line).toContain("0 to 315 in steps of 45");
    expect(line).toContain("-30 to 60 in steps of 30");
    expect(line).toContain("0 close-up, 1 medium shot, 2 wide shot");
  });
});
