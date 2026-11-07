// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

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
import { USER_LANGUAGE_REMINDER } from "@server/agent/user-turn.js";
import { TOOL_MAP, instructionsForAgentMemory, instructionsText } from "@breatic/domain";

describe("the system prompt", () => {
  // The template is hard-wrapped, so any phrase long enough to be worth
  // asserting on may carry a newline in the middle of it. Collapsing runs of
  // whitespace keeps these assertions about the wording rather than about
  // where the lines happen to break.
  const wording = (): string => buildSystemPrompt().replace(/\s+/g, " ");

  it("introduces Breatic by its positioning line", () => {
    expect(wording()).toContain("the real-time collaborative AI workspace for creative teams");
  });

  it("names every product term that stays English in any language", () => {
    // The same vocabulary the interface keeps in English
    // (packages/web/AGENTS.md#product-terms-are-never-translated): a reply
    // that calls a Space a translated word describes a screen the user
    // cannot find.
    const terms = [
      "Studio", "Project", "Collection", "Space", "Work", "Canvas", "Document", "Timeline",
      "Agent", "Slug", "Owner", "Editor", "Viewer", "Admin", "Maintainer", "Guest",
    ];
    const text = wording();
    expect(text).toMatch(/stay in English in every language/i);
    for (const term of terms) expect(text).toContain(term);
  });

  it("repeats the product-term rule under every user message", () => {
    // From the system prompt alone the model still echoed the translated word
    // a user had just typed (a Chinese question about a Space got its
    // translation back in the first clause); the line under the user's own
    // words is what it reads last.
    expect(USER_LANGUAGE_REMINDER).toMatch(/product terms .*English/i);
  });

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

  it("names none of the product's tools, in the whole prompt the model is sent (#1363)", () => {
    // The drift this prevents: a roster in the prompt outliving the tool set.
    // Checked against every registered tool rather than a copy of the list,
    // and against the prompt as the model reads it -- base, memory entries
    // and progress note together -- so a tool name reaching it through any
    // part fails here. The tools the Agent keeps its own memory and context
    // with are the one exception: the memory protocol says when to use each.
    const AGENT_RUNTIME = new Set(["save_memory", "delete_memory", "read_memory", "search_conversations", "read_conversation"]);
    const contexts = [
      { entries: [], migrated: [], olderCount: 0, progress: "" },
      { entries: [{ id: "44444444-4444-4444-8444-444444444444", title: "Palette" }], migrated: [], olderCount: 3, progress: "Settled the look." },
      { entries: [], migrated: [{ id: "55555555-5555-4555-8555-555555555555", title: "Earlier project memory", content: "Noir short." }], olderCount: 0, progress: "" },
    ];
    for (const memory of contexts) {
      const prompt = instructionsText(instructionsForAgentMemory(buildSystemPrompt(), memory));
      for (const name of Object.keys(TOOL_MAP).filter((n) => !AGENT_RUNTIME.has(n))) {
        expect(prompt).not.toContain(name);
      }
    }
  });
});

describe("what the prompt says about the Agent's memory (#1363)", () => {
  const wording = (): string => buildSystemPrompt().replace(/\s+/g, " ");

  it("has a memory protocol on every turn, whatever memory there is", () => {
    expect(buildSystemPrompt()).toContain("## Memory");
  });

  it("says to save what the user asks to remember, replacing the entry on the same thing", () => {
    expect(wording()).toMatch(/asks you to remember something, save it with save_memory/);
    expect(wording()).toMatch(/pass its id to replace it/);
  });

  it("says to delete what the user asks to forget, or says is wrong", () => {
    expect(wording()).toMatch(/forget something, or says an entry is wrong, remove it with delete_memory/);
  });

  it("says to read an entry in full before relying on it, and how to find one not listed", () => {
    expect(wording()).toMatch(/read_memory before you rely on it/);
    expect(wording()).toMatch(/not listed can be found with read_memory by words/);
  });

  it("says turns that left the context are read with read_conversation", () => {
    expect(wording()).toMatch(/left your context are read with read_conversation/);
  });
});

describe("what the prompt says the model can do", () => {
  const wording = (): string => buildSystemPrompt().replace(/\s+/g, " ");

  it("carries no written-out list of capabilities", () => {
    // What the model can do is what its tools are, and each tool says so in
    // its own description. A list written here is a second copy, and it had
    // already drifted from the tools three times.
    expect(buildSystemPrompt()).not.toMatch(/Capabilities/i);
    expect(wording()).not.toMatch(/Search for reference materials/i);
    expect(wording()).not.toMatch(/Analyze reference images/i);
  });

  it("says what the product is, and where the model sits in it", () => {
    expect(wording()).toMatch(/project/i);
    expect(wording()).toMatch(/canvas/i);
    expect(wording()).toMatch(/document/i);
  });

  it("says nothing of what the model can or cannot see: the open Space comes with each message and the tools read the rest", () => {
    expect(wording()).not.toMatch(/\b(can|cannot|can't) see\b/i);
  });
});

describe("what the prompt says the model's job is", () => {
  // Without a stated job the model answered as a general assistant: asked to
  // scale a canvas picture, it gave a command line, another app and a website,
  // then wrote a web page for the user to screenshot (#1366).
  const wording = (): string => buildSystemPrompt().replace(/\s+/g, " ");

  it("says the job is to help the user make what they set out to make, with what Breatic can do", () => {
    expect(wording()).toMatch(/Your job is to help the user make what they set out to make, with what Breatic can do/);
  });

  it("keeps work Breatic does inside Breatic", () => {
    expect(wording()).toMatch(/Never send them to another program, a command line or a website for work Breatic does/);
  });

  it("says the model does not write programs, scripts or web pages for the user", () => {
    expect(wording()).toMatch(/You do not write programs, scripts or web pages for the user/);
  });

  it("says to find out before answering, not to answer from memory", () => {
    expect(wording()).toMatch(/Find out before you answer/);
    expect(wording()).toMatch(/do not answer from memory/);
  });

  it("says to find the cause before suggesting a fix", () => {
    expect(wording()).toMatch(/find out why before you suggest a fix/);
    expect(wording()).toMatch(/Do not guess a cause and have the user try one thing after another/);
  });

  it("keeps what was checked apart from what was not", () => {
    expect(wording()).toMatch(/Keep what you checked apart from what you did not/);
    expect(wording()).toMatch(/never present something that might work as something that will/);
  });

  it("asks for steps naming the node, menu row, button, value and what the user will see", () => {
    expect(wording()).toMatch(/which node, which menu row, which button, what value, and what they will see when it worked/);
  });

  it("asks to carry the work through and name where Breatic falls short, with the nearest result", () => {
    expect(wording()).toMatch(/Carry it through to the result they want/);
    expect(wording()).toMatch(/Where Breatic falls short of what they asked, say so plainly and give the nearest result it can give/);
  });

  it("asks only for what only the user can tell, and why", () => {
    expect(wording()).toMatch(/Do not hand your own legwork to the user/);
    expect(wording()).toMatch(/Ask only for what only they can tell you/);
  });

  it("asks for the result, not the reasons it might fail", () => {
    expect(wording()).toMatch(/Answer with the result, not with reasons it might fail/);
  });
});

describe("how the prompt says to write a reply", () => {
  const wording = (): string => buildSystemPrompt().replace(/\s+/g, " ");

  it("asks for the language of the user's latest message in everything the user reads or edits", () => {
    expect(wording()).toMatch(/Use the language of the user's latest message for everything the user will read or edit/);
    expect(wording()).toMatch(/every piece of text you hand a tool that ends up on the user's screen, such as a prompt/);
  });

  it("names the two exceptions to the user's language", () => {
    expect(wording()).toMatch(/text whose language the work itself sets/);
    expect(wording()).toMatch(/a language the user asks for/);
  });

  it("leaves the language of the model's own working to the model", () => {
    expect(wording()).not.toMatch(/your reasoning/i);
  });

  it("says HTML is not rendered and goes in an html fence", () => {
    expect(wording()).toMatch(/HTML is not rendered/i);
    expect(wording()).toContain("```html");
  });

  it("says formulas go between double dollars, and a lone dollar is a dollar", () => {
    expect(wording()).toContain("$$");
    expect(wording()).toMatch(/lone `\$` is a dollar sign/i);
  });

  it("shows a formula that stands alone with each $$ on a line by itself", () => {
    // remark-math renders `$$E=mc^2$$` on one line as inline math; only a line
    // holding nothing but `$$` opens a display formula.
    expect(buildSystemPrompt()).toMatch(/\n\$\$\n[^\n$]+\n\$\$\n/);
    expect(wording()).toMatch(/not on one line/i);
  });

  it("shows a single letter inside a sentence written with double dollars", () => {
    // A real turn wrote "where $a$ and $b$ are the legs" and the user saw the
    // dollars: the rule alone did not reach the one-letter case.
    expect(wording()).toContain("$$a$$");
    expect(wording()).toMatch(/not `\$a\$`/);
  });

  it("says a code fence names its language", () => {
    expect(wording()).toMatch(/language on every code fence/i);
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
