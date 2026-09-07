// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Where a model call goes, who gets charged for it, and how each vendor is
 * told to reason -- all three read the same routing table.
 *
 * The three used to be written out separately, and adding a provider meant
 * remembering all of them. What that produced is in the design for #202:
 * OpenRouter was reached through `createOpenAI`, which decides from the model
 * id whether a model reasons, and the default `deepseek/deepseek-v4-pro` is
 * not an id it knows -- so the reasoning option was dropped before the
 * request was built.
 *
 * The requests here are intercepted at the global fetch, which is what the
 * SDK reaches for when a provider is built without one. Asserting on the
 * request body is the only way to tell "asked for" from "meant to ask for":
 * a call that carried the options as far as `streamText` and no further looks
 * identical from the outside.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type * as CoreModule from "@breatic/core";
import type * as LlmModule from "@domain/agent/llm.js";
import type { generateText, LanguageModel } from "ai";
import { DIRECT_ROUTES, FALLBACK_ROUTE } from "@domain/agent/llm.js";

/** What this deployment has for each provider key, per test. */
const keys: { current: Record<string, string> } = vi.hoisted(() => ({ current: {} }));


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
    ) as unknown as typeof CoreModule.env,
  };
});

/** The last request the SDK handed to fetch. */
type Seen = {
  url: string;
  body: Record<string, unknown>;
  headers: Record<string, string>;
};

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

/** One answer in Anthropic's Messages shape. */
const MESSAGES_REPLY = {
  id: "msg_test",
  type: "message",
  role: "assistant",
  model: "claude-test",
  content: [{ type: "text", text: "ok" }],
  stop_reason: "end_turn",
  usage: { input_tokens: 11, output_tokens: 3 },
};

/** One answer in Gemini's generateContent shape. */
const GENERATE_CONTENT_REPLY = {
  candidates: [
    { content: { parts: [{ text: "ok" }], role: "model" }, finishReason: "STOP", index: 0 },
  ],
  usageMetadata: { promptTokenCount: 11, candidatesTokenCount: 3, totalTokenCount: 14 },
};

/**
 * Answers every model call and records what was asked.
 *
 * The reply shape follows the endpoint the caller chose. Answering them all in
 * one shape would make every assertion fail for the wrong reason: the request
 * would be refused while being parsed, and the test would report a schema
 * complaint rather than what was sent.
 *
 * Headers are recorded too, because which key a route authenticates with is a
 * separate fact from which key it routes on, and the two are written in
 * separate places.
 */
function interceptFetch(): void {
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    const address = String(url);
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((value, key) => {
      headers[key.toLowerCase()] = value;
    });
    seen = {
      url: address,
      body: init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {},
      headers,
    };
    const reply = address.includes(":generateContent")
      ? GENERATE_CONTENT_REPLY
      : address.endsWith("/messages")
        ? MESSAGES_REPLY
        : address.endsWith("/responses")
          ? RESPONSES_REPLY
          : CHAT_REPLY;
    return new Response(JSON.stringify(reply), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  });
}

/**
 * Loads a fresh copy of the routing module.
 *
 * The provider instances are module-level singletons that capture their key
 * when first built, so a test that changed a key would otherwise be answered
 * by the instance an earlier test built.
 * @returns The module's exports.
 */
async function freshLlm(): Promise<typeof LlmModule> {
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
  reasoning?: Parameters<typeof generateText>[0]["providerOptions"],
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
function selfReport(model: LanguageModel): string {
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

/**
 * Every route, from the boolean a caller passes to the bytes that leave.
 *
 * Three separate facts per row, and the whole chain has to be walked because
 * each one can be right while the next is wrong:
 *
 *   `on` / `off`         what `reasoningFor` hands back
 *   `onWire` / `offWire` what the vendor's SDK turns that into
 *   `authHeader`         which key the provider authenticates with
 *
 * The first two differ, and not cosmetically: DeepSeek's `reasoningEffort`
 * reaches the wire as `reasoning_effort`, Google's whole object is nested
 * under `generationConfig`, and OpenAI adds `summary` on its own. An
 * assertion that stopped at the first column would pass while an SDK
 * upgrade renamed a namespace and quietly stopped asking for anything --
 * which is the bug this change exists to remove.
 *
 * The third is here because a route names its key twice, in two places
 * nothing ties together: once to route on, once to build the provider with.
 *
 * Written as literals rather than read off the table: a test that asks the
 * table what the table says holds nothing in place.
 */
const SPELLINGS = [
  {
    model: "deepseek/deepseek-v4-pro",
    key: "DEEPSEEK_API_KEY",
    name: "deepseek",
    authHeader: "authorization",
    authPrefix: "Bearer ",
    on: { thinking: { type: "enabled" }, reasoningEffort: "high" },
    off: { thinking: { type: "disabled" } },
    onWire: { thinking: { type: "enabled" }, reasoning_effort: "high" },
    offWire: { thinking: { type: "disabled" } },
  },
  {
    model: "anthropic/claude-sonnet-4-6",
    key: "ANTHROPIC_API_KEY",
    name: "anthropic",
    authHeader: "x-api-key",
    authPrefix: "",
    on: { thinking: { type: "adaptive", display: "summarized" } },
    off: { thinking: { type: "disabled" } },
    onWire: { thinking: { type: "adaptive", display: "summarized" } },
    offWire: { thinking: { type: "disabled" } },
  },
  {
    model: "google/gemini-2.5-flash",
    key: "GOOGLE_API_KEY",
    name: "google",
    authHeader: "x-goog-api-key",
    authPrefix: "",
    on: { thinkingConfig: { thinkingBudget: -1, includeThoughts: true } },
    off: { thinkingConfig: { thinkingBudget: 0 } },
    onWire: { generationConfig: { thinkingConfig: { thinkingBudget: -1, includeThoughts: true } } },
    offWire: { generationConfig: { thinkingConfig: { thinkingBudget: 0 } } },
  },
  {
    // An id the SDK recognises as one that reasons. `@ai-sdk/openai` decides
    // that from the id and drops the option for anything else, so an invented
    // id here would assert that nothing is sent.
    model: "openai/gpt-5",
    key: "OPENAI_API_KEY",
    name: "openai",
    authHeader: "authorization",
    authPrefix: "Bearer ",
    on: { reasoningEffort: "high" },
    off: { reasoningEffort: "none" },
    onWire: { reasoning: { effort: "high", summary: "detailed" } },
    offWire: { reasoning: { effort: "none" } },
  },
  {
    model: "meta/llama-4",
    key: "OPENROUTER_API_KEY",
    name: "openrouter",
    authHeader: "authorization",
    authPrefix: "Bearer ",
    on: { reasoning: { effort: "high" } },
    off: { reasoning: { effort: "none" } },
    onWire: { reasoning: { effort: "high" } },
    offWire: { reasoning: { effort: "none" } },
  },
] as const;

describe("reasoningFor", () => {
  it.each(SPELLINGS)(
    "spells $name's on and off the way $name takes them",
    async ({ model, key, name, on, off }) => {
      keys.current = { [key]: "k" };
      const { reasoningFor } = await freshLlm();
      expect(reasoningFor(model, true).providerOptions).toEqual({ [name]: on });
      expect(reasoningFor(model, false).providerOptions).toEqual({ [name]: off });
    },
  );

  it("takes the fallback when the caller has no model to name", async () => {
    keys.current = { OPENROUTER_API_KEY: "sk-or-test" };
    const { reasoningFor } = await freshLlm();
    expect(reasoningFor(undefined, true).providerOptions).toEqual({
      openrouter: { reasoning: { effort: "high" } },
    });
  });
});

describe("what each route actually sends", () => {
  /**
   * Runs one turn on a route with its key set, and hands back the request.
   * @param spelling - The row under test.
   * @param thinking - Which direction to ask for.
   * @returns The intercepted request.
   */
  async function send(
    spelling: (typeof SPELLINGS)[number],
    thinking: boolean,
  ): Promise<Seen> {
    keys.current = { [spelling.key]: `REAL-${spelling.name}` };
    const { getModel, reasoningFor } = await freshLlm();
    const { generateText } = await import("ai");
    seen = undefined;
    await generateText({
      model: getModel(spelling.model),
      prompt: "hi",
      ...reasoningFor(spelling.model, thinking),
    });
    if (!seen) throw new Error(`${spelling.name} made no request`);
    return seen;
  }

  it.each(SPELLINGS)("puts $name's reasoning request on the wire", async (spelling) => {
    expect((await send(spelling, true)).body).toMatchObject(spelling.onWire);
    expect((await send(spelling, false)).body).toMatchObject(spelling.offWire);
  });

  // The one asymmetric pair: DeepSeek's effort level rides along with the on
  // position and has no counterpart in the off one, so `toMatchObject` above
  // cannot see it going missing.
  it("drops DeepSeek's effort level when reasoning is turned off", async () => {
    const spelling = SPELLINGS.find((s) => s.name === "deepseek");
    if (!spelling) throw new Error("the deepseek row is gone");
    expect((await send(spelling, false)).body["reasoning_effort"]).toBeUndefined();
  });

  it.each(SPELLINGS)(
    "authenticates $name with the key its own row names",
    async (spelling) => {
      const req = await send(spelling, true);
      expect(req.headers[spelling.authHeader]).toBe(
        `${spelling.authPrefix}REAL-${spelling.name}`,
      );
    },
  );
});

/**
 * Every route in the table, whatever is in it.
 *
 * Driven off the export rather than a hand-written list: a list here would be
 * the fifth copy of the table, and the fifth copy is what this change exists
 * to delete. A route added to `llm.ts` and not to a list here would be
 * covered by nothing -- which is where `openai/` already stood.
 *
 * The prefixes and key names are literals, identical in every instance the
 * module loader hands out, so listing them from the statically-imported copy
 * is safe while each case still asserts against a freshly-loaded one.
 */
describe("the table is what every consumer reads", () => {
  it.each(DIRECT_ROUTES)("routes and charges $name alike", async ({ prefix, keyName, name }) => {
    keys.current = { [keyName]: "k", OPENROUTER_API_KEY: "sk-or-test" };
    const { getModel, resolveProvider } = await freshLlm();
    expect(resolveProvider(`${prefix}x`)).toBe(name);
    expect(selfReport(getModel(`${prefix}x`))).toMatch(new RegExp(`^${name}`));
  });

  it.each(DIRECT_ROUTES)("falls $name back to OpenRouter with no key", async ({ prefix }) => {
    keys.current = { OPENROUTER_API_KEY: "sk-or-test" };
    const { getModel, resolveProvider } = await freshLlm();
    expect(resolveProvider(`${prefix}x`)).toBe(FALLBACK_ROUTE.name);
    expect(selfReport(getModel(`${prefix}x`))).toMatch(/^openrouter/);
  });

  it("has a spelling case above for every route it holds", () => {
    const spelled = SPELLINGS.map((s) => s.name).sort();
    const inTable = [...DIRECT_ROUTES.map((r) => r.name), FALLBACK_ROUTE.name].sort();
    expect(spelled).toEqual(inTable);
  });
});

