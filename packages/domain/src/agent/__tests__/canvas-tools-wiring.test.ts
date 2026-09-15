// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Which callers the canvas tools reach (#261).
 *
 * They belong to a turn where someone is talking to the agent with a canvas
 * in front of them. `BASELINE_TOOLS` is wider than that: a skill run takes
 * the union of the baseline and its own tools, and a worker job runs a skill
 * with no canvas at all and no one to act on what it learns.
 */
import { beforeAll, describe, expect, it, vi } from "vitest";
import { initCore } from "@breatic/core";
import type * as CoreModule from "@breatic/core";
import type * as SkillsLoaderModule from "@domain/agent/skills-loader.js";
import { buildAgentConfig } from "@domain/agent/agent-config.js";
import { CANVAS_TOOLS } from "@domain/agent/tools/index.js";

vi.mock("@breatic/core", async (importOriginal) => {
  const actual = await importOriginal<typeof CoreModule>();
  return {
    ...actual,
    // Tools whose configuration is missing are dropped, which is a rule with
    // its own tests. Here the subject is who reaches the tools, so nothing is
    // missing.
    env: new Proxy(actual.env, {
      get: (t, p: string) =>
        p === "BRAVE_SEARCH_API_KEY" || p === "OPENROUTER_API_KEY"
          ? "test-key"
          : Reflect.get(t, p),
    }),
  };
});

vi.mock("@domain/agent/skills-loader.js", async (importOriginal) => {
  const actual = await importOriginal<typeof SkillsLoaderModule>();
  return {
    ...actual,
    getSkillRegistry: () => {
      const skills: Record<string, Record<string, unknown>> = {
        researchy: {
          name: "researchy",
          description: "d",
          tools: ["web_search"],
          category: "research",
        },
      };
      return {
        get: (name: string) => skills[name],
        getInternal: (name: string) => skills[name],
        loadSkillContent: (name: string) => `## Skill: ${name}\nbody text`,
      };
    },
  };
});

beforeAll(() => {
  initCore(process.env);
});

describe("who reaches the canvas tools", () => {
  it("offers them to a plain chat turn", () => {
    const offered = Object.keys(buildAgentConfig({ interactive: true }).tools);
    for (const name of CANVAS_TOOLS) expect(offered).toContain(name);
  });

  it("leaves a skill turn with exactly what it had", () => {
    const offered = Object.keys(
      buildAgentConfig({ skillName: "researchy", interactive: true }).tools,
    );
    for (const name of CANVAS_TOOLS) expect(offered).not.toContain(name);
  });

  it("leaves a worker job with exactly what it had", () => {
    // The worker passes a skill name and nothing else; it has no canvas and
    // no reader, so a capability answer there is spent attention.
    const offered = Object.keys(buildAgentConfig({ skillName: "researchy" }).tools);
    for (const name of CANVAS_TOOLS) expect(offered).not.toContain(name);
  });

  it("names tools the registry can actually build", () => {
    const offered = Object.keys(buildAgentConfig({ interactive: true }).tools);
    // A name in the list that the map cannot build is dropped silently, so a
    // typo would leave the plain-chat turn without the tool and nothing red.
    for (const name of CANVAS_TOOLS) expect(offered).toContain(name);
    expect(CANVAS_TOOLS.length).toBeGreaterThan(0);
  });
});
