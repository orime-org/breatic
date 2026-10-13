// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * DSML markup is taken out of the reply text while it streams. The streams
 * below follow what `@openrouter/ai-sdk-provider` sends: a `raw` part before
 * every parsed part, tool calls arriving while the text is still open, and
 * one `text-end` after them.
 */
import { describe, it, expect } from "vitest";
import { wrapLanguageModel, type LanguageModelMiddleware } from "ai";
import { MockLanguageModelV4, convertArrayToReadableStream, convertReadableStreamToArray } from "ai/test";

import { dsmlMiddleware } from "@domain/agent/dsml-middleware.js";
import { streamTextRetry } from "@domain/agent/model-call.js";

type StreamResult = Awaited<ReturnType<NonNullable<LanguageModelMiddleware["wrapStream"]>>>;
type Part = StreamResult["stream"] extends ReadableStream<infer P> ? P : never;

const USAGE = {
  inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 1, text: 1, reasoning: 0 },
};

const BLOCK = [
  "<｜DSML｜tool_calls>\n",
  '<｜DSML｜invoke name="propose_canvas_action">\n',
  '<｜DSML｜parameter name="nodes" string="false">[{"prompt": "he shouts "here" and"',
];

/**
 * A provider stream with a `raw` part in front of every text delta.
 * @param deltas - The text deltas, in order.
 * @param between - Parts the provider sends after a given delta index.
 * @returns The parts, ending with `text-end` and `finish`.
 */
function providerStream(deltas: string[], between: Record<number, Part[]> = {}): Part[] {
  const parts: Part[] = [{ type: "stream-start", warnings: [] }, { type: "text-start", id: "t" }];
  deltas.forEach((delta, i) => {
    parts.push({ type: "raw", rawValue: { delta } }, { type: "text-delta", id: "t", delta });
    parts.push(...(between[i] ?? []));
  });
  parts.push(
    { type: "text-end", id: "t" },
    { type: "finish", finishReason: { unified: "tool-calls", raw: "tool_calls" }, usage: USAGE },
  );
  return parts;
}

/**
 * Run parts through the middleware.
 * @param parts - What the provider sends.
 * @returns What comes out the other side.
 */
async function throughMiddleware(parts: Part[]): Promise<Part[]> {
  const model = wrapLanguageModel({
    model: new MockLanguageModelV4({ doStream: async () => ({ stream: convertArrayToReadableStream(parts) }) }),
    middleware: dsmlMiddleware,
  });
  const { stream } = await model.doStream({ prompt: [] });
  return convertReadableStreamToArray(stream);
}

/**
 * The reply text in a list of parts.
 * @param parts - Stream parts.
 * @returns The text deltas joined.
 */
function textOf(parts: Part[]): string {
  return parts.map((p) => (p.type === "text-delta" ? p.delta : "")).join("");
}

const EMPTY_CALL: Part = {
  type: "tool-call",
  toolCallId: "call-1",
  toolName: "propose_canvas_action",
  input: "{}",
};

describe("dsmlMiddleware", () => {
  it("passes the prose before a call block and nothing after it", async () => {
    const out = await throughMiddleware(providerStream(["Here's the plan.\n\n", ...BLOCK]));
    expect(textOf(out)).toBe("Here's the plan.\n\n");
  });

  it("recognises a block opener split across two deltas", async () => {
    const out = await throughMiddleware(
      providerStream(["Let me propose it.\n\n<｜DS", "ML｜tool_", "calls>\n", ...BLOCK.slice(1)]),
    );
    expect(textOf(out)).toBe("Let me propose it.\n\n");
  });

  it("keeps dropping the block after a tool call arrives in the middle of it", async () => {
    const out = await throughMiddleware(providerStream(["Plan.\n\n", ...BLOCK, " more"], { 2: [EMPTY_CALL] }));
    expect(textOf(out)).toBe("Plan.\n\n");
  });

  it("passes every tool call and non-text part through unchanged", async () => {
    const parts = providerStream(["Plan.\n\n", ...BLOCK], { 1: [EMPTY_CALL] });
    const out = await throughMiddleware(parts);
    const notText = (p: Part): boolean => p.type !== "text-delta";
    expect(out.filter(notText)).toEqual(parts.filter(notText));
  });

  it("removes a lone tag split across deltas and keeps the words around it", async () => {
    const out = await throughMiddleware(
      providerStream(["Add the <｜DSML｜param", 'eter name="groupName">', "` line, then go."]),
    );
    expect(textOf(out)).toBe("Add the ` line, then go.");
  });

  it("lets a held character go once it turns out not to be a tag", async () => {
    const out = await throughMiddleware(providerStream(["if a <", " b then", " stop <"]));
    expect(textOf(out)).toBe("if a < b then stop <");
  });

  it("leaves ordinary text alone", async () => {
    const deltas = ["Use <b>bold</b>", " and ｜ bars."];
    const out = await throughMiddleware(providerStream(deltas));
    expect(out).toEqual(providerStream(deltas));
  });
});

describe("streamTextRetry", () => {
  it("streams reply text without the DSML block", async () => {
    const model = new MockLanguageModelV4({
      doStream: async () => ({ stream: convertArrayToReadableStream(providerStream(["Plan.\n\n", ...BLOCK])) }),
    });
    const result = streamTextRetry({ model, prompt: "hi" });
    expect(await result.text).toBe("Plan.\n\n");
  });
});
