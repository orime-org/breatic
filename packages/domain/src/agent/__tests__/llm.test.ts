// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Where a model call goes, who gets charged for it, and how each vendor is
 * told to reason -- all three read the same routing table.
 *
 * The three used to be written out separately, and adding a provider meant
 * remembering all of them. What that produced is in the design for #202: the
 * default model `deepseek/deepseek-v4-pro` matched no direct prefix and fell
 * through to OpenRouter, while the reasoning switch addressed a provider name
 * that the OpenRouter instance never answered to.
 *
 * The requests here are intercepted at the global fetch, which is what the
 * SDK reaches for when a provider is built without one. Asserting on the
 * request body is the only way to tell "asked for" from "meant to ask for":
 * a call that carried the options as far as `streamText` and no further looks
 * identical from the outside.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type * as CoreModule from "@breatic/core";

/** What this deployment has for each provider key, per test. */
const keys = vi.hoisted(() => ({ current: {} as Record<string, string> }));

vi.mock("@breatic/core", async (importOriginal) => {
  const actual = await importOriginal<typeof CoreModule>();
  return {
    ...actual,
    // The `env` proxy, because that is what `llm.ts` reads. Every key
    // defaults to `""` in the real schema, so an absent key reads falsy
    // rather than throwing -- the fallback to OpenRouter depends on it.
    env: new Proxy(
      {},
      { get: (_t, name: string) => keys.current[name] ?? "" },
    ) as typeof CoreModule.env,
  };
});

/** The last request the SDK handed to fetch. */
type Seen = { url: string; body: Record<string, unknown> };

let seen: Seen | undefined;
let realFetch: typeof globalThis.fetch;

/**
 * A chat completion, carrying the cost fields OpenRouter adds to one.
 */
const CHAT_REPLY = {
  id: "gen-test",
  provider: "DeepSeek",
  model: "deepseek/deepseek-v4-pro",
  object: "chat.completion",
  created: 1,
  choices: [
    { index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" },
  ],
  usage: {
    prompt_tokens: 11,
    completion_tokens: 3,
    total_tokens: 14,
    cost: 0.000136764,
    cost_details: { upstream_inference_cost: 0.0001 },
  },
};

/**
 * The same answer in the shape the Responses API returns.
 */
const RESPONSES_REPLY = {
  id: "resp_test",
  object: "response",
  created_at: 1,
  model: "deepseek/deepseek-v4-pro",
  status: "completed",
  output: [
    {
      type: "message",
      id: "m1",
      role: "assistant",
      status: "completed",
      content: [{ type: "output_text", text: "ok", annotations: [] }],
    },
  ],
  usage: { input_tokens: 11, output_tokens: 3, total_tokens: 14 },
};

/**
 * Answers every model call and records what was asked.
 *
 * The reply shape follows the endpoint the caller chose. Answering both in
 * one shape would make every endpoint assertion fail for the wrong reason:
 * the request would be refused while being parsed, and the test would report
 * a schema complaint rather than the address it was sent to.
 */
function interceptFetch(): void {
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    const address = String(url);
    seen = {
      url: address,
      body: init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {},
    };
    const reply = address.endsWith("/responses") ? RESPONSES_REPLY : CHAT_REPLY;
    return new Response(JSON.stringify(reply), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof globalThis.fetch;
}

/**
 * Loads a fresh copy of the routing module.
 *
 * The provider instances are module-level singletons that capture their key
 * when first built, so a test that changed a key would otherwise be answered
 * by the instance an earlier test built.
 * @returns The module's exports.
 */
async function freshLlm(): Promise<typeof import("@domain/agent/llm.js")> {
  vi.resetModules();
  return import("@domain/agent/llm.js");
}

/**
 * Runs one turn against the given model id and returns what went out.
 * @param modelString - The model id to route.
 * @param reasoning - Provider options to send, if any.
 * @returns The intercepted request.
 */
async function callWith(
  modelString: string,
  reasoning?: Parameters<typeof import("ai").generateText>[0]["providerOptions"],
): Promise<Seen> {
  const { getModel } = await freshLlm();
  const { generateText } = await import("ai");
  seen = undefined;
  await generateText({
    model: getModel(modelString),
    prompt: "hi",
    ...(reasoning ? { providerOptions: reasoning } : {}),
  });
  if (!seen) throw new Error("no request was made");
  return seen;
}

/**
 * What a built model calls its own provider.
 *
 * `LanguageModel` is a union of an id string and the object form; only the
 * object carries the name, and every route here returns the object.
 * @param model - A model the table built.
 * @returns Its self-reported provider name.
 */
function selfReport(model: import("ai").LanguageModel): string {
  return typeof model === "string" ? model : model.provider;
}

beforeEach(() => {
  keys.current = {};
  seen = undefined;
  realFetch = globalThis.fetch;
  interceptFetch();
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

describe("the OpenRouter fallback", () => {
  beforeEach(() => {
    keys.current = { OPENROUTER_API_KEY: "sk-or-test" };
  });

  it("posts to the chat completions endpoint", async () => {
    const req = await callWith("deepseek/deepseek-v4-pro");
    expect(req.url).toBe("https://openrouter.ai/api/v1/chat/completions");
  });

  it("hands back the cost the upstream charged", async () => {
    const { getModel } = await freshLlm();
    const { generateText } = await import("ai");
    const result = await generateText({
      model: getModel("deepseek/deepseek-v4-pro"),
      prompt: "hi",
    });
    expect(result.providerMetadata?.openrouter?.usage).toMatchObject({
      cost: 0.000136764,
    });
  });

  it("carries the reasoning request under its own key", async () => {
    const req = await callWith("deepseek/deepseek-v4-pro", {
      openrouter: { reasoning: { effort: "high" } },
    });
    expect(req.body.reasoning).toEqual({ effort: "high" });
  });
});

describe("the DeepSeek direct route", () => {
  it("posts to DeepSeek when the key is configured", async () => {
    // No `/v1`: the provider's own default is `https://api.deepseek.com`
    // (`@ai-sdk/deepseek@3.0.39` dist/index.js:1396) and the path is
    // appended to it. The vendor answers on both, so writing the other one
    // here would have passed against a live endpoint while saying something
    // untrue about what this build sends.
    keys.current = { DEEPSEEK_API_KEY: "sk-ds-test", OPENROUTER_API_KEY: "sk-or-test" };
    const req = await callWith("deepseek/deepseek-v4-pro");
    expect(req.url).toBe("https://api.deepseek.com/chat/completions");
  });

  it("strips the prefix so the vendor sees its own id", async () => {
    keys.current = { DEEPSEEK_API_KEY: "sk-ds-test" };
    const req = await callWith("deepseek/deepseek-v4-pro");
    expect(req.body.model).toBe("deepseek-v4-pro");
  });

  it("falls back to OpenRouter with no DeepSeek key", async () => {
    keys.current = { OPENROUTER_API_KEY: "sk-or-test" };
    const req = await callWith("deepseek/deepseek-v4-pro");
    expect(req.url).toBe("https://openrouter.ai/api/v1/chat/completions");
  });

  it("carries the reasoning request the way DeepSeek takes it", async () => {
    keys.current = { DEEPSEEK_API_KEY: "sk-ds-test" };
    const req = await callWith("deepseek/deepseek-v4-pro", {
      deepseek: { thinking: { type: "enabled" } },
    });
    expect(req.body.thinking).toEqual({ type: "enabled" });
  });
});

describe("reasoningFor", () => {
  /** Every route, plus the fallback, and the key each one answers to. */
  const CASES = [
    { model: "deepseek/x", key: "DEEPSEEK_API_KEY", name: "deepseek" },
    { model: "anthropic/x", key: "ANTHROPIC_API_KEY", name: "anthropic" },
    { model: "google/x", key: "GOOGLE_API_KEY", name: "google" },
    { model: "openai/x", key: "OPENAI_API_KEY", name: "openai" },
    { model: "meta/x", key: "OPENROUTER_API_KEY", name: "openrouter" },
  ] as const;

  it.each(CASES)("addresses $name when asked to reason", async ({ model, key, name }) => {
    keys.current = { [key]: "k" };
    const { reasoningFor } = await freshLlm();
    const options = reasoningFor(model, true).providerOptions;
    expect(Object.keys(options ?? {})).toEqual([name]);
  });

  it.each(CASES)("addresses $name when asked not to", async ({ model, key, name }) => {
    keys.current = { [key]: "k" };
    const { reasoningFor } = await freshLlm();
    const options = reasoningFor(model, false).providerOptions;
    expect(Object.keys(options ?? {})).toEqual([name]);
  });

  it("says something in both directions, for every provider", async () => {
    for (const { model, key } of CASES) {
      keys.current = { [key]: "k" };
      const { reasoningFor } = await freshLlm();
      for (const asked of [true, false]) {
        const options = reasoningFor(model, asked).providerOptions;
        const only = Object.values(options ?? {})[0];
        expect(Object.keys(only ?? {}).length).toBeGreaterThan(0);
      }
    }
  });
});

describe("the table is what every consumer reads", () => {
  const ROUTES = [
    { prefix: "deepseek/", key: "DEEPSEEK_API_KEY", name: "deepseek" },
    { prefix: "anthropic/", key: "ANTHROPIC_API_KEY", name: "anthropic" },
    { prefix: "google/", key: "GOOGLE_API_KEY", name: "google" },
    { prefix: "openai/", key: "OPENAI_API_KEY", name: "openai" },
  ] as const;

  it.each(ROUTES)("routes and charges $name alike", async ({ prefix, key, name }) => {
    keys.current = { [key]: "k", OPENROUTER_API_KEY: "sk-or-test" };
    const { getModel, resolveProvider } = await freshLlm();
    expect(resolveProvider(`${prefix}x`)).toBe(name);
    expect(selfReport(getModel(`${prefix}x`))).toMatch(new RegExp(`^${name}`));
  });

  it.each(ROUTES)("falls $name back to OpenRouter with no key", async ({ prefix }) => {
    keys.current = { OPENROUTER_API_KEY: "sk-or-test" };
    const { getModel, resolveProvider } = await freshLlm();
    expect(resolveProvider(`${prefix}x`)).toBe("openrouter");
    expect(selfReport(getModel(`${prefix}x`))).toMatch(/^openrouter/);
  });
});
