// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * A skill job's model calls carry the same output ceiling chat's do (#148, G3).
 *
 * The ceiling is per model call, and the key is named for that rather than for
 * where it is used. Compaction and consolidation have no counterpart on this
 * path — a skill job has no history, no memory and no watermark — but a model
 * call is a model call, and `stopWhen: stepCountIs(skill_agent_max_steps)`
 * lets one job make fifteen of them.
 *
 * The two config values are deliberately far apart here: an implementation
 * that reaches for the wrong key gets the wrong number rather than a number
 * that happens to match.
 */

import { vi, describe, it, expect, beforeEach } from "vitest";

const generateTextRetry = vi.hoisted(() => vi.fn());
const buildAgentConfig = vi.hoisted(() => vi.fn());
const getAgentConfig = vi.hoisted(() => vi.fn());

const MAX_OUTPUT_TOKENS = 4242;
const MAX_STEPS = 15;

vi.mock("@breatic/core", () => ({
  env: { ENV: "test", CREDIT_MULTIPLIER: 1 },
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  publishNodeEvent: vi.fn(),
  getStreamRedis: vi.fn(),
  getRedis: vi.fn(),
  getWorkerConfig: vi.fn(),
  getAgentConfig,
  projectActivitiesRepo: {},
  publishActivityNew: vi.fn(),
  downloadAndStore: vi.fn(),
  getStorageAdapter: vi.fn(),
  storageKey: vi.fn(),
  sha256Hex: vi.fn(),
  NotFoundError: class NotFoundError extends Error {},
}));

vi.mock("@breatic/domain", () => ({
  taskService: {},
  nodeHistoryService: {},
  assetService: {},
  getModel: (id: string) => ({ modelId: id }),
  buildAgentConfig,
  generateTextRetry,
  extractPromptText: (x: unknown) => String(x ?? ""),
  releaseCanvasNodeLock: vi.fn(),
  reacquireCanvasNodeLock: vi.fn(),
}));

vi.mock("@breatic/shared", () => ({
  canvasSpaceDocName: (pid: string, sid: string) => `project-${pid}/canvas-${sid}`,
}));

vi.mock("@worker/mini-tool-registry.js", () => ({ resolveMiniToolEntry: vi.fn() }));
vi.mock("@worker/handlers/local/index.js", () => ({ runLocalHandler: vi.fn() }));

vi.mock("ai", () => ({
  tool: (c: Record<string, unknown>) => c,
  generateText: vi.fn(),
  streamText: vi.fn(),
  stepCountIs: (n: number) => ({ stepLimit: n }),
}));

import { runSkillAgent } from "@worker/handlers/dispatch.js";

beforeEach(() => {
  vi.clearAllMocks();
  getAgentConfig.mockReturnValue({
    max_output_tokens: MAX_OUTPUT_TOKENS,
    skill_agent_max_steps: MAX_STEPS,
  });
  buildAgentConfig.mockReturnValue({
    modelId: "test-model",
    instructions: "do the skill",
    tools: {},
  });
  generateTextRetry.mockResolvedValue({ text: "done" });
});

describe("the model calls a skill job makes", () => {
  it("are bounded by the same key chat's are", async () => {
    await runSkillAgent("brainstorm", { topic: "a canyon" });

    expect(generateTextRetry).toHaveBeenCalledTimes(1);
    const call = generateTextRetry.mock.calls[0]?.[0] as { maxOutputTokens?: number };
    expect(call.maxOutputTokens).toBe(MAX_OUTPUT_TOKENS);
  });

  it("still stop after the configured number of steps", async () => {
    // The ceiling is per call and the step limit bounds how many calls there
    // are. Both have to hold for a job to be bounded at all.
    await runSkillAgent("brainstorm", { topic: "a canyon" });

    const call = generateTextRetry.mock.calls[0]?.[0] as {
      stopWhen?: { stepLimit?: number };
    };
    expect(call.stopWhen?.stepLimit).toBe(MAX_STEPS);
  });
});
