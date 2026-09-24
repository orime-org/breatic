// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The prompt tells the model how to behave with tools, and never which ones.
 *
 * Deleting the delegation paragraph took with it the only wording in the
 * prompt that mentioned calling anything at all. Smoke on the earlier attempt
 * at that same deletion measured what happens next: the model wrote its calls
 * out as text -- first as pseudo-code, then in Claude's native XML call
 * syntax -- and opened an answer with "based on the material I found" without
 * having searched for anything. So the paragraph had to be replaced, not just
 * removed.
 *
 * Replaced by behaviour, not by a roster. Each tool's own description already
 * reaches the model, and a list written here would drift from the tools the
 * turn was actually given — the prompt would start naming tools the model
 * does not have.
 */
import { describe, expect, it } from "vitest";
import { buildSystemPrompt } from "@server/agent/context.js";
import { TOOL_MAP } from "@breatic/domain";

describe("the system prompt", () => {
  // The template is hard-wrapped, so any phrase long enough to be worth
  // asserting on may carry a newline in the middle of it. Collapsing runs of
  // whitespace keeps these assertions about the wording rather than about
  // where the lines happen to break.
  const wording = (): string => buildSystemPrompt().replace(/\s+/g, " ");

  it("tells the model to call tools rather than write out calls", () => {
    expect(wording()).toMatch(/do not write out what a call would look like/i);
  });

  it("forbids reporting results it did not actually fetch", () => {
    expect(wording()).toMatch(/unless a tool actually returned it on this turn/i);
  });

  it("says to read a tool error before doing anything with it", () => {
    // The load-bearing half of this task. With no ceiling on how often a
    // failing tool may be called, what stops a loop is the model deciding to
    // stop -- and it can only decide that from what the error said.
    expect(wording()).toMatch(/when a tool comes back with an error, read what it says/i);
  });

  it("tells the model to do what the error says to do", () => {
    // The errors themselves each end in what to do next, and what that is
    // differs: a page body that did not arrive may well arrive on a second
    // try, while a refused address will refuse every variation of itself. A
    // prompt that sorted failures into its own two buckets contradicted the
    // tools on the one they do not share, and one of the two instructions was
    // then always being disobeyed.
    expect(wording()).toMatch(/do what it says/i);
  });

  it("says not to repeat a call whose error said nothing about what to do", () => {
    // The floor under the line above, for the reasons that end without one.
    expect(wording()).toMatch(/will fail the same way/i);
  });

  it("says to tell the user what it could not get", () => {
    // The other half: a reply that quietly leaves out what failed is the
    // failure mode where the user never learns anything went wrong.
    expect(wording()).toMatch(/say so in your reply/i);
  });

  it("names no tools", () => {
    // The drift this prevents: a roster in the prompt outliving the tool set.
    // Checked against every registered tool rather than a copy of the list,
    // so adding a tool and pasting its name into the prompt fails here.
    const prompt = buildSystemPrompt();
    for (const name of Object.keys(TOOL_MAP)) {
      expect(prompt).not.toContain(name);
    }
  });
});

describe("the prompt says nothing about any one tool", () => {
  // What a tool is for and how to use it is said in its own description, and
  // only there. A second copy here drifts from the first -- the asking,
  // citing and canvas guidance that used to sit in this prompt now lives with
  // the tool each one is about.
  const wording = (): string => buildSystemPrompt().replace(/\s+/g, " ");

  it("carries none of the asking guidance", () => {
    expect(wording()).not.toMatch(/ends your turn/i);
    expect(wording()).not.toMatch(/howToAnswer/);
  });

  it("carries none of the citing guidance", () => {
    expect(wording()).not.toContain("[1]");
  });

  it("carries none of the canvas guidance", () => {
    expect(wording()).not.toMatch(/canvas is where models are run/i);
    expect(wording()).not.toMatch(/rather than half in your reply/i);
  });
});
