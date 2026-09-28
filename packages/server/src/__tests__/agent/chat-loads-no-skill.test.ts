// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * A chat turn reaches no skill at all.
 *
 * The skill machinery stays where it is -- the registry, the gate, the files
 * under `skills/`, and the worker job that runs one. What a chat turn does
 * with them is what this pins: nothing. The registry is not read while the
 * prompt is built, and the turn carries no skill name to hand on.
 *
 * Asserting that the registry is never called rather than that the prompt
 * lacks some phrase: a prompt that stopped printing the summary while still
 * fetching it would pass a wording check and still be loading a skill.
 */

import { describe, expect, it, vi } from "vitest";
import type * as DomainModule from "@breatic/domain";

const getSkillRegistry = vi.fn(() => ({
  buildSummaryXml: () => "<skills />",
  getAlwaysContent: () => "",
}));

vi.mock("@breatic/domain", async (importOriginal) => {
  const actual = await importOriginal<typeof DomainModule>();
  return { ...actual, getSkillRegistry };
});

const { buildSystemPrompt } = await import("@server/agent/context.js");
const { MainAgent } = await import("@server/agent/main-agent.js");

describe("a chat turn loads no skill", () => {
  it("builds its prompt without reading the skill registry", () => {
    getSkillRegistry.mockClear();

    buildSystemPrompt();

    expect(getSkillRegistry).not.toHaveBeenCalled();
  });

  it("writes no skill section into the prompt", () => {
    const prompt = buildSystemPrompt();

    expect(prompt).not.toContain("Available Skills");
    expect(prompt).not.toContain("Always-active Skill Context");
    expect(prompt).not.toContain("{skills_summary}");
    expect(prompt).not.toContain("{always_skills}");
  });

  it("offers no entrance that runs one", () => {
    // The turn used to take a skill name and pass it to `buildAgentConfig`.
    // Gone from this side: what the worker does with its own skill jobs is
    // another path and keeps that parameter.
    expect(Reflect.has(MainAgent.prototype, "handleSkillCommand")).toBe(false);
  });
});
