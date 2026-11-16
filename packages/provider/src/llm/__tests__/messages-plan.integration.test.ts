// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { NoUpstreamAvailable, UpstreamRequestRejected } from "../../errors.js";
import { createProvider } from "../../provider.js";
import { llmConfig, llmProvider, startFakes, stopFakes, type LlmFakes } from "./llm-harness.js";

let fakes: LlmFakes;

beforeEach(async () => {
  fakes = await startFakes();
});

afterEach(async () => {
  await stopFakes(fakes);
});

describe("messagesPlan: where a web-animation call may go, planned on Node for the Worker", () => {
  it("lists the route's upstreams that take Messages, in weight order, whatever keys this process holds", () => {
    const plan = llmProvider(fakes, {}).llm.messagesPlan("deepseek/deepseek-v4.1-flash-1017");
    expect(plan).toEqual({
      model: "deepseek/deepseek-v4.1-flash-1017",
      candidates: [
        { upstream: "deepseek", kind: "deepseek", baseUrl: fakes.deepseek.url, vendorModel: "deepseek-flash", keyEnv: "DEEPSEEK_API_KEY" },
        { upstream: "openrouter", kind: "openrouter", baseUrl: `${fakes.openrouter.url}/api/v1`, vendorModel: "deepseek/deepseek-v4.1-flash-1017", keyEnv: "OPENROUTER_API_KEY" },
      ],
    });
  });

  it("carries the model's direct prices to the upstreams priced from them, and to no gateway", () => {
    const plan = llmProvider(fakes, {}).llm.messagesPlan("deepseek/deepseek-v4-pro");
    expect(plan.candidates.map((c) => [c.upstream, c.prices])).toEqual([
      ["deepseek", [{ input_cache_hit_per_mtok: 0.044, input_cache_miss_per_mtok: 1.32, output_per_mtok: 3.96 }]],
      ["openrouter", undefined],
    ]);
  });

  it("leaves out an upstream that takes no Messages request", () => {
    const plan = llmProvider(fakes, {}).llm.messagesPlan("google/gemini-3.8-flash");
    expect(plan.candidates.map((c) => c.upstream)).toEqual(["openrouter"]);
  });

  it("names the one upstream a call is pinned to", () => {
    const plan = llmProvider(fakes, {}).llm.messagesPlan("deepseek/deepseek-v4-pro", { mode: "upstream", upstream: "openrouter" });
    expect(plan.candidates.map((c) => c.upstream)).toEqual(["openrouter"]);
  });

  it.each(["google", "nowhere"])("refuses a pin to %s, which serves the model no Messages request on this route", (upstream) => {
    expect(() => llmProvider(fakes, {}).llm.messagesPlan("google/gemini-3.8-flash", { mode: "upstream", upstream })).toThrow(UpstreamRequestRejected);
  });

  it("puts the cheaper upstream first in cheapest mode, an unpriced one last", () => {
    const plan = llmProvider(fakes, {}).llm.messagesPlan("deepseek/deepseek-v4-pro", { mode: "cheapest" });
    expect(plan.candidates.map((c) => c.upstream)).toEqual(["deepseek", "openrouter"]);
  });

  it("answers no upstream available when the route has none that takes Messages", () => {
    const config = llmConfig(fakes);
    config.llm!.routes = [{ prefix: "", upstreams: [{ upstream: "google", weight: 0 }] }];
    const provider = createProvider({ config, keyOf: () => undefined, llmMaxRetries: 0, cleanText: (t) => t });
    expect(() => provider.llm.messagesPlan("google/gemini-3.8-flash")).toThrow(NoUpstreamAvailable);
  });
});
