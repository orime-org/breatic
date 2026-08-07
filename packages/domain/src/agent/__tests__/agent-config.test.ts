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
import type * as CoreModule from "@breatic/core";
import type * as SkillsLoaderModule from "@domain/agent/skills-loader.js";
import { buildAgentConfig } from "@domain/agent/agent-config.js";
import { BASELINE_TOOLS } from "@domain/agent/tools/index.js";

vi.mock("@breatic/core", async (importOriginal) => {
  const actual = await importOriginal<typeof CoreModule>();
  return {
    ...actual,
    getAgentConfig: vi.fn(actual.getAgentConfig),
    // buildToolSet drops tools whose configuration is missing, which is a
    // separate rule with its own tests. Here the subject is what the factory
    // hands out when nothing is missing, so nothing is missing.
    env: new Proxy(actual.env, {
      get: (t, p: string) =>
        p === "BRAVE_SEARCH_API_KEY" ? "test-key" : Reflect.get(t, p),
    }),
  };
});

vi.mock("@domain/agent/skills-loader.js", async (importOriginal) => {
  const actual = await importOriginal<typeof SkillsLoaderModule>();
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


describe("buildAgentConfig", () => {
  it("gives both entry points the same model and tools for one skill", () => {
    // The two entries genuinely differ in what they pass: chat has a base
    // prompt and memory, worker has neither. So the previous version of this
    // test — same literal twice — could never fail; it asserted that a pure
    // function is deterministic.
    //
    // What must hold across them is the part that is not caller-specific:
    // the model and the tool set. Instructions legitimately differ, and the
    // skill's own body has to be in both.
    const fromChat = buildAgentConfig({
      skillName: "researchy",
      basePrompt: "chat base prompt",
      memoryContext: {
        userMemory: "u",
        projectMemory: "p",
        conversationMemory: "c",
      },
    });
    const fromWorker = buildAgentConfig({ skillName: "researchy" });

    expect(fromChat.modelId).toBe(fromWorker.modelId);
    expect(Object.keys(fromChat.tools).sort()).toEqual(
      Object.keys(fromWorker.tools).sort(),
    );
    expect(fromChat.instructions).toContain("body text");
    expect(fromWorker.instructions).toContain("body text");
  });

  it("hands a caller that declares no skill the six baseline tools", () => {
    // The defect this fixes: bare chat used to pass an empty array and get
    // no tools at all, so the model could not search and invented answers.
    //
    // The names are written out rather than compared against BASELINE_TOOLS,
    // which would be self-referential — adding a tool nobody vetted to that
    // constant would change both sides and stay green. This is the list, and
    // adding to it is supposed to require editing this line.
    const config = buildAgentConfig({ basePrompt: "base", interactive: true });
    expect(Object.keys(config.tools).sort()).toEqual([
      "ask_user_choice",
      "ask_user_question",
      "propose_canvas_action",
      "show_search_results",
      "web_fetch",
      "web_search",
    ]);
  });

  it("gives a skill the baseline plus whatever else it declares", () => {
    // Ten of the eleven skills declare no tools. If a skill's declaration
    // replaced the baseline instead of adding to it, every one of them would
    // run with nothing -- the same defect, moved to the skill path.
    const config = buildAgentConfig({ skillName: "researchy", interactive: true });
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

  it("keeps interaction tools away from a caller that cannot draw them", () => {
    // Worker runs a task with nobody watching. Handing it ask_user_question
    // means the model asks a question, nothing renders it, and the raw
    // sentinel string comes back as the answer.
    const config = buildAgentConfig({ skillName: "researchy" });
    expect(Object.keys(config.tools).sort()).toEqual(["web_fetch", "web_search"]);
  });

  it("gives them to a caller that can", () => {
    const config = buildAgentConfig({ skillName: "researchy", interactive: true });
    expect(Object.keys(config.tools)).toContain("ask_user_question");
  });

  it("throws a typed error for a skill that does not exist", () => {
    expect(() => buildAgentConfig({ skillName: "nope" })).toThrow(
      /nope/,
    );
  });
});
