// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

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

const capabilities = vi.hoisted(() => vi.fn(async (): Promise<{ pictures: boolean; contextWindow?: number }> => ({ pictures: true, contextWindow: 1_000_000 })));
// Every upstream configured, so every tool that needs one is handed out.
const configured = { upstreams: [{ upstream: "openrouter", weight: 0, configured: true, envVar: "OPENROUTER_API_KEY" }] };
vi.mock("@domain/provider/instance.js", () => ({
  provider: () => ({ llm: { capabilities, availability: () => configured, judgeAvailability: () => configured } }),
}));

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
        p === "BRAVE_SEARCH_API_KEY"
          ? "test-key"
          : Reflect.get(t, p),
    }),
  };
});

beforeAll(() => {
  initCore(process.env);
});


describe("buildAgentConfig", () => {
  it("hands a caller the baseline and the canvas tools", async () => {
    // The defect this fixes: bare chat used to pass an empty array and get
    // no tools at all, so the model could not search and invented answers.
    //
    // The names are written out rather than compared against BASELINE_TOOLS,
    // which would be self-referential — adding a tool nobody vetted to that
    // constant would change both sides and stay green. This is the list, and
    // adding to it is supposed to require editing this line.
    const config = await buildAgentConfig({ basePrompt: "base" });
    expect(Object.keys(config.tools).sort()).toEqual([
      "ask_user",
      "delete_memory",
      "get_canvas_capabilities",
      "get_generation_template",
      "get_product_guide",
      "judge_likelihood",
      "list_generation_models",
      "list_project_activity",
      "propose_canvas_action",
      "propose_document_edit",
      "propose_scene_generation",
      "read_conversation",
      "read_memory",
      "read_node_history",
      "request_space_content",
      "save_image",
      "save_memory",
      "search_conversations",
      "search_images",
      "understand_media",
      "web_fetch",
      "web_search",
    ]);
  });

  it("answers with the model the request names (#1363)", async () => {
    // The user picks the model in the chat panel, and the route hands the
    // pick down. A value no config holds is what tells a read of the request
    // apart from a read of the config.
    const sentinel = "sentinel/model-the-user-picked";
    expect((await buildAgentConfig({ basePrompt: "base", modelId: sentinel })).modelId).toBe(sentinel);
  });

  it("takes the model from config rather than a literal when the request names none", async () => {
    // Worker used to call getModel() with no argument, landing on a literal
    // in llm.ts that happened to equal agent.yaml's default_model but was
    // not read from it. Editing the yaml moved one and not the other.
    //
    // Asserting against getAgentConfig().default_model directly does NOT
    // catch that: the yaml's value IS that literal, so a hardcoded factory
    // and a reading one produce the same string and the test cannot tell
    // them apart. So the config has to say something the literal does not.
    const sentinel = "sentinel/model-from-config";
    vi.mocked(getAgentConfig).mockReturnValueOnce({
      ...getAgentConfig(),
      default_model: sentinel,
    });
    expect((await buildAgentConfig({ basePrompt: "base" })).modelId).toBe(sentinel);
  });

  it("is the base prompt alone when the caller has no memory", async () => {
    expect((await buildAgentConfig({ basePrompt: "base" })).instructions).toEqual({ base: "base" });
  });

  it("ends the instructions with the Project Instructions the caller hands it (#1400)", async () => {
    const { instructions } = await buildAgentConfig({ basePrompt: "base", projectInstructions: "Reply in English." });

    expect(instructions.projectInstructions).toMatch(/^## Project Instructions\n\n/);
    expect(instructions.projectInstructions).toContain("<project_instructions>\nReply in English.\n</project_instructions>");
  });

  it("carries the main model's window, and the configured fallback when the directory cannot say (inner#1567)", async () => {
    capabilities.mockResolvedValueOnce({ pictures: true, contextWindow: 200_000 });
    const known = await buildAgentConfig({ basePrompt: "base" });
    capabilities.mockResolvedValueOnce({ pictures: true });
    const unknown = await buildAgentConfig({ basePrompt: "base" });

    expect(known.contextWindow).toBe(200_000);
    expect(known.contextWindowFallback).toBeUndefined();
    expect(unknown.contextWindow).toBe(getAgentConfig().context_window_fallback_tokens);
    expect(unknown.contextWindowFallback).toBe(true);
  });
});
