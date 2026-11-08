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
import { TOOL_MAP, instructionsForAgentMemory, instructionsText, modelCatalog } from "@breatic/domain";
import { SpaceTypeSchema } from "@breatic/shared";

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

  it("introduces the Agent as making work together with the user, not as a creative collaborator", () => {
    expect(wording()).toContain("You make work together with the user.");
    expect(wording()).not.toMatch(/You are a creative collaborator/);
    expect(wording()).not.toMatch(/You are not a task dispatcher/);
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

  it("says the job is to help the user with their own work, with what Breatic can do", () => {
    expect(wording()).toMatch(/Your job is to help the user with their own work, with what Breatic can do\./);
  });

  it("says the work is done here only when the user wants something made, not for every message", () => {
    // The old opening said every user comes with a problem about their own
    // work and wants it done; a question then got a piece of work back
    // (breatic#1361).
    expect(wording()).toMatch(/When they want something made, the answer they want is that work done here, in this Project/);
    expect(wording()).not.toMatch(/They come with a concrete problem about their own work/);
    expect(wording()).not.toMatch(/Your job is to help the user make what they set out to make/);
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

  it("carries the work through only when the user wants something made", () => {
    const text = wording();
    expect(text).toContain(
      "When they want something made, carry it through to the result they want: check the whole path, its limits and what each step can and cannot do.",
    );
    // No unconditional form left anywhere: every "carry it through" is the
    // conditional one.
    const all = [...text.matchAll(/carry it through to the result they want/gi)];
    expect(all.length).toBeGreaterThan(0);
    for (const m of all) {
      expect(text.slice(Math.max(0, m.index - "When they want something made, ".length), m.index)).toBe("When they want something made, ");
    }
  });

  it("drops the two bullets the How You Co-create section replaces (breatic#1361)", () => {
    expect(wording()).not.toMatch(/Before you make something, check what the user's words leave open/);
    expect(wording()).not.toMatch(/Answer the question in the user's own words/);
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

/** Collapses runs of whitespace so assertions do not depend on line breaks. */
const flat = (text: string): string => text.replace(/\s+/g, " ").trim();

/**
 * The raw prompt text from a heading up to the next heading of the same or a
 * higher level, or "" when the heading is absent.
 */
const section = (heading: string): string => {
  const prompt = buildSystemPrompt();
  const at = prompt.indexOf(`\n${heading}\n`);
  if (at < 0) return "";
  const level = heading.indexOf(" ");
  const rest = prompt.slice(at + heading.length + 2);
  const next = rest.search(new RegExp(`\\n#{1,${level}} `));
  return next < 0 ? rest : rest.slice(0, next);
};

describe("how the prompt says to co-create (breatic#1361)", () => {
  // Asked "what style is this?", the Agent answered and then reviewed the
  // user's choices and planned their next step; asked for a character, it
  // either guessed what only the user knows or asked for what a skilled maker
  // settles. The section sorts a message before acting on it and sorts what a
  // request to make leaves open, each kind with its own answer.
  const text = (): string => flat(section("## How You Co-create"));

  /**
   * One bullet of the section, from its opening words up to the next one's.
   * @param start - The words the bullet opens with.
   * @param next - The words the bullet after it opens with.
   * @returns The bullet, whitespace folded, or "" when either is absent.
   */
  const bullet = (start: string, next: string): string => {
    const all = text();
    const from = all.indexOf(start);
    const to = all.indexOf(next, from + 1);
    return from < 0 || to < 0 ? "" : all.slice(from, to).trim();
  };

  /** The bullet on what only the user knows. */
  const onlyTheUserKnows = (): string => bullet("- What only the user knows:", "- Taste with no right answer");

  /** The paragraph that says to try things cheaply. */
  const tryCheaply = (): string => bullet("Try things cheaply.", "Choose for each step");

  it("has a How You Co-create section", () => {
    expect(buildSystemPrompt()).toContain("\n## How You Co-create\n");
  });

  it("says the work is the user's: they decide, the Agent brings the craft", () => {
    expect(text()).toContain("The work is the user's.");
    expect(text()).toContain("they decide what it is and how it looks or sounds, and you bring the craft and do the making");
  });

  it("sorts a message into one of four things, silently, before acting on it", () => {
    expect(text()).toContain("Before you act on a message, tell for yourself which of four things it is; the sorting stays with you and never goes in the reply.");
    expect(text()).toContain("- A question (what something is, how to do something, why something happened, what you think)");
    expect(text()).toContain("- A change to something that exists: change only what they named and keep the original.");
    expect(text()).toContain("- Something to make: settle what is open, then make it.");
  });

  it("answers something the user tells briefly, as a person would, offers to make nothing and leaves making something of it to them", () => {
    expect(text()).toContain("- Something they tell you (news, a plan, how something went): answer it briefly, as a person would, and stop. Do not offer to make anything; whether to make something of it is theirs to say.");
  });

  it("answers a question in the words it was asked and stops, without making, proposing, planning or reviewing", () => {
    expect(text()).toContain("answer it in the words it was asked, at the length it needs, and stop.");
    expect(text()).toContain("Do not make, propose, plan their next step or review their earlier choices.");
  });

  it("never offers to make anything in answer to a question, and never spends the one extra sentence on an offer", () => {
    expect(text()).toContain("Do not make, propose, plan their next step or review their earlier choices. Do not offer to make anything. Something they did not ask goes in one sentence at the end, only when their next step would go wrong without it; an offer of more work is never that sentence.");
  });

  it("ends both a reply to something told and an answer to a question by never closing with an offer", () => {
    const NO_OFFER = "Never close with an offer (\"if you like, I can …\").";
    expect(bullet("- Something they tell you", "- A question").slice(-NO_OFFER.length)).toBe(NO_OFFER);
    expect(bullet("- A question", "- A change to something that exists").slice(-NO_OFFER.length)).toBe(NO_OFFER);
  });

  it("notes another problem in a change in one sentence without fixing it", () => {
    expect(text()).toContain("Another problem you notice goes in one sentence; do not fix it.");
  });

  it("sorts what a request to make leaves open into three kinds, each with its own answer", () => {
    expect(text()).toContain("What a request to make leaves open is one of three kinds, each with its own answer.");
  });

  it("asks what only the user knows all at once and saying why", () => {
    expect(text()).toContain("Look first in what they sent, the Space they have open and your memory.");
    expect(text()).toContain("Ask what is still open all at once: only what changes the result, and say why you ask.");
    expect(text()).not.toContain("who a character of theirs is is never one");
  });

  it("opens what only the user knows with who a character of theirs is, robots and creatures having these too, never assumed", () => {
    expect(text()).toContain("- What only the user knows: who a character of theirs is (age, gender, role in their story; a robot or a creature has these too), which you never assume");
    expect(onlyTheUserKnows()).not.toContain("a robot or a creature too)");
  });

  it("assumes a small point outside what only the user knows, and never counts who a character is as one", () => {
    // Inside that bullet the small-point sentence read as one more thing only
    // the user knows, and a character's age or gender was assumed as small.
    expect(onlyTheUserKnows()).not.toContain("A small point");
    expect(text()).toContain("A small point that changes little of the result, assume and say so; who a character is is never such a point.");
  });

  it("asks only whether existing work exists and to see it, and treats the look with none as taste, never a list", () => {
    const sentence = "Of work that already exists, ask only whether there is some and to see it; with none, the look is a taste, answered by takes, never by a list of looks to pick from.";
    expect(text()).toContain(sentence);
    const at = text().indexOf(sentence);
    expect(at).toBeGreaterThan(text().indexOf("- What only the user knows:"));
    expect(at).toBeLessThan(text().indexOf("- Taste with no right answer"));
  });

  it("answers taste with two or three clearly different takes and builds on the one picked", () => {
    expect(text()).toContain("- Taste with no right answer");
    expect(text()).toContain("make two or three clearly different takes at the first step where it decides the result");
    expect(text()).toContain("build the later steps on the one they pick");
    expect(text()).toContain("Ask it in words only when no take can be made without it.");
  });

  it("counts a shape or build and a mood among the tastes", () => {
    expect(text()).toContain("- Taste with no right answer (a look, a shape or build, a palette, a voice, a mood, a melody, a tone):");
  });

  it("asks what only the user knows first when taste is open too, and makes the takes after the answer", () => {
    expect(text()).toContain("- When what only the user knows and a taste are both open, ask first, and make the takes once they have answered.");
  });

  it("keeps the craft as the Agent's own, done completely and visible before anything is spent", () => {
    expect(text()).toContain("- The craft: every prompt written in full");
    expect(text()).toContain("This is yours: do it completely, where they can look it over and change it before anything is spent.");
  });

  it("confirms which of two readings is meant before acting on either", () => {
    expect(text()).toContain("(a 3D look, or a 3D model), confirm which before you act on either.");
  });

  it("shows several steps with what each makes and costs before anything is spent", () => {
    expect(text()).toContain("Work of several steps: show the steps, what each makes and what it costs, before anything is spent.");
  });

  it("tries things cheaply and makes full quality from the picked take or when asked", () => {
    expect(text()).toContain("Try things cheaply.");
    expect(tryCheaply()).not.toContain("that still shows the difference");
    expect(tryCheaply()).toContain("made at the lowest cost: every setting the model list marks as setting the price, at the value it names as lowest, on a fast and cheap model.");
    expect(text()).toContain("Full quality is made from the take they picked, keeping it as it is, or straight away when they ask for it.");
  });

  it("chooses a model that can do the step and names a model's limit as the model's, not Breatic's", () => {
    expect(text()).toContain("Choose for each step a model that can do what it asks.");
    expect(text()).toContain("say that it is this model's limit, not Breatic's, and name a model that does it better.");
  });

  it("recommends and leaves the decision to the user", () => {
    expect(text()).toContain("Recommend; they decide.");
    expect(text()).toContain("show it to them rather than settling it quietly");
  });

  it("judges Breatic by what the user will see and hear, with the nearest result where it falls short", () => {
    expect(text()).toContain("Judge what Breatic can do by what the user will see and hear, not by how a studio would make it.");
    expect(text()).toContain("Where it falls short of what they asked, say so plainly and give the nearest result it can give.");
  });
});

describe("what the prompt says per medium (breatic#1361)", () => {
  const MEDIA = ["Pictures", "Video", "Audio", "Writing in a Document", "Timeline", "3D"] as const;
  const FIELDS = ["Ask:", "Takes:", "Craft:", "Keep:", "Reach:"] as const;

  /** Each paragraph under By medium, keyed by the name it opens with. */
  const paragraphs = (): Map<string, string> => {
    const out = new Map<string, string>();
    for (const raw of section("### By medium").split(/\n\s*\n/)) {
      const para = flat(raw);
      const name = /^(.+?)\. Ask:/.exec(para)?.[1];
      if (name !== undefined) out.set(name, para);
    }
    return out;
  };

  it("has a By medium section inside How You Co-create", () => {
    expect(section("## How You Co-create")).toContain("\n### By medium\n");
  });

  it("has one paragraph per medium, each with Ask, Takes, Craft, Keep and Reach in that order", () => {
    const found = paragraphs();
    expect([...found.keys()]).toEqual([...MEDIA]);
    for (const medium of MEDIA) {
      const para = found.get(medium) ?? "";
      const at = FIELDS.map((field) => para.indexOf(field));
      for (const [i, field] of FIELDS.entries()) expect(at[i], `${medium} lacks ${field}`).toBeGreaterThan(-1);
      expect(at, `${medium} fields out of order`).toEqual([...at].sort((a, b) => a - b));
    }
  });

  it("has a long piece start as an outline or two openings for the user to pick, and settles a tone by openings, not a question", () => {
    const para = paragraphs().get("Writing in a Document") ?? "";
    expect(para).toContain("Craft: a long piece starts as an outline, or as two short openings in different tones, for them to pick, and the full text is written once they have picked; a tone is settled by those openings, never by a question; the piece in their own voice.");
    expect(para).not.toContain("an outline before a long piece, for them to approve");
  });

  it("asks in 3D whether they want a look or a model even when they say model", () => {
    const ask = ((paragraphs().get("3D") ?? "").split("Takes:")[0] ?? "").trim();
    expect(ask).toContain("Ask: whether they want a 3D look in pictures or video, or a model to place in a 3D scene; ask it even when they say model, since Breatic does not make models.");
  });

  it("says in the 3D Reach that Breatic does not make 3D models yet", () => {
    const reach = (paragraphs().get("3D") ?? "").split("Reach:")[1] ?? "";
    expect(reach).toContain("Breatic does not make 3D models yet");
  });

  it("says in the Timeline Reach that a timeline holds video clips", () => {
    const reach = (paragraphs().get("Timeline") ?? "").split("Reach:")[1] ?? "";
    expect(reach).toContain("a timeline holds video clips");
  });

  // The template guard: a new Space type or a new model medium has to be
  // given a paragraph here, or this fails. The table is written out rather
  // than derived so adding a type forces someone to decide where it goes.
  const SPACE_TYPE_TO_MEDIA: Record<string, readonly string[]> = {
    canvas: ["Pictures", "Video", "Audio"],
    document: ["Writing in a Document"],
    timeline: ["Timeline"],
    "3d": ["3D"],
  };
  const MODALITY_TO_MEDIUM: Record<string, string> = {
    image: "Pictures",
    video: "Video",
    audio: "Audio",
    tts: "Audio",
    three_d: "3D",
  };

  it("maps every Space type to a medium paragraph the prompt has", () => {
    const found = paragraphs();
    for (const type of SpaceTypeSchema.options) {
      const media = SPACE_TYPE_TO_MEDIA[type];
      expect(media, `Space type "${type}" has no medium paragraph mapped`).toBeDefined();
      for (const medium of media ?? []) expect(found.has(medium), `"${medium}" (for ${type}) missing from the prompt`).toBe(true);
    }
  });

  it("maps every model modality to a medium paragraph the prompt has", () => {
    const found = paragraphs();
    for (const modality of modelCatalog.MODALITIES) {
      const medium = MODALITY_TO_MEDIUM[modality];
      expect(medium, `modality "${modality}" has no medium paragraph mapped`).toBeDefined();
      expect(found.has(medium ?? ""), `"${medium}" (for ${modality}) missing from the prompt`).toBe(true);
    }
  });
});
