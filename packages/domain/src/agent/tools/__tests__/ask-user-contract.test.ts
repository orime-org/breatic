// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * One tool asks the user something, and its arguments are the format.
 *
 * The question and its options are drawn as a paragraph of markdown, so the
 * shape of that paragraph is decided here rather than requested of the model:
 * a question is one line, an option is one line, and anything the schema lets
 * through is something a reader will see.
 *
 * The name is checked alongside the shape because the name is not written in
 * this file -- it is a key in the registry, copied into two more lists, and
 * the test that decides whether the turn waits for an answer fails silently
 * when it is missed.
 */
import { describe, it, expect } from "vitest";

import { askUser } from "@domain/agent/tools/ask-user.js";
import { TOOL_MAP, BASELINE_TOOLS, INTERACTION_TOOLS } from "@domain/agent/tools/index.js";

/** The schema, in the one shape a test can call. */
const schema = askUser.inputSchema as unknown as {
  safeParse: (value: unknown) => { success: boolean };
};

/**
 * Whether the tool accepts these arguments.
 * @param value - What the model would have sent.
 * @returns True when the schema lets it through.
 */
function accepts(value: unknown): boolean {
  return schema.safeParse(value).success;
}

describe("the one name this tool has", () => {
  it("is ask_user in the registry, and neither of the two it replaces", () => {
    expect(Object.keys(TOOL_MAP)).toContain("ask_user");
    expect(Object.keys(TOOL_MAP)).not.toContain("ask_user_question");
    expect(Object.keys(TOOL_MAP)).not.toContain("ask_user_choice");
  });

  it("reads the same in every list that copies it", () => {
    // Two lists hold this name beyond the registry key itself, and the turn
    // only waits for an answer because the name it matches is the same.
    expect(BASELINE_TOOLS).toContain("ask_user");
    expect(INTERACTION_TOOLS).toContain("ask_user");
  });

  it("leaves no list naming a tool the registry does not hold", () => {
    const registered = Object.keys(TOOL_MAP);
    for (const name of [...BASELINE_TOOLS, ...INTERACTION_TOOLS]) {
      expect(registered).toContain(name);
    }
  });
});

describe("the question", () => {
  it("is required and may not be blank", () => {
    expect(accepts({})).toBe(false);
    expect(accepts({ question: "" })).toBe(false);
    // Whitespace passes a bare `min(1)`, and on screen it is an empty line
    // above a row saying the turn is waiting for an answer to it.
    expect(accepts({ question: "   " })).toBe(false);
  });

  it("is a single line, so a list cannot be folded into it", () => {
    expect(accepts({ question: "Which pace?\n1. Fast\n2. Slow" })).toBe(false);
  });

  it("has a ceiling, so a paragraph cannot arrive as the question", () => {
    expect(accepts({ question: "a".repeat(200) })).toBe(true);
    expect(accepts({ question: "a".repeat(201) })).toBe(false);
  });
});

describe("the options", () => {
  it("may be absent or empty, both meaning an open question", () => {
    // An empty array is what this tool has always normalised away, and the
    // rule for fewer than two is to draw no list rather than to refuse.
    expect(accepts({ question: "Who is it for?" })).toBe(true);
    expect(accepts({ question: "Who is it for?", options: [] })).toBe(true);
  });

  it("are at most five, and one is drawn rather than refused", () => {
    // The floor cannot reach the model: `zodSchema` renders this array as
    // `maxItems: 5` and drops a `.refine` on the way, so refusing a call for
    // having one option enforces a rule the model was never shown.
    expect(accepts({ question: "Which?", options: ["one"] })).toBe(true);
    expect(accepts({ question: "Which?", options: ["one", "two"] })).toBe(true);
    expect(accepts({ question: "Which?", options: ["1", "2", "3", "4", "5"] })).toBe(true);
    expect(accepts({ question: "Which?", options: ["1", "2", "3", "4", "5", "6"] })).toBe(false);
  });

  it("are each one line and not blank", () => {
    expect(accepts({ question: "Which?", options: ["one", ""] })).toBe(false);
    expect(accepts({ question: "Which?", options: ["one", "two\nthree"] })).toBe(false);
    expect(accepts({ question: "Which?", options: ["one", "b".repeat(60)] })).toBe(true);
    expect(accepts({ question: "Which?", options: ["one", "b".repeat(61)] })).toBe(false);
  });
});

describe("what the model says about answering", () => {
  it("is optional, since a question often speaks for itself", () => {
    expect(accepts({ question: "Which?", options: ["one", "two"] })).toBe(true);
  });

  it("is one line and not blank, like everything else the reader will read", () => {
    expect(accepts({ question: "Which?", howToAnswer: "A number will do." })).toBe(true);
    expect(accepts({ question: "Which?", howToAnswer: "" })).toBe(false);
    expect(accepts({ question: "Which?", howToAnswer: "   " })).toBe(false);
    expect(accepts({ question: "Which?", howToAnswer: "one\ntwo" })).toBe(false);
    expect(accepts({ question: "Which?", howToAnswer: "c".repeat(120) })).toBe(true);
    expect(accepts({ question: "Which?", howToAnswer: "c".repeat(121) })).toBe(false);
  });
});

describe("what a line may not hold", () => {
  it("refuses every line ending, not just the newline", () => {
    // One option is one line, so a value carrying a line ending is two.
    expect(accepts({ question: "Which?", options: ["keep it\r3. wipe all", "b"] })).toBe(false);
    expect(accepts({ question: "a\rb" })).toBe(false);
    expect(accepts({ question: "a\u2028b" })).toBe(false);
  });

  it("takes text that happens to start with markdown punctuation", () => {
    // What a line renders as is settled where it is drawn: the paragraph is
    // built as a document and serialised, so a value that would have opened a
    // block of its own arrives as the characters it is. Refusing these costs
    // the reader a round trip and buys nothing, and a hex colour or a `#1` is
    // ordinary text in a product about making things.
    expect(accepts({ question: "#FF0000 正红还是 #1 方案？" })).toBe(true);
    expect(accepts({ question: "# 用哪个标签？" })).toBe(true);
    expect(accepts({ question: "> 引用" })).toBe(true);
    expect(accepts({ question: "---" })).toBe(true);
    expect(accepts({ question: "Which?", options: ["1. 快切", "- 慢"] })).toBe(true);
    expect(accepts({ question: "Which?", options: ["|竖屏|", "16:9 横屏"] })).toBe(true);
    expect(accepts({ question: "Which?", howToAnswer: "1) 回一个数字" })).toBe(true);
  });
});

describe("what the model is shown of all this", () => {
  it("carries every rule the tool enforces, so none of them is a surprise", async () => {
    // A call refused over a rule the model was never shown costs the reader a
    // whole round trip in silence: the refusal produces no result, so the turn
    // does not stop, and a tool error is not drawn today. Which rules survive
    // the trip is the SDK's business -- a `.refine` is dropped on the way,
    // which is why there is no floor on `options` -- so what it emits is
    // pinned here rather than assumed.
    const { zodSchema } = await import("ai");
    const emitted = (await zodSchema(askUser.inputSchema as never)).jsonSchema as {
      properties?: Record<string, Record<string, unknown>>;
      required?: string[];
      additionalProperties?: boolean;
    };

    expect(emitted.required).toEqual(["question"]);
    expect(emitted.additionalProperties).toBe(false);
    expect(emitted.properties?.question).toMatchObject({ minLength: 1, maxLength: 200 });
    expect(emitted.properties?.question?.pattern).toBeTypeOf("string");
    expect(emitted.properties?.options).toMatchObject({ maxItems: 5 });
    expect(emitted.properties?.howToAnswer).toMatchObject({ minLength: 1, maxLength: 120 });
  });
});

describe("what the model may not send", () => {
  it("is refused rather than dropped when a field is not in the schema", () => {
    // The default is to strip an unknown key in silence, which loses whatever
    // the model was trying to say without telling it that anything went.
    expect(accepts({ question: "Which?", multiSelect: true })).toBe(false);
    expect(accepts({ question: "Which?", choices: [{ id: "a", label: "A" }] })).toBe(false);
  });
});
