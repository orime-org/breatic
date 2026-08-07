// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * One gate, asked the same way by every entry point.
 *
 * Gate 2 found that canvas task creation asked nothing at all: a `skill_name`
 * went from the request body into the task row and the queue untouched, so
 * any editor could have the worker run any skill. Chat asked, canvas did not,
 * and the routing config's `surfaces` axis had no consumer anywhere.
 *
 * Writing the check twice is what let them drift, so these tests cover the
 * one function both now call.
 */
import { describe, expect, it, vi } from "vitest";
import type * as CoreModule from "@breatic/core";
import { assertUserMayInvoke } from "@domain/agent/skill-gate.js";

const routing = {
  skills: {
    chat_only: { surfaces: ["chat"], user_invocable: true, model_invocable: true },
    both: { surfaces: ["chat", "canvas"], user_invocable: true, model_invocable: false },
    model_only: { surfaces: ["chat"], user_invocable: false, model_invocable: true },
  },
};

vi.mock("@breatic/core", async (importOriginal) => {
  const actual = await importOriginal<typeof CoreModule>();
  return { ...actual, getSkillRouting: () => routing };
});

vi.mock("@domain/agent/skills-loader.js", () => ({
  getSkillRegistry: () => ({
    get: (name: string) =>
      ["chat_only", "both", "model_only", "unlisted"].includes(name)
        ? { name }
        : undefined,
  }),
}));

describe("assertUserMayInvoke", () => {
  it("lets through a skill this surface serves", () => {
    expect(() => assertUserMayInvoke("chat_only", "chat")).not.toThrow();
    expect(() => assertUserMayInvoke("both", "canvas")).not.toThrow();
  });

  it("rejects a skill this surface does not serve", () => {
    // The axis that had no consumer at all before this. A chat-only skill
    // reaching canvas is what the config exists to stop.
    expect(() => assertUserMayInvoke("chat_only", "canvas")).toThrow(/not available/);
  });

  it("rejects a skill the user may not fire directly", () => {
    expect(() => assertUserMayInvoke("model_only", "chat")).toThrow(/not user-invocable/);
  });

  it("rejects a skill absent from the routing config", () => {
    // It exists on disk, so the registry has it. The config does not, and
    // the config's own rule is that silence grants nothing.
    expect(() => assertUserMayInvoke("unlisted", "chat")).toThrow(/not available/);
  });

  it("rejects a skill that does not exist at all", () => {
    expect(() => assertUserMayInvoke("nope", "chat")).toThrow(/not found/);
  });
});
