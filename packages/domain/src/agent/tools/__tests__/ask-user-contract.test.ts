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
 * this file -- it is a key in the registry, copied into three more lists, and
 * the copy that decides whether the turn waits for an answer fails silently
 * when it is missed.
 */
import { describe, it, expect } from "vitest";

import { askUser } from "@domain/agent/tools/ask-user.js";
import { TOOL_MAP, BASELINE_TOOLS, INTERACTION_TOOLS } from "@domain/agent/tools/index.js";
import { TOOLS_THAT_BLOCK } from "@domain/agent/tools/blocking-tools.js";

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
    // Four lists hold this name. The turn only waits for an answer because
    // the blocking one matches, and nothing else fails when it does not.
    expect(BASELINE_TOOLS).toContain("ask_user");
    expect(INTERACTION_TOOLS).toContain("ask_user");
    expect(TOOLS_THAT_BLOCK).toEqual(["ask_user"]);
  });

  it("leaves no list naming a tool the registry does not hold", () => {
    const registered = Object.keys(TOOL_MAP);
    for (const name of [...BASELINE_TOOLS, ...INTERACTION_TOOLS, ...TOOLS_THAT_BLOCK]) {
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

  it("are two to five when there are any", () => {
    expect(accepts({ question: "Which?", options: ["one"] })).toBe(false);
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

describe("what the model may not send", () => {
  it("is refused rather than dropped when a field is not in the schema", () => {
    // The default is to strip an unknown key in silence, which loses whatever
    // the model was trying to say without telling it that anything went.
    expect(accepts({ question: "Which?", multiSelect: true })).toBe(false);
    expect(accepts({ question: "Which?", choices: [{ id: "a", label: "A" }] })).toBe(false);
  });
});
