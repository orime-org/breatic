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

  it("says that a tool ends the turn", () => {
    expect(wording()).toMatch(/ends your turn/i);
  });

  it("says every answer on offer goes in the call, not in prose", () => {
    // Where the format actually comes from. The schema decides what a legal
    // call looks like; only this decides whether the model makes one at all
    // rather than writing its options into a sentence, which is what the
    // paragraph itself calls a run-on with nothing to pick from.
    expect(wording()).toMatch(/every answer you are offering, each as one of the options/i);
  });

  it("says not to write the question out as well", () => {
    expect(wording()).toMatch(/a question you also write out arrives twice/i);
  });

  it("names the field the answering line goes in, and whose language it is in", () => {
    expect(wording()).toMatch(/what the reader is told about answering is howToAnswer/i);
    expect(wording()).toMatch(/in the language you are replying in/i);
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
    // Checked against the real baseline rather than a copy of it, so adding a
    // tool and pasting its name into the prompt fails here.
    const prompt = buildSystemPrompt();
    for (const name of BASELINE_TOOLS) {
      expect(prompt).not.toContain(name);
    }
  });
});

describe("what the prompt says about citing what it found", () => {
  it("asks for a marker the panel can resolve, and says what the number counts", async () => {
    // The panel turns `[N]` into a chip carrying that source's favicon, and it
    // resolves N against the sources the turn's searches returned, in order.
    // A prompt that asked for any other form -- a footnote, a bare url, the
    // publisher's name in brackets -- would leave the chips absent while the
    // reply still reads as sourced.
    const prompt = await buildSystemPrompt({});

    expect(prompt).toContain("[1]");
    // Said about what a search returns, not about the tool that ran it. The
    // prompt names no tools -- see the file's opening note -- and the numbers
    // arrive with the sources either way.
    expect(prompt).toMatch(/search returns sources/i);
  });

  it("keeps the guidance inside How You Work rather than opening a section for it", async () => {
    // #211 rewrites this prompt as a whole. A convention that sits with the
    // other things said about using tools travels with them; one under a
    // heading of its own is a second place to notice.
    const prompt = await buildSystemPrompt({});
    const howToWork = prompt.indexOf("## How You Work");
    const nextSection = prompt.indexOf("## Available Skills");

    expect(prompt.slice(howToWork, nextSection)).toContain("[1]");
  });
});
