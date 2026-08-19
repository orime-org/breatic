// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * The store keeps our shape; the wire carries the SDK's. Two functions between.
 *
 * The transport moves to the SDK's protocol and the store does not follow.
 * A model of a library decides how the library talks, not how our rows are
 * laid out -- the code can be rewritten when the dependency changes, the rows
 * that are already written cannot.
 *
 * So there is a boundary, and a boundary has two directions: what a finished
 * turn writes down, and what a conversation hands back when it is opened.
 * Both are pure functions and both are here.
 *
 * Two of our parts have no counterpart in the SDK's list. `interrupted` and
 * `failed` are things we know about a turn, not things a model streamed, so
 * they travel as data parts -- the one channel the protocol leaves open for
 * what it does not define. They are not transient: a reader who reloads has
 * to still see that a turn was cut off.
 *
 * Design: inner `engineering/specs/2026-08-19-usechat-migration-design.md`
 * 6.4.1. Acceptance A7.
 */
import { describe, it, expect } from "vitest";
import type { MessagePart } from "@breatic/shared";
import {
  toStoredParts,
  toUiParts,
} from "@server/modules/conversation/message-part-mapping.js";

describe("what a finished turn writes down", () => {
  it("keeps prose and reasoning as they came", () => {
    const stored = toStoredParts([
      { type: "text", text: "好的" },
      { type: "reasoning", text: "先想一下" },
    ]);

    expect(stored).toEqual([
      { type: "text", text: "好的" },
      { type: "reasoning", text: "先想一下" },
    ]);
  });

  it("folds a tool call and its result into one part", () => {
    // One use of one tool is one thing that happened. The SDK streams the
    // call and the result as states of a single part, and that is what gets
    // written: a reader should never have to pair two rows by id.
    const stored = toStoredParts([
      {
        type: "tool-web_fetch",
        toolCallId: "call-1",
        state: "output-available",
        input: { url: "https://example.com" },
        output: "拿到了",
      },
    ]);

    expect(stored).toEqual([
      {
        type: "tool",
        toolCallId: "call-1",
        toolName: "web_fetch",
        input: { url: "https://example.com" },
        status: "success",
        output: "拿到了",
      },
    ]);
  });

  it("keeps an interaction tool's payload structured", () => {
    // These tools hand back an object now that the sentinel prefix is gone.
    // Serialising it here would put the parsing back on the reader, which is
    // the thing that was just removed.
    const stored = toStoredParts([
      {
        type: "tool-ask_user_question",
        toolCallId: "call-2",
        state: "output-available",
        input: { question: "哪个方向？" },
        output: { question: "哪个方向？", options: ["左", "右"] },
      },
    ]);

    expect(stored[0]).toMatchObject({
      type: "tool",
      toolName: "ask_user_question",
      output: { question: "哪个方向？", options: ["左", "右"] },
    });
  });

  it("records why a tool failed", () => {
    const stored = toStoredParts([
      {
        type: "tool-web_fetch",
        toolCallId: "call-3",
        state: "output-error",
        input: { url: "https://example.com" },
        errorText: "读不到",
      },
    ]);

    expect(stored[0]).toEqual({
      type: "tool",
      toolCallId: "call-3",
      toolName: "web_fetch",
      input: { url: "https://example.com" },
      status: "error",
      errorMessage: "读不到",
    });
  });

  it("does not leave a tool that never came back looking finished", () => {
    // A turn stopped mid-tool. Written as pending rather than dropped: a
    // reader that meets a call with no result would otherwise have to invent
    // an answer for a state the store could have told it.
    const stored = toStoredParts([
      {
        type: "tool-web_fetch",
        toolCallId: "call-4",
        state: "input-available",
        input: { url: "https://example.com" },
      },
    ]);

    expect(stored[0]).toMatchObject({ type: "tool", status: "pending" });
    expect(stored[0]).not.toHaveProperty("output");
  });
});

describe("what a conversation hands back when it is opened", () => {
  it("returns prose and reasoning to the shapes the SDK renders", () => {
    const ui = toUiParts([
      { type: "text", text: "好的" },
      { type: "reasoning", text: "先想一下" },
    ]);

    expect(ui).toEqual([
      { type: "text", text: "好的" },
      { type: "reasoning", text: "先想一下" },
    ]);
  });

  it("names the tool in the part type, the way the SDK does", () => {
    const ui = toUiParts([
      {
        type: "tool",
        toolCallId: "call-1",
        toolName: "web_fetch",
        input: { url: "https://example.com" },
        status: "success",
        output: "拿到了",
      },
    ]);

    expect(ui[0]).toMatchObject({
      type: "tool-web_fetch",
      toolCallId: "call-1",
      state: "output-available",
      output: "拿到了",
    });
  });

  it("carries a stopped turn back as something the reader can see", () => {
    const ui = toUiParts([{ type: "text", text: "写到一半" }, { type: "interrupted" }]);

    // A data part, because the protocol has no part meaning "this was cut
    // off" and data parts are where what it does not define goes. Not
    // transient: reloading has to show it again.
    expect(ui[1]).toMatchObject({ type: "data-interrupted" });
    expect(ui[1]).not.toHaveProperty("transient");
  });

  it("carries a failed turn back the same way", () => {
    const ui = toUiParts([{ type: "failed" }]);
    expect(ui[0]).toMatchObject({ type: "data-failed" });
  });
});

describe("a message that goes out and comes back", () => {
  it("is the same message", () => {
    // The property that matters more than either direction on its own: the
    // boundary does not quietly lose a field. Every kind of part we store is
    // in here, including the two the SDK has no name for.
    const original: MessagePart[] = [
      { type: "text", text: "好的" },
      { type: "reasoning", text: "先想一下" },
      {
        type: "tool",
        toolCallId: "call-1",
        toolName: "web_fetch",
        input: { url: "https://example.com" },
        status: "success",
        output: "拿到了",
      },
      {
        type: "tool",
        toolCallId: "call-2",
        toolName: "web_search",
        input: { query: "参考图" },
        status: "error",
        errorMessage: "读不到",
      },
      { type: "interrupted" },
    ];

    expect(toStoredParts(toUiParts(original))).toEqual(original);
  });
});
