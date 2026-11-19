// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from "vitest";
import { createProvider } from "../../provider.js";
import { describesInput, parsePricingRules } from "../index.js";

// A run whose element is described on a language model first pays for that description in credits when the language
// model runs on our keys (inner#1953); the server's admission, the Agent and the panel all ask this one question.

const flat = { kind: "formula" as const, base_price: 10_000, formula: "", discount_rate: 100 };

const provider = createProvider({
  config: {
    upstreams: {
      wavespeed: { kind: "wavespeed", base_url: "https://x.example", key_env: "WAVESPEED_API_KEY" },
      other: { kind: "wavespeed", base_url: "https://y.example", key_env: "OTHER_API_KEY" },
    },
    media: {
      models: {
        described: {
          upstreams: [
            {
              upstream: "wavespeed",
              weight: 1,
              model_id: "d",
              prompt_field: "prompt",
              pricing: flat,
              extra_steps: [
                {
                  kind: "element",
                  endpoint: "x/element",
                  at: "before",
                  for_param: "elements",
                  per_item: true,
                  describe: { model: "google/gemini-3.8-flash", question: "What is it?", max_output_tokens: 100 },
                  pricing: flat,
                },
              ],
            },
            { upstream: "other", weight: 2, model_id: "d", prompt_field: "prompt", pricing: flat },
          ],
        },
        undescribed: {
          upstreams: [{
            upstream: "wavespeed",
            weight: 1,
            model_id: "u",
            prompt_field: "prompt",
            pricing: flat,
            extra_steps: [{ kind: "upload_reference", endpoint: "x/upload", at: "before", for_param: "song", pricing: flat }],
          }],
        },
      },
    },
  },
  keyOf: () => "k",
  llmMaxRetries: 0,
  cleanText: (t) => t,
});

/**
 * A model's rules as the browser reads them back from the model list.
 * @param model - The model.
 * @returns The parsed rules.
 */
const browserRules = (model: string): ReturnType<typeof parsePricingRules> =>
  parsePricingRules(JSON.parse(JSON.stringify(provider.pricingRules(model))) as unknown);

describe("whether a run describes an input first", () => {
  it.each([
    ["an element", { elements: ["https://a.example/e.png"] }, true],
    ["no element", {}, false],
    ["an empty list", { elements: [] }, false],
  ])("on a model with a description step, with %s: %s", (_, params, expected) => {
    expect(describesInput(provider.pricingRules("described"), params)).toBe(expected);
    expect(describesInput(browserRules("described"), params)).toBe(expected);
  });

  it("never on a model whose steps describe nothing, whatever its params", () => {
    expect(describesInput(browserRules("undescribed"), { song: "https://a.example/s.mp3" })).toBe(false);
  });
});
