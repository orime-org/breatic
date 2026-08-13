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

  it("leaves out a turn that was stopped before it said or did anything", () => {
    const history = [
      stored("user", [{ type: "text", text: "hello" }]),
      stored("assistant", [{ type: "interrupted" }]),
    ];

    // An assistant message with nothing in it still reaches the provider as an
    // empty text block, which is not something the model should be shown.
    expect(toModelMessages(history)).toEqual([{ role: "user", content: "hello" }]);
  });

  it("keeps what a stopped turn managed to say, and drops only the mark", () => {
    const history = [
      stored("assistant", [{ type: "text", text: "half a sen" }, { type: "interrupted" }]),
    ];

    expect(toModelMessages(history)).toEqual([
      { role: "assistant", content: "half a sen" },
    ]);
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
          errorMessage: "the site refused the connection",
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

  it("leaves out a call that never came back", () => {
    // A turn stopped while a tool was still running is swept to `error` on the
    // way to storage, with nothing to say about why — because nothing went
    // wrong, it simply never finished. That is how it comes back here, and a
    // call with no result puts the conversation in a state the protocol has no
    // answer for, so neither half goes.
    const history = [
      stored("user", [{ type: "text", text: "search" }]),
      stored("assistant", [
        {
          type: "tool",
          toolCallId: "tc-4",
          toolName: "web_search",
          input: { query: "x" },
          status: "error",
        },
        { type: "interrupted" },
      ]),
    ];

    expect(toModelMessages(history)).toEqual([{ role: "user", content: "search" }]);
  });
});
