// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * A skill picks its own model, and that choice reaches both entry points.
 *
 * This is the third of the three things a skill fixes — knowledge, tools,
 * model — and until now only two of them existed. Every skill ran on
 * agent.yaml's default, so a skill written around one model's behaviour was
 * silently executed by whichever model the deployment happened to default to.
 *
 * The model stays out of the shared `SkillMeta`, which is what `GET /skills`
 * returns and what the browser imports. A model routing string is internal
 * plumbing; putting it there would ship it to every client.
 */
import { beforeAll, describe, expect, it, vi } from "vitest";
import { getAgentConfig, initCore } from "@breatic/core";
import type * as CoreModule from "@breatic/core";
import type * as SkillsLoaderModule from "@domain/agent/skills-loader.js";
import { buildAgentConfig } from "@domain/agent/agent-config.js";

vi.mock("@breatic/core", async (importOriginal) => {
  const actual = await importOriginal<typeof CoreModule>();
  return {
    ...actual,
    env: new Proxy(actual.env, {
      // Both keys are set because neither is what this file is about: the
      // search key keeps a tool from being dropped, and the OpenRouter key
      // keeps the availability check from refusing a made-up model name.
      // Which model gets chosen is the subject here.
      get: (t, p: string) =>
        p === "BRAVE_SEARCH_API_KEY" || p === "OPENROUTER_API_KEY"
          ? "test-key"
          : Reflect.get(t, p),
    }),
  };
});

vi.mock("@domain/agent/skills-loader.js", async (importOriginal) => {
  const actual = await importOriginal<typeof SkillsLoaderModule>();
  const skills: Record<string, Record<string, unknown>> = {
    picky: { name: "picky", description: "d", tools: [], model: "vendor/picky-model" },
    plain: { name: "plain", description: "d", tools: [] },
  };
  return {
    ...actual,
    getSkillRegistry: () => ({
      get: (name: string) => skills[name],
      getInternal: (name: string) => skills[name],
      loadSkillContent: () => "body",
    }),
  };
});

beforeAll(() => {
  initCore(process.env);
});

describe("the model a skill runs on", () => {
  it("comes from the skill when it names one", () => {
    expect(buildAgentConfig({ skillName: "picky" }).modelId).toBe("vendor/picky-model");
  });

  it("falls back to the configured default when it does not", () => {
    // Most skills have no reason to care. Naming a model is how a skill that
    // does care makes that stick.
    expect(buildAgentConfig({ skillName: "plain" }).modelId).toBe(
      getAgentConfig().default_model,
    );
  });

  it("gives plain chat the configured default", () => {
    expect(buildAgentConfig({}).modelId).toBe(getAgentConfig().default_model);
  });
});
