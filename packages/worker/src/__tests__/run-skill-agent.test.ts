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
import type { UsageRecorder } from "@breatic/domain";

const handOffLookups = vi.hoisted(() => vi.fn(async (..._args: unknown[]) => undefined));

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
  resolveProvider: vi.fn(() => "routed"),
  handOffLookups,
  usageContextFor: (tools: Record<string, unknown>, usage: unknown) =>
    Object.fromEntries(Object.keys(tools).map((name) => [name, { usage }])),
}));

/** A recorder that keeps the model calls it was told about. */
function recorder(): UsageRecorder & {
  recordModelCall: ReturnType<typeof vi.fn>;
  awaitingLookup: ReturnType<typeof vi.fn>;
  settle: ReturnType<typeof vi.fn>;
} {
  return {
    operation: { operationKey: "task:t-1", feature: "skill_task", actorUserId: "u-1", projectId: "p-1" },
    recordModelCall: vi.fn(),
    recordServiceCall: vi.fn(),
    recordLookedUpCall: vi.fn(),
    awaitingLookup: vi.fn(() => []),
    settle: vi.fn(async () => 0),
  };
}


beforeEach(() => {
  [generateTextRetry, buildAgentConfig, getModel, stepCountIs, handOffLookups].forEach((m) =>
    m.mockClear(),
  );
});

describe("runSkillAgent", () => {
  it("takes its model, instructions and tools from the one factory", async () => {
    const { runSkillAgent } = await import("@worker/handlers/dispatch.js");
    await runSkillAgent("creative_research", { prompt: "hello" }, recorder());

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
    await runSkillAgent("creative_research", {}, recorder());
    expect(stepCountIs).toHaveBeenCalledWith(7);
  });

  it("passes the task params to the agent as its message", async () => {
    const { runSkillAgent } = await import("@worker/handlers/dispatch.js");
    await runSkillAgent("creative_research", { prompt: "a cat", count: 2 }, recorder());
    const call = generateTextRetry.mock.calls[0]?.[0] as unknown as {
      messages: Array<{ role: string; content: string }>;
    };
    expect(call.messages).toEqual([
      { role: "user", content: JSON.stringify({ prompt: "a cat", count: 2 }) },
    ]);
  });

  it("returns the agent's text and the skill that produced it", async () => {
    const { runSkillAgent } = await import("@worker/handlers/dispatch.js");
    expect(await runSkillAgent("creative_research", {}, recorder())).toEqual([
      "the agent's answer",
      ["creative_research"],
      0,
    ]);
  });

  it("records each model call and returns what they add up to", async () => {
    const usage = recorder();
    usage.settle.mockResolvedValue(12.5);
    generateTextRetry.mockImplementationOnce(async (options: Record<string, unknown>) => {
      const onEnd = options.onLanguageModelCallEnd as (event: unknown) => void;
      onEnd({ responseId: "gen-1", usage: { outputTokens: 10 }, providerMetadata: undefined });
      onEnd({ responseId: "gen-2", usage: { outputTokens: 20 }, providerMetadata: undefined });
      return { text: "the agent's answer" };
    });
    const { runSkillAgent } = await import("@worker/handlers/dispatch.js");

    const [, , credits] = await runSkillAgent("creative_research", {}, usage);

    expect(usage.recordModelCall).toHaveBeenCalledTimes(2);
    expect(usage.recordModelCall).toHaveBeenCalledWith({
      source: "model",
      model: "vendor/from-the-factory",
      provider: "routed",
      usage: { outputTokens: 10 },
      providerMetadata: undefined,
      generationId: "gen-1",
    });
    expect(credits).toBe(12.5);
  });

  it("hands the calls it could not price to the later lookup", async () => {
    const usage = recorder();
    usage.awaitingLookup.mockReturnValue(["gen-3"]);
    const { runSkillAgent } = await import("@worker/handlers/dispatch.js");

    await runSkillAgent("creative_research", {}, usage);

    expect(handOffLookups).toHaveBeenCalledWith(["gen-3"], usage.operation, {
      model: "vendor/from-the-factory",
      description: "Skill: creative_research",
    });
  });

  it("hands them off from a run that failed too", async () => {
    const usage = recorder();
    usage.awaitingLookup.mockReturnValue(["gen-3"]);
    generateTextRetry.mockRejectedValueOnce(new Error("provider down"));
    const { runSkillAgent } = await import("@worker/handlers/dispatch.js");

    await expect(runSkillAgent("creative_research", {}, usage)).rejects.toThrow("provider down");

    expect(handOffLookups).toHaveBeenCalledWith(["gen-3"], usage.operation, expect.anything());
  });

  it("hands every tool the task's recorder", async () => {
    const usage = recorder();
    const { runSkillAgent } = await import("@worker/handlers/dispatch.js");
    await runSkillAgent("creative_research", {}, usage);
    const call = generateTextRetry.mock.calls[0]?.[0] as { toolsContext: unknown };
    expect(call.toolsContext).toEqual({ web_search: { usage } });
  });

  it("lands the rows of a run that failed before failing with it", async () => {
    const usage = recorder();
    generateTextRetry.mockRejectedValueOnce(new Error("provider down"));
    const { runSkillAgent } = await import("@worker/handlers/dispatch.js");
    await expect(runSkillAgent("creative_research", {}, usage)).rejects.toThrow("provider down");
    expect(usage.settle).toHaveBeenCalledTimes(1);
  });

  it("falls back to a placeholder rather than returning empty text", async () => {
    generateTextRetry.mockResolvedValueOnce({ text: "" });
    const { runSkillAgent } = await import("@worker/handlers/dispatch.js");
    const [text] = await runSkillAgent("creative_research", {}, recorder());
    expect(text).toBe("Task completed.");
  });
});
