// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The canvas tools reach a chat turn (#261): someone is talking to the agent
 * with a canvas in front of them.
 */
import { beforeAll, describe, expect, it, vi } from "vitest";
import { initCore } from "@breatic/core";
import type * as CoreModule from "@breatic/core";
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

beforeAll(() => {
  initCore(process.env);
});

describe("who reaches the canvas tools", () => {
  it("offers them to a plain chat turn", () => {
    const offered = Object.keys(buildAgentConfig({}).tools);
    // A name in the list that the map cannot build is dropped silently, so a
    // typo would leave the plain-chat turn without the tool and nothing red.
    // The count guards the loop itself: over an empty list it asserts nothing.
    expect(CANVAS_TOOLS.length, "the list is not empty").toBeGreaterThan(0);
    for (const name of CANVAS_TOOLS) expect(offered).toContain(name);
  });
});
