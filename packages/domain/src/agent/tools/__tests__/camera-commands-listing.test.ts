// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * inner#1241 — the agent learns from the model listing which camera commands
 * MiniMax H3 reads and how they are written, in every mode H3 serves.
 */

import { CAMERA_COMMANDS } from "@breatic/shared";
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
 * The listing line of one model in one video mode.
 * @param mode - The mode asked about.
 * @param name - The model's name.
 * @returns Its line, or the empty string when it is not listed.
 */
async function lineOf(mode: string, name: string): Promise<string> {
  const execute = (generationModels as unknown as {
    execute: (i: unknown, o: object) => Promise<PricedModelsForMode>;
  }).execute;
  const answer = await execute({ nodeType: "video", mode }, {});
  return renderGenerationModelsForModel(answer).split("\n").find((l) => l.includes(`(${name})`)) ?? "";
}

const SERVED: ReadonlyArray<readonly [string, string]> = [
  ["t2v", "minimax-h3-text-to-video"],
  ["multi_shot", "minimax-h3-text-to-video"],
  ["i2v", "minimax-h3-image-to-video"],
  ["first_last", "minimax-h3-image-to-video"],
  ["multi_shot", "minimax-h3-image-to-video"],
  ["ref", "minimax-h3-reference-to-video"],
  ["multi_shot", "minimax-h3-reference-to-video"],
];

describe("camera commands in the model listing", () => {
  it.each(SERVED)("lists every command and how to write them for H3 in %s (%s)", async (mode, name) => {
    const line = await lineOf(mode, name);
    expect(line, `${name} is listed in ${mode}`).not.toBe("");
    for (const command of CAMERA_COMMANDS) expect(line).toContain(`[${command}]`);
    expect(line).toMatch(/at most 3 in one bracket/);
    expect(line).toMatch(/run at the same time/);
    expect(line).toMatch(/opposite directions of one axis/);
  });

  it("says where the commands go in the multi-shot mode", async () => {
    expect(await lineOf("multi_shot", "minimax-h3-text-to-video")).toMatch(/into the shot/);
    expect(await lineOf("t2v", "minimax-h3-text-to-video")).not.toMatch(/into the shot/);
  });

  it("says nothing about camera commands for a model that reads none", async () => {
    const line = await lineOf("t2v", "kling-v3.0-4k-text-to-video");
    expect(line).not.toBe("");
    expect(line).not.toMatch(/camera command/i);
  });
});
