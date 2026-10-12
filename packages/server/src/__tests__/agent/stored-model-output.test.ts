// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * What the model was given for a tool call is written down with the turn.
 *
 * Replay hands the stored value back as it is, so it has to be the same value
 * the SDK sent while the turn ran -- worked out from the tool's own
 * `toModelOutput`, or from the SDK's default when the tool declares none.
 * Working it out cannot fail the turn: a call whose value cannot be worked out
 * is written with a note saying the result is unavailable, and logged.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { tool } from "ai";
import { createToolModelOutput } from "ai/internal";
import type { Tool } from "ai";
import { z } from "zod";
import type { MessagePart } from "@breatic/shared";

vi.mock("@breatic/core", async (importOriginal) => {
  const { coreMock } = await import("../helpers/mock-core.js");
  return coreMock(importOriginal);
});

const { mocks } = await import("../helpers/mock-core.js");
const { withModelOutputs, EARLIER_RESULT_NOTE } = await import(
  "@server/agent/stored-model-output.js"
);

type ToolPart = Extract<MessagePart, { type: "tool" }>;

/**
 * A tool part that ended with an answer.
 * @param toolName - The tool that was called.
 * @param output - What it returned.
 * @returns The part as the turn would store it before this pass.
 */
function succeeded(toolName: string, output: unknown): ToolPart {
  return {
    type: "tool",
    toolCallId: `tc-${toolName}`,
    toolName,
    input: { q: "x" },
    status: "success",
    output,
  };
}

const plain = tool({
  description: "answers with whatever it is given",
  inputSchema: z.object({ q: z.string() }),
  execute: async () => "unused",
});

const rendering = tool({
  description: "renders its answer for the model",
  inputSchema: z.object({ q: z.string() }),
  execute: async () => ({ items: [1, 2] }),
  toModelOutput: ({ output }) => ({
    type: "text",
    value: `items: ${(output).items.join(",")}`,
  }),
});

const CONTEXT = { conversationId: "conv-1" };

/**
 * Run the pass over one part and read back what it stored for the model.
 * @param tools - The tool set the turn ran with.
 * @param part - The part to work on.
 * @returns The part after the pass.
 */
async function passOver(tools: Record<string, Tool>, part: MessagePart): Promise<MessagePart> {
  const [out] = await withModelOutputs([part], tools, CONTEXT);
  return out as MessagePart;
}

beforeEach(() => {
  mocks.logger.error.mockClear();
});

describe("what a success part stores for the model", () => {
  it("stores what the tool's own toModelOutput returns", async () => {
    const out = await passOver({ rendering }, succeeded("rendering", { items: [1, 2] }));

    expect(out).toMatchObject({ forModel: { type: "text", value: "items: 1,2" } });
  });

  it.each([
    ["a string", "three links"],
    ["an object", { a: 1 }],
    ["nothing", undefined],
  ])("stores what the SDK itself would send for %s from a tool with no toModelOutput", async (_label, output) => {
    const part = succeeded("plain", output);
    const out = await passOver({ plain }, part);

    const sdk = await createToolModelOutput({
      toolCallId: part.toolCallId,
      input: part.input,
      output,
      tool: plain,
      errorMode: "none",
    });
    expect((out as ToolPart).forModel).toEqual(sdk);
  });

  it("stores what the SDK itself would send for a tool with toModelOutput", async () => {
    const part = succeeded("rendering", { items: [3] });
    const out = await passOver({ rendering }, part);

    const sdk = await createToolModelOutput({
      toolCallId: part.toolCallId,
      input: part.input,
      output: part.output,
      tool: rendering,
      errorMode: "none",
    });
    expect((out as ToolPart).forModel).toEqual(sdk);
  });

  it("leaves the tool's own output where it was", async () => {
    const out = await passOver({ rendering }, succeeded("rendering", { items: [1] }));

    expect(out).toMatchObject({ output: { items: [1] } });
  });

  it("leaves parts that did not succeed as they were", async () => {
    const failed: ToolPart = {
      type: "tool",
      toolCallId: "tc-f",
      toolName: "rendering",
      input: {},
      status: "error",
      failure: { kind: "tool_failed", forModel: "it broke", readerKey: "chat.tool.failure.generic" },
    };
    const text: MessagePart = { type: "text", text: "hello" };

    const out = await withModelOutputs([failed, text], { rendering }, CONTEXT);

    expect(out).toEqual([failed, text]);
  });
});

describe("a value that cannot be worked out does not fail the turn", () => {
  const throwing = tool({
    description: "renders badly",
    inputSchema: z.object({ q: z.string() }),
    execute: async () => ({}),
    toModelOutput: () => {
      throw new TypeError("Cannot read properties of undefined (reading 'length')");
    },
  });
  const rejecting = tool({
    description: "renders badly, later",
    inputSchema: z.object({ q: z.string() }),
    execute: async () => ({}),
    toModelOutput: async () => {
      throw new Error("rejected");
    },
  });
  const files = tool({
    description: "hands the model a file",
    inputSchema: z.object({ q: z.string() }),
    execute: async () => ({}),
    toModelOutput: () => ({
      type: "content",
      value: [{ type: "text", text: "see the attached" }],
    }),
  });

  it.each([
    ["throws", { throwing }, "throwing"],
    ["rejects", { rejecting }, "rejecting"],
    ["returns an arm the store does not keep", { files }, "files"],
    ["is not in the turn's tool set", {}, "gone"],
  ] as const)("stores the note and logs when the tool %s", async (_label, tools, toolName) => {
    const out = await passOver(tools, succeeded(toolName, { any: 1 }));

    expect(out).toMatchObject({ forModel: { type: "text", value: EARLIER_RESULT_NOTE } });
    expect(mocks.logger.error).toHaveBeenCalledTimes(1);
    expect(mocks.logger.error.mock.calls[0]?.[0]).toMatchObject({
      conversationId: "conv-1",
      toolName,
      toolCallId: `tc-${toolName}`,
    });
  });

  it("works out every other part when one of them fails", async () => {
    const out = await withModelOutputs(
      [succeeded("throwing", {}), succeeded("rendering", { items: [9] })],
      { throwing, rendering },
      CONTEXT,
    );

    expect(out[1]).toMatchObject({ forModel: { type: "text", value: "items: 9" } });
  });
});
