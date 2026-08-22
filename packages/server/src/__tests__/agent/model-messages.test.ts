// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * Turning stored history into what the model is given.
 *
 * Two shapes, two audiences. Storage keeps one message per turn with its
 * pieces in order, which is what a person reads. The model is given the same
 * history split the way the protocol wants it: the call on the assistant, the
 * result on a message of its own.
 *
 * Handing the stored shape straight over is what made any conversation that
 * had used a tool fail on its next turn (task #75) — a tool result is not a
 * string to the SDK, and a reply that called a tool but never spoke is not an
 * empty message, it is a message with a call in it.
 */

import { describe, it, expect } from "vitest";
import type { MessageData } from "@breatic/shared";

import { toModelMessages } from "@server/agent/model-messages.js";

/**
 * Build a stored message the way the repository hands it out.
 * @param role - Who is speaking
 * @param parts - The pieces of the message, in order
 * @returns A message in the shape the store returns
 */
function stored(role: "user" | "assistant", parts: MessageData["parts"]): MessageData {
  const content = parts
    .filter((p) => p.type === "text")
    .map((p) => (p as { text: string }).text)
    .join("");
  return { id: "m1", role, parts, content, ts: "2026-08-11T00:00:00Z", turnIndex: 1 };
}

describe("history on its way to the model", () => {
  it("splits a tool use into the call and the result the protocol expects", () => {
    const history = [
      stored("user", [{ type: "text", text: "find me references" }]),
      stored("assistant", [
        {
          type: "tool",
          toolCallId: "tc-1",
          toolName: "web_search",
          input: { query: "cyberpunk" },
          status: "success",
          output: "three links",
        },
        { type: "text", text: "Here is what I found." },
      ]),
    ];

    expect(toModelMessages(history)).toEqual([
      { role: "user", content: "find me references" },
      {
        role: "assistant",
        content: [
          {
            type: "tool-call",
            toolCallId: "tc-1",
            toolName: "web_search",
            input: { query: "cyberpunk" },
          },
        ],
      },
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "tc-1",
            toolName: "web_search",
            output: { type: "text", value: "three links" },
          },
        ],
      },
      { role: "assistant", content: "Here is what I found." },
    ]);
  });

  it("carries the result as typed output, never as a bare string", () => {
    // One stored message carrying one tool use becomes two: the call, then
    // the result.
    const [, toolMessage] = toModelMessages([
      stored("assistant", [
        {
          type: "tool",
          toolCallId: "tc-2",
          toolName: "web_fetch",
          input: { url: "https://example.com" },
          status: "success",
          output: "the page said something",
        },
      ]),
    ]);

    // The SDK validates this field against a discriminated union at runtime;
    // a string here is the exact failure this conversion exists to remove.
    const output = (toolMessage as { content: Array<{ output: unknown }> } | undefined)
      ?.content[0]?.output;
    expect(output).toEqual({ type: "text", value: "the page said something" });
    expect(typeof output).not.toBe("string");
  });

  it("says a tool that answered with an object answered with an object", () => {
    // 四个交互工具直接返回 payload 对象。`text` 那一档的 `value` 要求是字符串,
    // 而 SDK 在请求出门前用 `z.discriminatedUnion` 校验 —— 把对象塞进 `text`
    // 整轮在到达模型之前就失败,而失败发生在流里、屏幕上什么都不会发生。
    // 于是一条会话从它第一次用交互工具起就再也说不了话。
    const [, toolMessage] = toModelMessages([
      stored("assistant", [
        {
          type: "tool",
          toolCallId: "tc-3",
          toolName: "ask_user_question",
          input: { question: "which era?" },
          status: "success",
          output: { question: "which era?", options: [] } as unknown as string,
        },
      ]),
    ]);

    const output = (toolMessage as { content: Array<{ output: unknown }> } | undefined)
      ?.content[0]?.output;
    expect(output).toEqual({
      type: "json",
      value: { question: "which era?", options: [] },
    });
  });

  it("says so even for a turn stopped before it got a word out", () => {
    const history = [
      stored("user", [{ type: "text", text: "hello" }]),
      stored("assistant", [{ type: "interrupted" }]),
    ];

    // Used to be dropped whole, on the grounds that an assistant message with
    // nothing in it reaches the provider as an empty text block. The note is
    // what it has instead -- not empty, and it is the only trace the next turn
    // has that anything happened here at all.
    const [, note] = toModelMessages(history);
    expect(note).toMatchObject({ role: "assistant" });
    expect(String((note as { content: string }).content)).toMatch(/stopped/i);
  });

  it("keeps what a stopped turn managed to say, and marks it as cut off", () => {
    const history = [
      stored("assistant", [{ type: "text", text: "half a sen" }, { type: "interrupted" }]),
    ];

    const [only] = toModelMessages(history);
    const content = String((only as { content: string }).content);
    expect(content).toContain("half a sen");
    expect(content).toMatch(/stopped/i);
  });

  it("never sends the model its own reasoning back", () => {
    const history = [
      stored("assistant", [
        { type: "reasoning", text: "let me think about this" },
        { type: "text", text: "here is my answer" },
      ]),
    ];

    expect(toModelMessages(history)).toEqual([
      { role: "assistant", content: "here is my answer" },
    ]);
  });

  it("marks a tool that failed so the model can see it did", () => {
    const [, toolMessage] = toModelMessages([
      stored("user", [{ type: "text", text: "fetch it" }]),
      stored("assistant", [
        {
          type: "tool",
          toolCallId: "tc-3",
          toolName: "web_fetch",
          input: { url: "https://example.com" },
          status: "error",
          failure: {
            kind: "tool_failed",
            forModel: "the site refused the connection",
            readerKey: "chat.tool.failure.unreachable",
          },
        },
      ]),
    ]).slice(1);

    expect(toolMessage).toMatchObject({
      role: "tool",
      content: [
        {
          type: "tool-result",
          toolCallId: "tc-3",
          output: { type: "error-text", value: "the site refused the connection" },
        },
      ],
    });
  });

  it("keeps the line meant for a reader out of what the model is sent", () => {
    // Two audiences, two fields, and only one of them travels. The key is what
    // the panel translates; the model has no use for it and every string put
    // in front of a model is read as something it was meant to act on.
    const messages = toModelMessages([
      stored("user", [{ type: "text", text: "fetch it" }]),
      stored("assistant", [
        {
          type: "tool",
          toolCallId: "tc-3",
          toolName: "web_fetch",
          input: { url: "https://example.com" },
          status: "error",
          failure: {
            kind: "tool_failed",
            forModel: "the site refused the connection",
            readerKey: "chat.tool.failure.unreachable",
          },
        },
      ]),
    ]);

    expect(JSON.stringify(messages)).not.toContain("chat.tool.failure");
  });

  it("tells the model the last turn was stopped by the user", () => {
    // Task #93. A stopped turn used to be dropped whole, so the next turn read
    // as one the model had finished answering -- it had no way to know its own
    // reply had been cut off, and would carry on as though it had.
    const [, toolMessage] = toModelMessages([
      stored("user", [{ type: "text", text: "search" }]),
      stored("assistant", [
        {
          type: "tool",
          toolCallId: "tc-4",
          toolName: "web_search",
          input: { query: "x" },
          status: "error",
          failure: {
            kind: "user_aborted",
            forModel: "The user stopped this turn while the tool was still running.",
            readerKey: "chat.tool.unfinished",
          },
        },
        { type: "interrupted" },
      ]),
    ]).slice(1);

    expect(toolMessage).toMatchObject({
      role: "tool",
      content: [
        {
          type: "tool-result",
          toolCallId: "tc-4",
          output: {
            type: "error-text",
            value: expect.stringContaining("stopped"),
          },
        },
      ],
    });
  });

  it("tells the model a turn stopped mid-sentence was stopped", () => {
    // Task #93's other half. No tool was ever called -- the model was writing
    // prose and the user pressed stop -- so the tool path that carries this
    // never runs, and the turn read back as one the model had finished.
    const messages = toModelMessages([
      stored("user", [{ type: "text", text: "list twenty of them" }]),
      stored("assistant", [
        { type: "text", text: "1. first 2. sec" },
        { type: "interrupted" },
      ]),
    ]);

    expect(JSON.stringify(messages)).toMatch(/stopped/i);
  });

  it("leaves out a call still in flight", () => {
    // The one state with nothing to replay. A stored part is never `pending`
    // -- the turn sweeps it before writing -- but the conversion is handed
    // parts from a turn still running too, and a call with no result puts the
    // exchange in a state the protocol has no move for.
    const history = [
      stored("user", [{ type: "text", text: "search" }]),
      stored("assistant", [
        {
          type: "tool",
          toolCallId: "tc-5",
          toolName: "web_search",
          input: { query: "x" },
          status: "pending",
        },
      ]),
    ];

    expect(toModelMessages(history)).toEqual([{ role: "user", content: "search" }]);
  });
});
