// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { describe, it, expect } from "vitest";
import { tool } from "ai";
import type { ModelMessage, UIMessage } from "ai";
import { z } from "zod";
import type { ToolFailure } from "@breatic/shared";

import { inProgressStep, noteUsage, replyTokens } from "@server/agent/reply-for-model.js";

const tools = {
  web_search: tool({
    description: "Search the web.",
    inputSchema: z.object({ query: z.string() }),
    toModelOutput: ({ output }) => ({ type: "text", value: `model sees ${String(output)}` }),
  }),
};

type Parts = UIMessage["parts"];

const NOTHING_SETTLED = { answered: new Map<string, unknown>(), ended: new Map<string, ToolFailure>() };

/** A first step that finished with prose, then a second the turn stopped inside. */
const TWO_STEPS: Parts = [
  { type: "step-start" },
  { type: "text", text: "Looking.", state: "done" },
  { type: "step-start" },
  { type: "reasoning", text: "half a thought", state: "streaming" },
  { type: "text", text: "Here is what I fou", state: "streaming" },
];

describe("the step a turn stopped inside", () => {
  it("is what came after the steps already collected, without its thinking", async () => {
    const out = await inProgressStep(TWO_STEPS, 1, tools, NOTHING_SETTLED, []);

    expect(out).toEqual([{ role: "assistant", content: [{ type: "text", text: "Here is what I fou" }] }]);
  });

  it("is nothing when the turn stopped between two steps", async () => {
    expect(await inProgressStep(TWO_STEPS, 2, tools, NOTHING_SETTLED, [])).toEqual([]);
  });

  it("is nothing when the next step's request never started", async () => {
    const oneStep: Parts = [{ type: "step-start" }, { type: "text", text: "Done.", state: "done" }];

    expect(await inProgressStep(oneStep, 1, tools, NOTHING_SETTLED, [])).toEqual([]);
  });

  it("keeps a call that answered, and a call that failed with what the model is told of it", async () => {
    const parts: Parts = [
      { type: "step-start" },
      { type: "tool-web_search", toolCallId: "a", state: "input-available", input: { query: "q" } },
      { type: "tool-web_search", toolCallId: "b", state: "input-available", input: { query: "q" } },
      { type: "tool-web_search", toolCallId: "c", state: "input-available", input: { query: "q" } },
    ];
    const settled = {
      answered: new Map<string, unknown>([["a", "R"]]),
      ended: new Map<string, ToolFailure>([["b", { kind: "turned_away", forModel: "Send it with a query." }]]),
    };

    const out = await inProgressStep(parts, 0, tools, settled, []);

    expect(out).toEqual([
      {
        role: "assistant",
        content: [
          { type: "tool-call", toolCallId: "a", toolName: "web_search", input: { query: "q" } },
          { type: "tool-call", toolCallId: "b", toolName: "web_search", input: { query: "q" } },
        ],
      },
      {
        role: "tool",
        content: [
          { type: "tool-result", toolCallId: "a", toolName: "web_search", output: { type: "text", value: "model sees R" } },
          {
            type: "tool-result",
            toolCallId: "b",
            toolName: "web_search",
            output: { type: "error-text", value: "Send it with a query." },
          },
        ],
      },
    ]);
  });

  it("leaves out the signed thinking a provider hung on the step's tool call", async () => {
    const signed = { openrouter: { reasoning_details: [{ type: "reasoning.text", signature: "sig" }] } };
    const parts: Parts = [
      { type: "step-start" },
      {
        type: "tool-web_search",
        toolCallId: "a",
        state: "output-available",
        input: { query: "q" },
        output: "R",
        callProviderMetadata: signed,
      },
    ];

    const out = await inProgressStep(parts, 0, tools, NOTHING_SETTLED, []);

    expect(JSON.stringify(out)).not.toContain("reasoning_details");
    expect(JSON.stringify(out)).not.toContain("providerOptions");
  });

  it("is nothing when it names a call already among the collected steps", async () => {
    const parts: Parts = [
      { type: "step-start" },
      { type: "tool-web_search", toolCallId: "a", state: "output-available", input: { query: "q" }, output: "R" },
    ];
    const collected: ModelMessage[] = [
      { role: "assistant", content: [{ type: "tool-call", toolCallId: "a", toolName: "web_search", input: { query: "q" } }] },
    ];

    expect(await inProgressStep(parts, 0, tools, NOTHING_SETTLED, collected)).toEqual([]);
  });
});

describe("how much a turn added and where the conversation ended up", () => {
  it("reads both off what the provider reported", () => {
    const tokens = replyTokens({ firstInput: 1000, lastInput: 1500, lastOutput: 200 }, { user: 30, reply: 999, request: 999 });

    expect(tokens).toEqual({ turnTokens: 1500 + 200 - 1000 + 30, endTokens: 1700, endTokensFrom: "provider" });
  });

  it("counts characters as tokens when nothing was reported", () => {
    const tokens = replyTokens({}, { user: 30, reply: 400, request: 5000 });

    expect(tokens).toEqual({ turnTokens: 430, endTokens: 5400, endTokensFrom: "chars" });
  });
});

describe("what the provider reported over a turn", () => {
  it("keeps the first call's input and the last call's input and output", () => {
    const after = noteUsage(noteUsage({}, { inputTokens: 1000, outputTokens: 20 }), { inputTokens: 1500, outputTokens: 200 });

    expect(after).toEqual({ firstInput: 1000, lastInput: 1500, lastOutput: 200 });
  });

  it("keeps the counts it has when a later call reports none", () => {
    const counted = noteUsage({}, { inputTokens: 900_000, outputTokens: 300 });

    expect(noteUsage(counted, { inputTokens: undefined, outputTokens: undefined })).toEqual(counted);
  });
});
