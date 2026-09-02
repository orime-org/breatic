// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * What the budget is measured against (#148, G5).
 *
 * The line is drawn around "the whole length assembled and about to go to the
 * model", which is three things and not two: the instructions, the tool
 * definitions, and the messages. The tool definitions are the one segment that
 * lives in neither of the other two — they reach the provider as the `tools`
 * argument — so an implementation that measures `instructions.length +
 * messages` looks right and is short by the whole tool set.
 */

import { describe, it, expect } from "vitest";
import { z } from "zod";
import { tool } from "ai";
import type { ModelMessage } from "ai";
import { measurePayload } from "../../agent/payload-size.js";

/**
 * A tool whose schema and description can be grown on demand.
 * @param description - The description the model is shown.
 * @param fieldCount - How many fields its input schema declares.
 * @returns The tool, ready for the AI SDK's `tools` option.
 */
function sizedTool(description: string, fieldCount = 1) {
  const shape: Record<string, z.ZodString> = {};
  for (let i = 0; i < fieldCount; i += 1) {
    shape[`field_${i}`] = z.string().describe(`the ${i}th field`);
  }
  return tool({
    description,
    inputSchema: z.object(shape),
    execute: async () => "",
  });
}

const NO_TOOLS = {};
const EMPTY: ModelMessage[] = [];

describe("the payload the budget is measured against", () => {
  it("counts the instructions", () => {
    const short = measurePayload({ instructions: "abc", tools: NO_TOOLS, messages: EMPTY });
    const long = measurePayload({
      instructions: `abc${"x".repeat(1000)}`,
      tools: NO_TOOLS,
      messages: EMPTY,
    });

    expect(long - short).toBe(1000);
  });

  it("counts the messages", () => {
    const before = measurePayload({ instructions: "", tools: NO_TOOLS, messages: EMPTY });
    const after = measurePayload({
      instructions: "",
      tools: NO_TOOLS,
      messages: [{ role: "user", content: "y".repeat(500) }],
    });

    expect(after - before).toBeGreaterThanOrEqual(500);
  });

  it("counts the tool definitions", () => {
    // The assertion that fails when `tools` is left out of the sum. The
    // messages and instructions are identical in both calls; only the tool
    // set differs.
    const withoutTools = measurePayload({
      instructions: "system",
      tools: NO_TOOLS,
      messages: [{ role: "user", content: "hello" }],
    });
    const withTools = measurePayload({
      instructions: "system",
      tools: { web_fetch: sizedTool("fetches a page", 8) },
      messages: [{ role: "user", content: "hello" }],
    });

    expect(withTools).toBeGreaterThan(withoutTools);
  });

  it("grows by exactly what a longer tool description adds", () => {
    const base = measurePayload({
      instructions: "",
      tools: { web_fetch: sizedTool("fetches") },
      messages: EMPTY,
    });
    const longer = measurePayload({
      instructions: "",
      tools: { web_fetch: sizedTool(`fetches${"z".repeat(300)}`) },
      messages: EMPTY,
    });

    expect(longer - base).toBe(300);
  });

  it("counts the parameter schema, not just the description", () => {
    // Same name, same description, different schema: the only assertion here
    // that fails when the schema is left out of a tool's measurement.
    const narrow = measurePayload({
      instructions: "",
      tools: { web_fetch: sizedTool("fetches a page", 1) },
      messages: EMPTY,
    });
    const wide = measurePayload({
      instructions: "",
      tools: { web_fetch: sizedTool("fetches a page", 12) },
      messages: EMPTY,
    });

    expect(wide).toBeGreaterThan(narrow);
  });

  it("counts every tool in the set, not just the first", () => {
    const one = measurePayload({
      instructions: "",
      tools: { a: sizedTool("first tool") },
      messages: EMPTY,
    });
    const two = measurePayload({
      instructions: "",
      tools: { a: sizedTool("first tool"), b: sizedTool("second tool") },
      messages: EMPTY,
    });

    expect(two).toBeGreaterThan(one);
  });

  it("counts a message's tool call by its name and arguments", () => {
    const plain = measurePayload({
      instructions: "",
      tools: NO_TOOLS,
      messages: [{ role: "assistant", content: [{ type: "text", text: "hi" }] }],
    });
    const withCall = measurePayload({
      instructions: "",
      tools: NO_TOOLS,
      messages: [
        {
          role: "assistant",
          content: [
            { type: "text", text: "hi" },
            {
              type: "tool-call",
              toolCallId: "c1",
              toolName: "web_fetch",
              input: { url: "https://example.test/a-fairly-long-address" },
            },
          ],
        },
      ],
    });

    expect(withCall).toBeGreaterThan(plain);
  });

  it("counts a tool result by what the tool returned", () => {
    const small = measurePayload({
      instructions: "",
      tools: NO_TOOLS,
      messages: [
        {
          role: "tool",
          content: [
            {
              type: "tool-result",
              toolCallId: "c1",
              toolName: "web_fetch",
              output: { type: "text", value: "short" },
            },
          ],
        },
      ],
    });
    const big = measurePayload({
      instructions: "",
      tools: NO_TOOLS,
      messages: [
        {
          role: "tool",
          content: [
            {
              type: "tool-result",
              toolCallId: "c1",
              toolName: "web_fetch",
              output: { type: "text", value: "w".repeat(5000) },
            },
          ],
        },
      ],
    });

    expect(big - small).toBeGreaterThanOrEqual(4900);
  });

  it("returns zero for an empty payload", () => {
    expect(measurePayload({ instructions: "", tools: NO_TOOLS, messages: EMPTY })).toBe(0);
  });
});
