// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Where an LLM call goes and how each vendor is asked to reason, cache and
 * sample, read off the requests that reach each fake vendor (moved from
 * domain's `agent/__tests__/llm.test.ts`, design 13.1). Asserting on the
 * request body is the only way to tell "asked for" from "meant to ask for".
 */

import { generateText } from "ai";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { NoUpstreamAvailable } from "../../errors.js";
import type { CallWants, SystemParts } from "../api.js";
import { llmProvider, posted, startFakes, stopFakes, type LlmFakes } from "./llm-harness.js";

let fakes: LlmFakes;

beforeEach(async () => {
  fakes = await startFakes();
});

afterEach(async () => {
  await stopFakes(fakes);
});

const OFF: CallWants = { thinking: false, cache: false };

/**
 * Run one call and answer the request the vendor received.
 * @param keys - The deployment's keys.
 * @param model - Our model id.
 * @param wants - What the call asks for.
 * @param system - The system prompt parts, if any.
 * @returns Which fake received it, its path, body and headers.
 */
async function call(
  keys: Record<string, string>,
  model: string,
  wants: CallWants = OFF,
  system?: SystemParts,
): Promise<{ vendor: keyof LlmFakes; path: string; body: Record<string, unknown>; headers: Record<string, string> }> {
  const prepared = llmProvider(fakes, keys).llm.prepare(model, wants);
  await generateText({
    model: prepared.model,
    ...(system ? { system: prepared.system(system) } : {}),
    prompt: "hi",
    ...prepared.options,
  });
  for (const vendor of Object.keys(fakes) as (keyof LlmFakes)[]) {
    const request = fakes[vendor].seen.find((s) => s.method === "POST");
    if (request) return { vendor, path: request.path, body: request.body as Record<string, unknown>, headers: request.headers };
  }
  throw new Error("no request was made");
}

describe("routing", () => {
  it("posts to OpenRouter's chat completions when only OpenRouter has a key", async () => {
    const req = await call({ OPENROUTER_API_KEY: "or" }, "deepseek/deepseek-v4-pro");
    expect(req.vendor).toBe("openrouter");
    expect(req.path).toBe("/api/v1/chat/completions");
    expect(req.body.model).toBe("deepseek/deepseek-v4-pro");
  });

  it("posts to DeepSeek directly when its key is configured, with the vendor's own id", async () => {
    const req = await call({ DEEPSEEK_API_KEY: "ds", OPENROUTER_API_KEY: "or" }, "deepseek/deepseek-v4-pro");
    expect(req.vendor).toBe("deepseek");
    expect(req.path).toBe("/chat/completions");
    expect(req.body.model).toBe("deepseek-v4-pro");
  });

  it.each([
    ["anthropic/claude-x", "ANTHROPIC_API_KEY", "anthropic"],
    ["deepseek/x", "DEEPSEEK_API_KEY", "deepseek"],
    ["google/x", "GOOGLE_API_KEY", "google"],
    ["openai/gpt-5", "OPENAI_API_KEY", "openai"],
  ] as const)("routes %s to its direct vendor with the key, and to OpenRouter without it", async (model, key, vendor) => {
    expect((await call({ [key]: "k", OPENROUTER_API_KEY: "or" }, model)).vendor).toBe(vendor);
    await stopFakes(fakes);
    fakes = await startFakes();
    expect((await call({ OPENROUTER_API_KEY: "or" }, model)).vendor).toBe("openrouter");
  });

  it("throws NoUpstreamAvailable naming every missing key when no route upstream has one", () => {
    expect(() => llmProvider(fakes, {}).llm.prepare("deepseek/deepseek-v4-pro", OFF)).toThrow(NoUpstreamAvailable);
  });

  it("goes only to the named upstream in upstream mode", async () => {
    const prepared = llmProvider(fakes, { DEEPSEEK_API_KEY: "ds", OPENROUTER_API_KEY: "or" }).llm.prepare("deepseek/deepseek-v4-pro", OFF, {
      mode: "upstream",
      upstream: "openrouter",
    });
    await generateText({ model: prepared.model, prompt: "hi", ...prepared.options });
    expect(posted(fakes.deepseek)).toHaveLength(0);
    expect(posted(fakes.openrouter)).toHaveLength(1);
  });
});

describe("the ids each vendor serves", () => {
  it("sends the hyphenated id Anthropic serves for a dotted version, and the dotted one to OpenRouter", async () => {
    expect((await call({ ANTHROPIC_API_KEY: "k" }, "anthropic/claude-opus-5.5")).body.model).toBe("claude-opus-5-5");
    await stopFakes(fakes);
    fakes = await startFakes();
    expect((await call({ OPENROUTER_API_KEY: "or" }, "anthropic/claude-opus-5.5")).body.model).toBe("anthropic/claude-opus-5.5");
  });

  it("leaves an Anthropic id that is already hyphenated as it is", async () => {
    expect((await call({ ANTHROPIC_API_KEY: "k" }, "anthropic/claude-sonnet-4-6")).body.model).toBe("claude-sonnet-4-6");
  });

  it("sends the name DeepSeek serves Flash 1017 under, and the pinned id to OpenRouter", async () => {
    expect((await call({ DEEPSEEK_API_KEY: "k" }, "deepseek/deepseek-v4.1-flash-1017")).body.model).toBe("deepseek-flash");
    await stopFakes(fakes);
    fakes = await startFakes();
    expect((await call({ OPENROUTER_API_KEY: "or" }, "deepseek/deepseek-v4.1-flash-1017")).body.model).toBe("deepseek/deepseek-v4.1-flash-1017");
  });
});

/**
 * Every route, from the boolean a caller passes to the bytes that leave, and
 * the key it authenticates with. Literals, never read off the routing table.
 */
const SPELLINGS = [
  {
    model: "deepseek/deepseek-v4-pro",
    key: "DEEPSEEK_API_KEY",
    name: "deepseek",
    authHeader: "authorization",
    authPrefix: "Bearer ",
    onWire: { thinking: { type: "enabled" }, reasoning_effort: "max" },
    offWire: { thinking: { type: "disabled" } },
  },
  {
    model: "anthropic/claude-sonnet-4-6",
    key: "ANTHROPIC_API_KEY",
    name: "anthropic",
    authHeader: "x-api-key",
    authPrefix: "",
    onWire: { thinking: { type: "adaptive", display: "summarized" }, output_config: { effort: "high" } },
    offWire: {},
  },
  {
    model: "google/gemini-2.5-flash",
    key: "GOOGLE_API_KEY",
    name: "google",
    authHeader: "x-goog-api-key",
    authPrefix: "",
    onWire: { generationConfig: { thinkingConfig: { thinkingBudget: -1, includeThoughts: true } } },
    offWire: { generationConfig: { thinkingConfig: { thinkingBudget: 0 } } },
  },
  {
    model: "openai/gpt-5",
    key: "OPENAI_API_KEY",
    name: "openai",
    authHeader: "authorization",
    authPrefix: "Bearer ",
    onWire: { reasoning: { effort: "high", summary: "detailed" } },
    offWire: { reasoning: { effort: "none" } },
  },
  {
    model: "meta/llama-4",
    key: "OPENROUTER_API_KEY",
    name: "openrouter",
    authHeader: "authorization",
    authPrefix: "Bearer ",
    onWire: { reasoning: { effort: "high" } },
    offWire: { reasoning: { effort: "none" } },
  },
] as const;

describe("what each route sends for thinking", () => {
  it.each(SPELLINGS)("puts $name's reasoning request on the wire, on and off", async (spelling) => {
    expect((await call({ [spelling.key]: `REAL-${spelling.name}` }, spelling.model, { thinking: true, cache: false })).body).toMatchObject(spelling.onWire);
    await stopFakes(fakes);
    fakes = await startFakes();
    expect((await call({ [spelling.key]: `REAL-${spelling.name}` }, spelling.model, OFF)).body).toMatchObject(spelling.offWire);
  });

  it("drops DeepSeek's effort level when reasoning is turned off", async () => {
    expect((await call({ DEEPSEEK_API_KEY: "k" }, "deepseek/deepseek-v4-pro", OFF)).body.reasoning_effort).toBeUndefined();
  });

  it.each(SPELLINGS)("authenticates $name with its own key", async (spelling) => {
    const req = await call({ [spelling.key]: `REAL-${spelling.name}` }, spelling.model, { thinking: true, cache: false });
    expect(req.headers[spelling.authHeader]).toBe(`${spelling.authPrefix}REAL-${spelling.name}`);
  });

  // inner#1650 measured DeepSeek Flash 1017 at `max` and Claude at `high`.
  it.each([
    ["deepseek/deepseek-v4.1-flash-1017", "max"],
    ["anthropic/claude-opus-5.5", "high"],
  ])("asks OpenRouter for %s to think at %s", async (model, effort) => {
    expect((await call({ OPENROUTER_API_KEY: "or" }, model, { thinking: true, cache: false })).body.reasoning).toEqual({ effort });
  });

  it("leaves the thinking field out for Claude not asked to think, directly and through OpenRouter", async () => {
    expect((await call({ ANTHROPIC_API_KEY: "k" }, "anthropic/claude-opus-5.5", OFF)).body.thinking).toBeUndefined();
    await stopFakes(fakes);
    fakes = await startFakes();
    expect((await call({ OPENROUTER_API_KEY: "or" }, "anthropic/claude-opus-5.5", OFF)).body.reasoning).toBeUndefined();
  });
});

describe("prompt caching", () => {
  it("asks Anthropic directly for automatic caching, with the one-hour lifetime when asked", async () => {
    expect((await call({ ANTHROPIC_API_KEY: "k" }, "anthropic/claude-opus-5.5", { thinking: true, cache: "5m" })).body.cache_control).toEqual({ type: "ephemeral" });
    await stopFakes(fakes);
    fakes = await startFakes();
    expect((await call({ ANTHROPIC_API_KEY: "k" }, "anthropic/claude-opus-5.5", { thinking: true, cache: "1h" })).body.cache_control).toEqual({ type: "ephemeral", ttl: "1h" });
  });

  it("asks OpenRouter for automatic caching on a Claude model", async () => {
    expect((await call({ OPENROUTER_API_KEY: "or" }, "anthropic/claude-opus-5.5", { thinking: true, cache: "5m" })).body.cache_control).toEqual({ type: "ephemeral" });
  });

  it("sends nothing about caching for a model that caches a prefix on its own, or when not asked", async () => {
    expect((await call({ OPENROUTER_API_KEY: "or" }, "deepseek/deepseek-v4-pro", { thinking: true, cache: "5m" })).body.cache_control).toBeUndefined();
    await stopFakes(fakes);
    fakes = await startFakes();
    expect((await call({ ANTHROPIC_API_KEY: "k" }, "anthropic/claude-opus-5.5", { thinking: true, cache: false })).body.cache_control).toBeUndefined();
  });

  it.each(["anthropic/claude-opus-5.5", "deepseek/deepseek-v4-pro"])("pins a conversation through OpenRouter to one backend, %s", async (model) => {
    expect((await call({ OPENROUTER_API_KEY: "or" }, model, { thinking: true, cache: "1h", session: "conv-1" })).body.session_id).toBe("conv-1");
  });

  it("sends no session id to a vendor reached directly", async () => {
    expect((await call({ ANTHROPIC_API_KEY: "k" }, "anthropic/claude-opus-5.5", { thinking: true, cache: "1h", session: "conv-1" })).body.session_id).toBeUndefined();
  });
});

describe("the system prompt in parts", () => {
  const PARTS = { base: "persona", project: "project memory", conversation: "this conversation's memory" };
  const ONE_HOUR = { type: "ephemeral", ttl: "1h" };
  const WHOLE = `${PARTS.base}\n\n${PARTS.project}\n\n${PARTS.conversation}`;
  const systemMessages = (body: Record<string, unknown>): unknown[] =>
    (body.messages as { role: string }[]).filter((m) => m.role === "system");

  it("marks the end of the base prompt and of the project's memory when calling Anthropic directly", async () => {
    expect((await call({ ANTHROPIC_API_KEY: "k" }, "anthropic/claude-opus-5.5", { thinking: true, cache: "1h" }, PARTS)).body.system).toEqual([
      { type: "text", text: PARTS.base, cache_control: ONE_HOUR },
      { type: "text", text: PARTS.project, cache_control: ONE_HOUR },
      { type: "text", text: PARTS.conversation },
    ]);
  });

  it("marks the same two ends when reaching Claude through OpenRouter", async () => {
    expect(systemMessages((await call({ OPENROUTER_API_KEY: "or" }, "anthropic/claude-opus-5.5", { thinking: true, cache: "1h" }, PARTS)).body)).toEqual([
      { role: "system", content: [{ type: "text", text: PARTS.base, cache_control: ONE_HOUR }] },
      { role: "system", content: [{ type: "text", text: PARTS.project, cache_control: ONE_HOUR }] },
      { role: "system", content: [{ type: "text", text: PARTS.conversation }] },
    ]);
  });

  it("sends only the base prompt, marked, when there is no memory", async () => {
    expect((await call({ ANTHROPIC_API_KEY: "k" }, "anthropic/claude-opus-5.5", { thinking: true, cache: "1h" }, { base: PARTS.base })).body.system).toEqual([
      { type: "text", text: PARTS.base, cache_control: ONE_HOUR },
    ]);
  });

  it("goes from the marked base prompt straight to the conversation's memory when the project has none", async () => {
    const parts = { base: PARTS.base, conversation: PARTS.conversation };
    expect((await call({ ANTHROPIC_API_KEY: "k" }, "anthropic/claude-opus-5.5", { thinking: true, cache: "1h" }, parts)).body.system).toEqual([
      { type: "text", text: PARTS.base, cache_control: ONE_HOUR },
      { type: "text", text: PARTS.conversation },
    ]);
  });

  it("sends the prompt whole, as one message, for a model that caches a prefix on its own", async () => {
    expect(systemMessages((await call({ OPENROUTER_API_KEY: "or" }, "deepseek/deepseek-v4-pro", { thinking: true, cache: "1h" }, PARTS)).body)).toEqual([
      { role: "system", content: [{ type: "text", text: WHOLE }] },
    ]);
  });

  it("sends the prompt whole, as one block, when the caller does not ask for caching", async () => {
    expect((await call({ ANTHROPIC_API_KEY: "k" }, "anthropic/claude-opus-5.5", OFF, PARTS)).body.system).toEqual([{ type: "text", text: WHOLE }]);
  });
});

describe("the temperature a call asks for", () => {
  const AT_ZERO: CallWants = { thinking: false, cache: false, temperature: 0 };

  it("reaches a model that takes it", async () => {
    expect((await call({ OPENROUTER_API_KEY: "or" }, "deepseek/deepseek-v4-pro", AT_ZERO)).body.temperature).toBe(0);
  });

  it("is left out for Claude, directly and through OpenRouter", async () => {
    expect((await call({ ANTHROPIC_API_KEY: "k" }, "anthropic/claude-opus-5.5", AT_ZERO)).body.temperature).toBeUndefined();
    await stopFakes(fakes);
    fakes = await startFakes();
    expect((await call({ OPENROUTER_API_KEY: "or" }, "anthropic/claude-opus-5.5", AT_ZERO)).body.temperature).toBeUndefined();
  });
});
