// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import type { ProviderConfigInput } from "../../config/schema.js";
import { createProvider, type Provider } from "../../provider.js";
import { fakeUpstream, type FakeUpstream, type Reply, type Route } from "../../media/__tests__/fake-upstream.js";

/** A chat completion carrying the cost fields OpenRouter adds. */
export const CHAT_REPLY = {
  id: "gen-test",
  provider: "DeepSeek",
  model: "deepseek/deepseek-v4-pro",
  object: "chat.completion",
  created: 1,
  choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
  usage: { prompt_tokens: 11, completion_tokens: 3, total_tokens: 14, cost: 0.000136764 },
};

/** The same answer in the Responses API shape. */
export const RESPONSES_REPLY = {
  id: "resp_test",
  object: "response",
  created_at: 1,
  model: "gpt-5",
  status: "completed",
  output: [{ type: "message", id: "m1", role: "assistant", status: "completed", content: [{ type: "output_text", text: "ok", annotations: [] }] }],
  usage: { input_tokens: 11, output_tokens: 3, total_tokens: 14 },
};

/** One answer in Anthropic's Messages shape. */
export const MESSAGES_REPLY = {
  id: "msg_test",
  type: "message",
  role: "assistant",
  model: "claude-test",
  content: [{ type: "text", text: "ok" }],
  stop_reason: "end_turn",
  usage: { input_tokens: 11, output_tokens: 3 },
};

/** One answer in Gemini's generateContent shape. */
export const GENERATE_CONTENT_REPLY = {
  candidates: [{ content: { parts: [{ text: "ok" }], role: "model" }, finishReason: "STOP", index: 0 }],
  usageMetadata: { promptTokenCount: 11, candidatesTokenCount: 3, totalTokenCount: 14 },
};

/**
 * The reply each vendor's endpoint answers in, by path.
 * @param path - The request path.
 * @returns A 200 in that endpoint's shape.
 */
export function vendorReply(path: string): Reply {
  if (path.includes(":generateContent")) return { status: 200, body: GENERATE_CONTENT_REPLY };
  if (path.endsWith("/messages")) return { status: 200, body: MESSAGES_REPLY };
  if (path.endsWith("/responses")) return { status: 200, body: RESPONSES_REPLY };
  return { status: 200, body: CHAT_REPLY };
}

/** The five fake LLM upstreams. */
export interface LlmFakes {
  anthropic: FakeUpstream;
  deepseek: FakeUpstream;
  google: FakeUpstream;
  openai: FakeUpstream;
  openrouter: FakeUpstream;
}

/**
 * Start the five fakes, each answering in its vendor's shape.
 * @returns The fakes.
 */
export async function startFakes(): Promise<LlmFakes> {
  const answer: Route = ({ path }) => vendorReply(path);
  const [anthropic, deepseek, google, openai, openrouter] = await Promise.all([
    fakeUpstream(answer),
    fakeUpstream(answer),
    fakeUpstream(answer),
    fakeUpstream(answer),
    fakeUpstream(answer),
  ]);
  return { anthropic, deepseek, google, openai, openrouter };
}

/**
 * Close the fakes.
 * @param fakes - The fakes.
 */
export async function stopFakes(fakes: LlmFakes): Promise<void> {
  await Promise.all(Object.values(fakes).map((f) => f.close()));
}

/**
 * The LLM configuration of design 4.3 over the fakes; OpenRouter's base keeps
 * its `/api/v1` so the decisions endpoint sits beside it.
 * @param fakes - The fakes.
 * @returns The raw configuration.
 */
export function llmConfig(fakes: LlmFakes): ProviderConfigInput {
  return {
    upstreams: {
      anthropic: { kind: "anthropic", base_url: fakes.anthropic.url, key_env: "ANTHROPIC_API_KEY" },
      deepseek: { kind: "deepseek", base_url: fakes.deepseek.url, key_env: "DEEPSEEK_API_KEY" },
      google: { kind: "google", base_url: fakes.google.url, key_env: "GOOGLE_API_KEY" },
      openai: { kind: "openai", base_url: fakes.openai.url, key_env: "OPENAI_API_KEY" },
      openrouter: { kind: "openrouter", base_url: `${fakes.openrouter.url}/api/v1`, key_env: "OPENROUTER_API_KEY" },
    },
    media: { models: {} },
    llm: {
      routes: [
        { prefix: "anthropic/", upstreams: [{ upstream: "anthropic", weight: 0 }, { upstream: "openrouter", weight: 1 }] },
        { prefix: "deepseek/", upstreams: [{ upstream: "deepseek", weight: 0 }, { upstream: "openrouter", weight: 1 }] },
        { prefix: "google/", upstreams: [{ upstream: "google", weight: 0 }, { upstream: "openrouter", weight: 1 }] },
        { prefix: "openai/", upstreams: [{ upstream: "openai", weight: 0 }, { upstream: "openrouter", weight: 1 }] },
        { prefix: "", upstreams: [{ upstream: "openrouter", weight: 0 }] },
      ],
      understand_routes: [{ prefix: "google/", upstreams: [{ upstream: "openrouter", weight: 0 }, { upstream: "google", weight: 1 }] }],
      vendor_ids: { "deepseek/deepseek-v4.1-flash-1017": { deepseek: "deepseek-flash" } },
      openrouter_backends: { "google/gemini-3.8-flash": { only: ["google-vertex"], allow_fallbacks: false } },
      prices: {
        "deepseek/deepseek-v4-pro": { input_cache_hit_per_mtok: 0.044, input_cache_miss_per_mtok: 1.32, output_per_mtok: 3.96 },
        "google/gemini-3.8-flash": { input_cache_miss_per_mtok: 0.5, output_per_mtok: 3 },
      },
    },
  };
}

/**
 * A provider over the fakes.
 * @param fakes - The fakes.
 * @param keys - The environment it reads keys from.
 * @param extra - Other options.
 * @returns The provider.
 */
export function llmProvider(
  fakes: LlmFakes,
  keys: Record<string, string>,
  extra: { llmMaxRetries?: number; cleanText?: (t: string) => string } = {},
): Provider {
  return createProvider({
    config: llmConfig(fakes),
    keyOf: (name) => keys[name],
    llmMaxRetries: extra.llmMaxRetries ?? 2,
    cleanText: extra.cleanText ?? ((t) => t),
  });
}

/**
 * Model requests a fake received: POSTs.
 * @param fake - The fake.
 * @returns Their bodies, in order.
 */
export function posted(fake: FakeUpstream): Record<string, unknown>[] {
  return fake.seen.filter((s) => s.method === "POST").map((s) => s.body as Record<string, unknown>);
}

/**
 * When a fake received each model request.
 * @param fake - The fake.
 * @returns The arrival times of its POSTs, in order.
 */
export function postedAt(fake: FakeUpstream): number[] {
  return fake.seen.filter((s) => s.method === "POST").map((s) => s.at);
}
