// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The worker runs a skill the same way chat does, and stops where the config
 * says.
 *
 * This function used to resolve model, instructions and tools itself, and
 * disagreed with chat on every one of them — most visibly by calling
 * `getModel()` with no argument, landing on a literal that happened to match
 * `agent.yaml`'s default without being read from it. It now takes all three
 * from the same factory, which is the point of the whole change and had no
 * test on this side of it at all.
 *
 * The step ceiling is its own acceptance item: a hardcoded 15 lived here, and
 * moving it into `agent.yaml` is only worth anything if this is what reads it.
 */
import { vi, describe, it, expect, beforeEach } from "vitest";

/** The AI SDK wrapper the function under test calls, typed loosely so the
 *  assertions below can read the object it was handed. */
const generateTextRetry = vi.hoisted(() =>
  vi.fn(async (_options: Record<string, unknown>) => ({
    text: "the agent's answer",
  })),
);
const buildAgentConfig = vi.hoisted(() =>
  vi.fn(() => ({
    modelId: "vendor/from-the-factory",
    instructions: "assembled instructions",
    tools: { web_search: {} },
  })),
);
const getModel = vi.hoisted(() => vi.fn((id: string) => `model(${id})`));
const stepCountIs = vi.hoisted(() => vi.fn((n: number) => ({ maxSteps: n })));

vi.mock("ai", () => ({
  tool: (c: Record<string, unknown>) => c,
  streamText: vi.fn(),
  generateText: vi.fn(),
  stepCountIs,
}));

vi.mock("@breatic/core", () => ({
  publishNodeEvent: vi.fn(),
  getStreamRedis: vi.fn(),
  getRedis: vi.fn(),
  env: { ENV: "test", CREDIT_MULTIPLIER: 1 },
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  downloadAndStore: vi.fn(),
  publicUrl: vi.fn(),
  AppError: class extends Error {},
  // The one config value under test. A distinctive number, so an assertion
  // cannot pass against a hardcoded 15 that happens to match the yaml.
  getAgentConfig: () => ({ skill_agent_max_steps: 7, default_model: "d" }),
  getStorageConfig: vi.fn(() => ({})),
  MONOREPO_ROOT: "/tmp",
  getRawEnvVar: vi.fn(),
}));

vi.mock("@breatic/domain", () => ({
  buildAgentConfig,
  generateTextRetry,
  getModel,
  markCompletedAndBill: vi.fn(),
  taskService: {},
  nodeHistoryService: {},
  estimateTaskCredits: vi.fn(),
  getSkillRegistry: vi.fn(),
  acquireCanvasNodeLock: vi.fn(),
  releaseCanvasNodeLock: vi.fn(),
  resolveProvider: vi.fn(),
}));

beforeEach(() => {
  [generateTextRetry, buildAgentConfig, getModel, stepCountIs].forEach((m) =>
    m.mockClear(),
  );
});

describe("runSkillAgent", () => {
  it("takes its model, instructions and tools from the one factory", async () => {
    const { runSkillAgent } = await import("@worker/handlers/dispatch.js");
    await runSkillAgent("creative_research", { prompt: "hello" });

    expect(buildAgentConfig).toHaveBeenCalledWith({ skillName: "creative_research" });
    const call = generateTextRetry.mock.calls[0]?.[0] as unknown as {
      model: string;
      system: string;
      tools: Record<string, unknown>;
    };
    // Every one of the three, so replacing any single one with a local
    // decision goes red here.
    expect(getModel).toHaveBeenCalledWith("vendor/from-the-factory");
    expect(call.model).toBe("model(vendor/from-the-factory)");
    expect(call.system).toBe("assembled instructions");
    expect(Object.keys(call.tools)).toEqual(["web_search"]);
  });

  it("stops at the step count the config gives, not a number written here", async () => {
    const { runSkillAgent } = await import("@worker/handlers/dispatch.js");
    await runSkillAgent("creative_research", {});
    expect(stepCountIs).toHaveBeenCalledWith(7);
  });

  it("passes the task params to the agent as its message", async () => {
    const { runSkillAgent } = await import("@worker/handlers/dispatch.js");
    await runSkillAgent("creative_research", { prompt: "a cat", count: 2 });
    const call = generateTextRetry.mock.calls[0]?.[0] as unknown as {
      messages: Array<{ role: string; content: string }>;
    };
    expect(call.messages).toEqual([
      { role: "user", content: JSON.stringify({ prompt: "a cat", count: 2 }) },
    ]);
  });

  it("returns the agent's text and the skill that produced it", async () => {
    const { runSkillAgent } = await import("@worker/handlers/dispatch.js");
    expect(await runSkillAgent("creative_research", {})).toEqual([
      "the agent's answer",
      ["creative_research"],
    ]);
  });

  it("falls back to a placeholder rather than returning empty text", async () => {
    generateTextRetry.mockResolvedValueOnce({ text: "" });
    const { runSkillAgent } = await import("@worker/handlers/dispatch.js");
    const [text] = await runSkillAgent("creative_research", {});
    expect(text).toBe("Task completed.");
  });
});
