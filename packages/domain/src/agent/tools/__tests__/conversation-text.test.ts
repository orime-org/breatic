// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * A stored message as the record tools write it out (inner#1469).
 *
 * The words a user sees in a conversation are not all in its text parts: a
 * questionnaire's answers live only in the `ask_user` call's result, and a
 * proposal's prompts only in the call's input. Reading back what was said
 * has to carry those, and leave out what the user never saw said -- the
 * model's thinking and the markers of how a turn ended.
 */
import { describe, it, expect } from "vitest";
import { getAgentConfig } from "@breatic/core";
import type { MessagePart } from "@breatic/shared";
import { messageText } from "@domain/agent/tools/conversation-text.js";

const QUESTIONS = {
  questions: [
    { header: "Ratio", question: "Which ratio?", options: [{ label: "16:9" }, { label: "9:16" }] },
    { header: "Mood", question: "Any mood in mind?", options: [{ label: "Warm" }, { label: "Cool" }] },
    { header: "Light", question: "Bright or dim?", options: [{ label: "Bright" }, { label: "Dim" }] },
  ],
};

/**
 * An `ask_user` part.
 * @param output - Its result, when it has one.
 * @returns The part.
 */
function asked(output?: unknown): MessagePart {
  return {
    type: "tool",
    toolCallId: "ask-1",
    toolName: "ask_user",
    input: QUESTIONS,
    status: output === undefined ? "awaiting" : "success",
    ...(output === undefined ? {} : { output }),
  };
}

describe("a message written out", () => {
  it("keeps its words and their order", () => {
    const text = messageText([
      { type: "text", text: "First the colours." },
      { type: "tool", toolCallId: "t", toolName: "search_images", input: { query: "warm cafe" }, status: "success", output: { results: [] } },
      { type: "text", text: "Then the poster." },
    ]);

    expect(text.indexOf("First the colours.")).toBeLessThan(text.indexOf("[called search_images]"));
    expect(text.indexOf("[called search_images]")).toBeLessThan(text.indexOf("Then the poster."));
  });

  it("names what was attached", () => {
    const text = messageText([
      { type: "attachment", chip: { id: "n1", type: "image", name: "Cover art", data_snapshot: {} } },
    ]);

    expect(text).toBe("[attached: Cover art]");
  });

  it("writes an old single-question card as one question with its options, and no result line", () => {
    const text = messageText([
      {
        type: "tool",
        toolCallId: "ask-old",
        toolName: "ask_user",
        input: { question: "Which ratio?", options: ["16:9", "9:16"] },
        status: "success",
        output: { question: "Which ratio?" },
      },
    ]);

    expect(text).toContain("Q1 Which ratio?");
    expect(text.split("Which ratio?")).toHaveLength(2);
    expect(text).toContain("16:9");
    expect(text).toContain("9:16");
    expect(text).not.toContain("[ask_user answered]");
    expect(text).not.toContain("[called ask_user]");
  });

  it("writes out each question and the answer the user gave to it", () => {
    const text = messageText([
      asked({
        answers: [
          { index: 0, selected: ["9:16"] },
          { index: 1, selected: ["Warm"], other: "like a late afternoon" },
        ],
      }),
    ]);

    expect(text).toContain("Q1 Which ratio?");
    expect(text).toContain("A1 9:16");
    expect(text).toContain("Q2 Any mood in mind?");
    expect(text).toContain("A2 Warm / other: like a late afternoon");
    expect(text).toContain("Q3 Bright or dim?");
    expect(text).toContain("A3 skipped");
  });

  it("writes an answer given only on the Other line", () => {
    const text = messageText([asked({ answers: [{ index: 0, selected: [], other: "Square, please" }] })]);

    expect(text).toContain("A1 other: Square, please");
  });

  it("says when the user wrote a message instead of answering", () => {
    const text = messageText([asked({ repliedInChat: true })]);

    expect(text).toContain("Q1 Which ratio?");
    expect(text).toContain("the user wrote a message instead");
  });

  it("writes the questions of a card still waiting, with no answers", () => {
    const text = messageText([asked()]);

    expect(text).toContain("Q1 Which ratio?");
    expect(text).not.toMatch(/^A1 /m);
  });

  it("writes the words another tool was called with and answered with", () => {
    const text = messageText([
      {
        type: "tool",
        toolCallId: "t",
        toolName: "propose_canvas_action",
        input: { title: "Poster", segments: [{ text: "A warm cafe at dawn" }] },
        status: "success",
        output: { accepted: true, note: "Proposal shown" },
      },
    ]);

    expect(text).toContain("[called propose_canvas_action]");
    expect(text).toContain("A warm cafe at dawn");
    expect(text).toContain("[propose_canvas_action answered]");
    expect(text).toContain("Proposal shown");
  });

  it("writes a call whose input arrived as a plain string", () => {
    const text = messageText([
      { type: "tool", toolCallId: "t", toolName: "web_search", input: "unparsed words", status: "error" },
    ]);

    expect(text).toContain("[called web_search] unparsed words");
  });

  it("cuts a tool's words to the configured length", () => {
    const max = getAgentConfig().records_tool_text_max_chars;
    const tail = "TAIL-THAT-MUST-GO";
    const text = messageText([
      { type: "tool", toolCallId: "t", toolName: "web_search", input: { query: "x".repeat(max) + tail }, status: "success" },
    ]);

    expect(text).toContain("[called web_search] xxx");
    expect(text).not.toContain(tail);
  });

  it("writes a record tool's call without what it answered, which is a copy of records found elsewhere", () => {
    const text = messageText([
      {
        type: "tool",
        toolCallId: "t",
        toolName: "read_conversation",
        input: { conversation_id: "c-9" },
        status: "success",
        output: "Turn 1 · user: COPIED-FROM-ELSEWHERE",
      },
    ]);

    expect(text).toBe("[called read_conversation] c-9");
  });

  it("marks where a tool's words were cut", () => {
    const max = getAgentConfig().records_tool_text_max_chars;
    const text = messageText([
      { type: "tool", toolCallId: "t", toolName: "web_search", input: { query: "x".repeat(max + 50) }, status: "success" },
    ]);

    expect(text.split("\n")[0]?.endsWith("…")).toBe(true);
  });

  it("writes a text part whole when it is shorter than a page", () => {
    const pageMax = getAgentConfig().records_page_max_chars;
    // Longer than the old 4000-character message cap, which no longer applies to text.
    const long = "w".repeat(pageMax - 100);

    expect(messageText([{ type: "text", text: long }])).toBe(long);
  });

  it("cuts a text part longer than a page and says how many characters that part lost", () => {
    const pageMax = getAgentConfig().records_page_max_chars;
    const tail = "TAIL-PAST-THE-PAGE";
    const lost = 77;
    const long = "v".repeat(pageMax + lost - tail.length) + tail;

    const text = messageText([{ type: "text", text: long }]);

    expect(text).toContain(`[${String(lost)} more characters cut]`);
    expect(text).not.toContain(tail);
    expect(text.startsWith("v".repeat(pageMax))).toBe(true);
  });

  it("leaves out the thinking and the markers of how the turn ended", () => {
    const text = messageText([
      { type: "reasoning", text: "SECRET-THOUGHT" },
      { type: "thinking-time", ms: 1200 },
      { type: "text", text: "Visible." },
      { type: "interrupted" },
      { type: "failed" },
      { type: "truncated" },
      { type: "blocked" },
    ]);

    expect(text).toBe("Visible.");
  });
});
