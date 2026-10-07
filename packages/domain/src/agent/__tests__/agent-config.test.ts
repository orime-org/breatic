// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The one place an agent's three things get decided.
 *
 * Before this, three call sites each assembled model, instructions and tools
 * their own way, and the seven values they disagreed on were only visible by
 * reading all three side by side. The point of the factory is that there is
 * nothing left to disagree.
 *
 */
import { beforeAll, describe, expect, it, vi } from "vitest";
import { getAgentConfig, initCore } from "@breatic/core";
import type * as CoreModule from "@breatic/core";
import { buildAgentConfig } from "@domain/agent/agent-config.js";

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
        p === "BRAVE_SEARCH_API_KEY" || p === "OPENROUTER_API_KEY"
          ? "test-key"
          : Reflect.get(t, p),
    }),
  };
});

beforeAll(() => {
  initCore(process.env);
});


describe("buildAgentConfig", () => {
  it("hands a caller the baseline and the canvas tools", () => {
    // The defect this fixes: bare chat used to pass an empty array and get
    // no tools at all, so the model could not search and invented answers.
    //
    // The names are written out rather than compared against BASELINE_TOOLS,
    // which would be self-referential — adding a tool nobody vetted to that
    // constant would change both sides and stay green. This is the list, and
    // adding to it is supposed to require editing this line.
    const config = buildAgentConfig({ basePrompt: "base", interactive: true });
    expect(Object.keys(config.tools).sort()).toEqual([
      "ask_user",
      "get_canvas_capabilities",
      "get_product_guide",
      "judge_likelihood",
      "list_generation_models",
      "propose_canvas_action",
      "search_images",
      "understand_media",
      "web_search",
    ]);
  });

  it("takes the model from config rather than a literal", () => {
    // Worker used to call getModel() with no argument, landing on a literal
    // in llm.ts that happened to equal agent.yaml's default_model but was
    // not read from it. Editing the yaml moved one and not the other.
    //
    // Asserting against getAgentConfig().default_model directly does NOT
    // catch that: the yaml's value IS that literal, so a hardcoded factory
    // and a reading one produce the same string and the test cannot tell
    // them apart. Measured when this was written -- replacing the read with
    // the literal left every test in this file green. So the config has to
    // say something the literal does not.
    const sentinel = "sentinel/model-from-config";
    vi.mocked(getAgentConfig).mockReturnValueOnce({
      ...getAgentConfig(),
      default_model: sentinel,
    });
    expect(buildAgentConfig({}).modelId).toBe(sentinel);
  });

  it("puts the base prompt first and the memory layers after it", () => {
    const config = buildAgentConfig({
      basePrompt: "base",
      memoryContext: { projectMemory: "p", conversationMemory: "c" },
    });
    expect(config.instructions).toBe("base\n\n## Project Context\np\n\n## Conversation Memory\nc");
  });

  it("is the base prompt alone when there is no memory", () => {
    expect(buildAgentConfig({ basePrompt: "base" }).instructions).toBe("base");
  });

  it("keeps interaction tools away from a caller that cannot draw them", () => {
    // A caller with nobody watching would have the model ask a question that
    // nothing renders, and the raw sentinel string come back as the answer.
    // Everything that does work of its own stays: a caller with no reader
    // still benefits from what a search found, because that reaches the model.
    const config = buildAgentConfig({});
    expect(Object.keys(config.tools).sort()).toEqual([
      "get_canvas_capabilities",
      "get_product_guide",
      "judge_likelihood",
      "list_generation_models",
      "propose_canvas_action",
      "search_images",
      "understand_media",
      "web_search",
    ]);
  });

  it("gives them to a caller that can", () => {
    const config = buildAgentConfig({ interactive: true });
    expect(Object.keys(config.tools)).toContain("ask_user");
  });
});
