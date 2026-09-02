// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

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
 * Three of our parts have no counterpart in the SDK's list. `interrupted` and
 * `failed` are things we know about a turn, not things a model streamed, so
 * they travel as data parts -- the one channel the protocol leaves open for
 * what it does not define. They are not transient: a reader who reloads has
 * to still see that a turn was cut off.
 */
import { describe, it, expect } from "vitest";
import type { UIMessage } from "ai";
import { NOTHING_SAID_WHY } from "@breatic/shared";
import type { MessagePart } from "@breatic/shared";
import {
  toStoredParts,
  toUiMessages,
  toUiParts,
} from "@server/modules/conversation/message-part-mapping.js";

describe("what a finished turn writes down", () => {
  it("carries a turn's ending back out the way it came in", () => {
    // The three marks make the round trip on their own: a reload reads them
    // out of storage and the panel draws from what `toUiParts` hands back,
    // so a mark that survives storage and not the way back is invisible.
    for (const [stored, wire] of [
      ["interrupted", "data-interrupted"],
      ["failed", "data-failed"],
      ["truncated", "data-truncated"],
    ] as const) {
      expect(toUiParts([{ type: stored }])).toEqual([{ type: wire, data: {} }]);
      expect(toStoredParts([{ type: wire, data: {} }] as never)).toEqual([{ type: stored }]);
    }
  });

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

  it("keeps what the model sent when its arguments were not valid JSON", () => {
    // The SDK puts what arrived on `rawInput`, and when the arguments would
    // not parse that is the raw string rather than an object. Recording an
    // empty object instead hands the model back a record of itself calling
    // the tool with nothing, next to an error about arguments it cannot see.
    const stored = toStoredParts([
      {
        type: "tool-web_fetch",
        toolCallId: "call-9",
        state: "output-error",
        rawInput: '{"url": broken',
        errorText: "An error occurred.",
      } as unknown as UIMessage["parts"][number],
    ]);

    expect(stored[0]).toMatchObject({ input: '{"url": broken' });
  });

  it("records a failed call as failed, without inventing why", () => {
    const stored = toStoredParts([
      {
        type: "tool-web_fetch",
        toolCallId: "call-3",
        state: "output-error",
        input: { url: "https://example.com" },
        errorText: "chat.tool.failure.upstream",
      },
    ]);

    // What the wire carries on that field is the line a reader is shown, not
    // the reason the model needs -- two different things, and this side of
    // the boundary only ever has the first. The turn fills in the reason
    // afterwards from the callback handed the error itself; what is written
    // here stands for the case where no callback saw it, and says so.
    expect(stored[0]).toEqual({
      type: "tool",
      toolCallId: "call-3",
      toolName: "web_fetch",
      input: { url: "https://example.com" },
      status: "error",
      failure: NOTHING_SAID_WHY,
    });
    expect((stored[0] as { failure: { forModel: string } }).failure.forModel).not.toBe(
      "chat.tool.failure.upstream",
    );
  });

  it("marks a call whose arguments never finished arriving", () => {
    // `input-streaming` means the model was still emitting the arguments, so
    // whatever is in `input` came from a partial JSON parse.
    const stored = toStoredParts([
      {
        type: "tool-web_fetch",
        toolCallId: "call-9",
        state: "input-streaming",
        input: { url: "https://en.wikipedia.org/wiki/Bau" },
      },
    ]);

    expect(stored[0]).toMatchObject({ status: "pending", argumentsIncomplete: true });
  });

  it("does not mark one whose arguments arrived whole", () => {
    const stored = toStoredParts([
      {
        type: "tool-web_fetch",
        toolCallId: "call-10",
        state: "input-available",
        input: { url: "https://example.com" },
      },
    ]);

    expect(stored[0]).not.toHaveProperty("argumentsIncomplete");
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
        failure: {
          kind: "tool_failed",
          forModel: "读不到",
          readerKey: "chat.tool.failure.generic",
        },
      },
      { type: "interrupted" },
    ];

    // One field does not survive, deliberately: the model's copy of the
    // reason does not go out to the browser, so what comes back carries the
    // reader's key in its place. Everything else is the same message.
    const back = toStoredParts(toUiParts(original));
    expect(back.map((p) => p.type)).toEqual(original.map((p) => p.type));
    expect(back[0]).toEqual(original[0]);
    expect(back[1]).toEqual(original[1]);
    expect(back[2]).toEqual(original[2]);
    expect(back[3]).toMatchObject({
      toolCallId: "call-2",
      status: "error",
      failure: { kind: "tool_failed", readerKey: "chat.tool.failure.generic" },
    });
    expect(back[4]).toEqual(original[4]);
  });

  it("does not carry the model's reason out to the browser", () => {
    // The one field that deliberately does not survive the round trip. It
    // names hosts, statuses and, for a refused fetch, addresses inside the
    // network; the browser is given a key to translate and what kind of
    // ending it was, and that is the whole of it.
    const [part] = toUiParts([
      {
        type: "tool",
        toolCallId: "call-5",
        toolName: "web_fetch",
        input: { url: "https://example.com" },
        status: "error",
        failure: {
          kind: "tool_failed",
          forModel: "Fetching https://example.com failed: the site answered HTTP 404.",
          readerKey: "chat.tool.failure.upstream",
        },
      },
    ]);

    // The status and the sentence around it. The host is not checked here:
    // `input` carries it out on purpose, because the card shows the address
    // it was asked to fetch.
    expect(JSON.stringify(part)).not.toContain("404");
    expect(JSON.stringify(part)).not.toContain("answered HTTP");
    expect(part).toMatchObject({
      state: "output-error",
      errorText: "chat.tool.failure.upstream",
      failureKind: "tool_failed",
    });
  });

  it("says which of the two endings a stopped call was", () => {
    const [part] = toUiParts([
      {
        type: "tool",
        toolCallId: "call-6",
        toolName: "web_search",
        input: { query: "x" },
        status: "error",
        failure: {
          kind: "user_aborted",
          forModel: "The user stopped this turn while the tool was still running.",
          readerKey: "chat.tool.unfinished",
        },
      },
    ]);

    expect(part).toMatchObject({ failureKind: "user_aborted" });
  });
});

describe("a stored message on its way to the browser", () => {
  it("carries the row's own id, so the list keys on what the store knows", () => {
    const [message] = toUiMessages([
      {
        id: "row-1",
        role: "user",
        parts: [{ type: "text", text: "说点什么" }],
        content: "说点什么",
        ts: "2026-08-19T00:00:00Z",
        turnIndex: 3,
      },
    ]);

    expect(message?.id).toBe("row-1");
    expect(message?.role).toBe("user");
    expect(message?.parts).toEqual([{ type: "text", text: "说点什么" }]);
  });

  it("keeps the turn it belongs to, which is how the page before it is asked for", () => {
    // Paging back through a conversation is done by turn: the client holds the
    // oldest turn it has and asks for what came before. Dropping this leaves
    // it with nothing to ask with.
    const [message] = toUiMessages([
      {
        id: "row-1",
        role: "assistant",
        parts: [{ type: "text", text: "好的" }],
        content: "好的",
        ts: "2026-08-19T00:00:01Z",
        turnIndex: 3,
      },
    ]);

    expect(message?.metadata).toEqual({ turnIndex: 3, ts: "2026-08-19T00:00:01Z" });
  });

  it("drops the flat views, which the browser now works out for itself", () => {
    // `content` and `thinking` are the parts read out flat, stored twice so a
    // reader that only wants the prose does not have to walk them. On the wire
    // they would be a second copy the client has to keep in step with the
    // first, and the protocol gives it no place to put them.
    const [message] = toUiMessages([
      {
        id: "row-1",
        role: "assistant",
        parts: [
          { type: "reasoning", text: "先想一下" },
          { type: "text", text: "好的" },
        ],
        content: "好的",
        thinking: "先想一下",
        ts: "2026-08-19T00:00:01Z",
        turnIndex: 3,
      },
    ]);

    expect(message).not.toHaveProperty("content");
    expect(message).not.toHaveProperty("thinking");
    expect(message?.parts).toEqual([
      { type: "reasoning", text: "先想一下" },
      { type: "text", text: "好的" },
    ]);
  });
});
