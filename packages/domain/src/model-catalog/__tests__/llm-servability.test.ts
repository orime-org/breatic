// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * Whether a language model's calls can be served here, asked of the upstreams a route may use: a turn resumed on the
 * upstream it started on is served only when that one has its key.
 */

import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { llmServability } from "../model-catalog.js";
import { restoreProcessEnv, useEnvWithKeys } from "./catalog-env.js";

const FLASH = "deepseek/deepseek-v4.1-flash-1017";

beforeEach(() => {
  restoreProcessEnv();
});

afterAll(() => {
  restoreProcessEnv();
});

describe("llmServability", () => {
  it("serves a call some upstream has its key for, on the weights", () => {
    useEnvWithKeys(["OPENROUTER_API_KEY"]);
    expect(llmServability(FLASH, "call")).toEqual({ servable: true });
  });

  it("asks only the upstream a route stays on, naming its variable", () => {
    useEnvWithKeys(["OPENROUTER_API_KEY"]);
    expect(llmServability(FLASH, "call", { mode: "upstream", upstream: "deepseek" })).toEqual({
      servable: false,
      reason: "unconfigured",
      envVars: ["DEEPSEEK_API_KEY"],
    });
    expect(llmServability(FLASH, "call", { mode: "upstream", upstream: "openrouter" })).toEqual({ servable: true });
  });

  it("says a route through an upstream the model has no route on is unbound", () => {
    useEnvWithKeys(["OPENROUTER_API_KEY", "DEEPSEEK_API_KEY"]);
    expect(llmServability(FLASH, "call", { mode: "upstream", upstream: "anthropic" })).toEqual({
      servable: false,
      reason: "unbound",
      upstream: "anthropic",
    });
  });
});
