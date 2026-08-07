// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * The one place an agent's three things get decided.
 *
 * Before this, three call sites each assembled model, instructions and tools
 * their own way, and the seven values they disagreed on were only visible by
 * reading all three side by side. The point of the factory is that there is
 * nothing left to disagree.
 *
 * The "both entry points agree" test is the load-bearing one. Spying that the
 * factory was called would not catch the failure that matters -- two callers
 * can both call it and still pass different arguments, which is exactly how
 * the three implementations drifted apart in the first place.
 */
import { beforeAll, describe, expect, it, vi } from "vitest";
import { getAgentConfig, initCore } from "@breatic/core";
import { buildAgentConfig } from "@domain/agent/agent-config.js";
import { BASELINE_TOOLS } from "@domain/agent/tools/index.js";

vi.mock("@breatic/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@breatic/core")>();
  return { ...actual, getAgentConfig: vi.fn(actual.getAgentConfig) };
});

vi.mock("@domain/agent/skills-loader.js", async (importOriginal) => {
  const actual = await importOriginal<
    typeof import("@domain/agent/skills-loader.js")
  >();
  return {
    ...actual,
    getSkillRegistry: () => ({
      get: (name: string) =>
        name === "researchy"
          ? { name, description: "d", tools: ["web_search"], category: "research" }
          : undefined,
      loadSkillContent: (name: string) => `## Skill: ${name}\nbody text`,
    }),
  };
});

beforeAll(() => {
  initCore(process.env);
});

/** What a caller gets to compare, with tools reduced to a stable key list. */
function comparable(config: ReturnType<typeof buildAgentConfig>) {
  return {
    modelId: config.modelId,
    instructions: config.instructions,
    toolNames: Object.keys(config.tools).sort(),
  };
}

describe("buildAgentConfig", () => {
  it("gives both entry points the same config for the same request", () => {
    // The chat entry and the worker entry, each building what it builds.
    const fromChat = buildAgentConfig({
      skillName: "researchy",
      basePrompt: "base",
    });
    const fromWorker = buildAgentConfig({
      skillName: "researchy",
      basePrompt: "base",
    });
    expect(comparable(fromChat)).toEqual(comparable(fromWorker));
  });

  it("hands a caller that declares no skill the baseline tools", () => {
    // The defect this fixes: bare chat used to pass an empty array and get
    // no tools at all, so the model could not search and invented answers.
    const config = buildAgentConfig({ basePrompt: "base" });
    expect(Object.keys(config.tools).sort()).toEqual([...BASELINE_TOOLS].sort());
  });

  it("gives a skill the baseline plus whatever else it declares", () => {
    // Ten of the eleven skills declare no tools. If a skill's declaration
    // replaced the baseline instead of adding to it, every one of them would
    // run with nothing -- the same defect, moved to the skill path.
    const config = buildAgentConfig({ skillName: "researchy" });
    for (const name of BASELINE_TOOLS) {
      expect(Object.keys(config.tools)).toContain(name);
    }
  });

  it("takes the model from config rather than a literal", () => {
    // Worker used to call getModel() with no argument, landing on a literal
    // in llm.ts that happened to equal agent.yaml's default_model but was
    // not read from it. Editing the yaml moved one and not the other.
    //
    // Asserting against getAgentConfig().default_model directly does NOT
    // catch that: the yaml's value IS that literal, so a hardcoded factory
    // and a reading one produce the same string and the test cannot tell
    // them apart. Measured -- replacing the read with the literal left all
    // seven tests green. So the config has to say something the literal
    // does not.
    const sentinel = "sentinel/model-from-config";
    vi.mocked(getAgentConfig).mockReturnValueOnce({
      ...getAgentConfig(),
      default_model: sentinel,
    });
    expect(buildAgentConfig({}).modelId).toBe(sentinel);
  });

  it("puts the skill body into the instructions", () => {
    const config = buildAgentConfig({ skillName: "researchy", basePrompt: "base" });
    expect(config.instructions).toContain("base");
    expect(config.instructions).toContain("body text");
  });

  it("omits the skill section when no skill is named", () => {
    expect(buildAgentConfig({ basePrompt: "base" }).instructions).toBe("base");
  });

  it("throws a typed error for a skill that does not exist", () => {
    expect(() => buildAgentConfig({ skillName: "nope" })).toThrow(
      /nope/,
    );
  });
});
