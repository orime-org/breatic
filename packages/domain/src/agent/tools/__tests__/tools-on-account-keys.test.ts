// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The Agent's model-calling tools on the turn's keys (inner#1953): whether `understand_media` and `judge_likelihood`
 * are offered is judged on the key set the turn runs on, so a deployment without an OpenRouter key still offers them
 * to a Studio whose payer filled one, and each call goes out on that key set and no other.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import type * as coreModule from "@breatic/core";
import type * as understandModule from "@domain/understand/index.js";

const ACCOUNT = { owner: "account" as const, keyOf: (upstream: string) => (upstream === "openrouter" ? "sk-or-v1-account" : undefined) };

const h = vi.hoisted(() => ({
  judge: vi.fn(),
  availability: vi.fn(),
  judgeAvailability: vi.fn(),
  understandMediaAt: vi.fn(),
}));

vi.mock("@domain/understand/index.js", async (importOriginal) => {
  const actual = await importOriginal<typeof understandModule>();
  return { ...actual, understandMediaAt: (...args: unknown[]) => h.understandMediaAt(...args) };
});

vi.mock("@domain/provider/instance.js", () => ({
  initProvider: () => undefined,
  provider: () => ({ llm: { judge: h.judge, availability: h.availability, judgeAvailability: h.judgeAvailability } }),
}));

vi.mock("@breatic/core", async (importOriginal) => {
  const actual = await importOriginal<typeof coreModule>();
  return { ...actual, env: new Proxy({}, { get: () => undefined }) };
});

const { buildToolSet } = await import("@domain/agent/tools/index.js");
const { JUDGE_LIKELIHOOD, UNDERSTAND_MEDIA } = await import("@domain/agent/tools/tool-names.js");
const { toolOptions } = await import("@domain/agent/__tests__/helpers/usage-spy.js");

/**
 * Upstreams as provider answers them: configured only on the account's key set.
 * @param keys - The key set asked about, if any.
 * @returns The answer.
 */
const onAccountOnly = (keys?: { owner?: string }): { upstreams: Array<Record<string, unknown>> } => ({
  upstreams: [{ upstream: "openrouter", weight: 0, configured: keys?.owner === "account", envVar: "OPENROUTER_API_KEY" }],
});

beforeEach(() => {
  vi.clearAllMocks();
  h.availability.mockImplementation((_model: string, _use: string, keys?: { owner?: string }) => onAccountOnly(keys));
  h.judgeAvailability.mockImplementation((keys?: { owner?: string }) => onAccountOnly(keys));
  h.judge.mockResolvedValue({ status: 200, body: JSON.stringify({ likely: { type: "noul", noul: 0.5 } }), cost: { state: "known", usd: 0.001, source: "reported" }, upstream: "openrouter", model: "typesafe/jev-1.13" });
  h.understandMediaAt.mockResolvedValue({ text: "A dog.", finishReason: "stop", kind: "image" });
});

describe("which model-calling tools a turn is offered", () => {
  it("offers understand_media and judge_likelihood on the payer's key where the deployment has none", () => {
    const tools = buildToolSet([UNDERSTAND_MEDIA, JUDGE_LIKELIHOOD], { keys: ACCOUNT } as never);

    expect(Object.keys(tools).sort()).toEqual([JUDGE_LIKELIHOOD, UNDERSTAND_MEDIA].sort());
    expect(h.availability).toHaveBeenCalledWith(expect.any(String), "understand", ACCOUNT);
    expect(h.judgeAvailability).toHaveBeenCalledWith(ACCOUNT);
  });

  it("leaves both out on the deployment's keys when the deployment has none", () => {
    expect(Object.keys(buildToolSet([UNDERSTAND_MEDIA, JUDGE_LIKELIHOOD]))).toEqual([]);
  });
});

describe("a model-calling tool's call", () => {
  beforeEach(() => {
    // Offered whatever the keys, so these cases are about the call alone.
    h.availability.mockReturnValue({ upstreams: [{ upstream: "openrouter", weight: 0, configured: true, envVar: "OPENROUTER_API_KEY" }] });
    h.judgeAvailability.mockReturnValue({ upstreams: [{ upstream: "openrouter", weight: 0, configured: true, envVar: "OPENROUTER_API_KEY" }] });
  });

  it("judge_likelihood asks on the turn's key set", async () => {
    const tool = buildToolSet([JUDGE_LIKELIHOOD], { keys: ACCOUNT } as never)[JUDGE_LIKELIHOOD];
    await tool?.execute?.({ state: { said: "hi" }, questions: { likely: { type: "noul", instructions: "Likely?" } } }, toolOptions() as never)?.catch(() => undefined);

    expect(h.judge).toHaveBeenCalledTimes(1);
    expect(h.judge.mock.calls[0]?.[2]).toBe(ACCOUNT);
  });

  it("understand_media reads on the turn's key set", async () => {
    const tool = buildToolSet([UNDERSTAND_MEDIA], { keys: ACCOUNT } as never)[UNDERSTAND_MEDIA];
    await tool?.execute?.({ items: [{ url: "https://example.com/dog.jpg" }], question: "What is this?" }, toolOptions() as never)?.catch(() => undefined);

    expect(h.understandMediaAt).toHaveBeenCalledWith(expect.objectContaining({ keys: ACCOUNT }));
  });
});
