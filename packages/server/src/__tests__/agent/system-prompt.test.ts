// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

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
 * reaches the model, and a list written here would drift from whatever the
 * running skill actually declares — the prompt would start naming tools the
 * model does not have.
 */
import { describe, expect, it, vi } from "vitest";
import type * as DomainModule from "@breatic/domain";
import { buildSystemPrompt } from "@server/agent/context.js";
import { BASELINE_TOOLS } from "@breatic/domain";

vi.mock("@breatic/domain", async (importOriginal) => {
  const actual = await importOriginal<typeof DomainModule>();
  return {
    ...actual,
    getSkillRegistry: () => ({
      buildSummaryXml: () => "<skills />",
      getAlwaysContent: () => "",
    }),
  };
});

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

  it("says that some tools end the turn", () => {
    expect(wording()).toMatch(/end your turn/i);
  });

  it("says to read a tool error before doing anything with it", () => {
    // The load-bearing half of this task. With no ceiling on how often a
    // failing tool may be called, what stops a loop is the model deciding to
    // stop -- and it can only decide that from what the error said.
    expect(wording()).toMatch(/when a tool comes back with an error, read what it says/i);
  });

  it("says not to repeat a call that failed for a reason outside its reach", () => {
    expect(wording()).toMatch(/will fail the same way/i);
  });

  it("says to tell the user what it could not get", () => {
    // The other half: a reply that quietly leaves out what failed is the
    // failure mode where the user never learns anything went wrong.
    expect(wording()).toMatch(/say so in your reply/i);
  });

  it("names no tools", () => {
    // The drift this prevents: a roster in the prompt outliving the tool set.
    // Checked against the real baseline rather than a copy of it, so adding a
    // tool and pasting its name into the prompt fails here.
    const prompt = buildSystemPrompt();
    for (const name of BASELINE_TOOLS) {
      expect(prompt).not.toContain(name);
    }
  });
});
