// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * One tool asks the user something, and its arguments are the card.
 *
 * The questions and their options are drawn as a questionnaire the reader can
 * click, so the shape of that card is decided here rather than requested of
 * the model: one to four questions, each with a short label, up to five
 * options, and pictures or sounds only from places we can vouch for.
 *
 * The tool has no `execute`: a call to it is a question waiting for the
 * reader, and the answer comes back as its result in a later request.
 */
import { describe, it, expect } from "vitest";

import { makeAskUserTool } from "@domain/agent/tools/ask-user.js";
import { TOOL_MAP, BASELINE_TOOLS } from "@domain/agent/tools/index.js";

const ALLOWED = "https://cdn.example.test/";

/** One turn's tool, vouching for media under one prefix. */
const askUser = makeAskUserTool({ mediaUrlAllowed: (url) => url.startsWith(ALLOWED) });

/** The schema, in the one shape a test can call. */
const schema = askUser.inputSchema as unknown as {
  safeParse: (value: unknown) => { success: boolean; error?: { issues: Array<{ message: string }> } };
};

/**
 * Whether the tool accepts these arguments.
 * @param value - What the model would have sent.
 * @returns True when the schema lets it through.
 */
function accepts(value: unknown): boolean {
  return schema.safeParse(value).success;
}

/**
 * What the schema says about arguments it refuses.
 * @param value - What the model would have sent.
 * @returns Every issue message, joined.
 */
function refusal(value: unknown): string {
  const parsed = schema.safeParse(value);
  return (parsed.error?.issues ?? []).map((issue) => issue.message).join("\n");
}

/**
 * One question with sensible defaults.
 * @param over - Fields to replace.
 * @returns A question object.
 */
function question(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    header: "Style",
    question: "Which style should the picture take?",
    options: [{ label: "Cyberpunk" }, { label: "Warm film" }],
    ...over,
  };
}

/**
 * An option carrying an image under the given address.
 * @param label - The option's label.
 * @param url - Where the image is.
 * @returns An option object.
 */
function imageOption(label: string, url: string): Record<string, unknown> {
  return { label, media: { kind: "image", url } };
}

describe("the one name this tool has", () => {
  it("is ask_user in the registry and in the list a chat turn is offered", () => {
    expect(Object.keys(TOOL_MAP)).toContain("ask_user");
    expect(BASELINE_TOOLS).toContain("ask_user");
  });
});

describe("the questions", () => {
  it("are one to four", () => {
    expect(accepts({ questions: [] })).toBe(false);
    expect(accepts({ questions: [question()] })).toBe(true);
    expect(accepts({ questions: [question(), question(), question(), question()] })).toBe(true);
    expect(accepts({ questions: [question(), question(), question(), question(), question()] })).toBe(false);
  });

  it("each have a question of one line up to 200 characters", () => {
    expect(accepts({ questions: [question({ question: "a".repeat(200) })] })).toBe(true);
    expect(accepts({ questions: [question({ question: "a".repeat(201) })] })).toBe(false);
    expect(accepts({ questions: [question({ question: "Which?\n1. Fast" })] })).toBe(false);
    expect(accepts({ questions: [question({ question: "   " })] })).toBe(false);
  });

  it("each have a label of one line up to 12 characters", () => {
    expect(accepts({ questions: [question({ header: "a".repeat(12) })] })).toBe(true);
    expect(accepts({ questions: [question({ header: "a".repeat(13) })] })).toBe(false);
    expect(accepts({ questions: [question({ header: undefined })] })).toBe(false);
  });

  it("are single choice unless they say otherwise", () => {
    const parsed = (askUser.inputSchema as unknown as {
      parse: (v: unknown) => { questions: Array<{ multiSelect: boolean }> };
    }).parse({ questions: [question()] });
    expect(parsed.questions[0]?.multiSelect).toBe(false);
  });
});

describe("the options", () => {
  it("are zero to five, zero being an open question", () => {
    expect(accepts({ questions: [question({ options: [] })] })).toBe(true);
    expect(accepts({ questions: [question({ options: [{ label: "Only one" }] })] })).toBe(true);
    const six = Array.from({ length: 6 }, (_, i) => ({ label: `Option ${String(i)}` }));
    expect(accepts({ questions: [question({ options: six })] })).toBe(false);
  });

  it("are at least two on a question that takes several", () => {
    expect(accepts({ questions: [question({ multiSelect: true, options: [{ label: "A" }] })] })).toBe(false);
    expect(accepts({ questions: [question({ multiSelect: true, options: [{ label: "A" }, { label: "B" }] })] })).toBe(
      true,
    );
  });

  it("each have a label of one line up to 60 characters and an optional line of description up to 120", () => {
    expect(accepts({ questions: [question({ options: [{ label: "a".repeat(60) }] })] })).toBe(true);
    expect(accepts({ questions: [question({ options: [{ label: "a".repeat(61) }] })] })).toBe(false);
    expect(accepts({ questions: [question({ options: [{ label: "A", description: "d".repeat(120) }] })] })).toBe(
      true,
    );
    expect(accepts({ questions: [question({ options: [{ label: "A", description: "d".repeat(121) }] })] })).toBe(
      false,
    );
  });
});

describe("pictures and sounds on options", () => {
  it("are on every option of a question or on none", () => {
    const all = [imageOption("A", `${ALLOWED}a.png`), imageOption("B", `${ALLOWED}b.png`)];
    const some = [imageOption("A", `${ALLOWED}a.png`), { label: "B" }];
    expect(accepts({ questions: [question({ options: all })] })).toBe(true);
    expect(accepts({ questions: [question({ options: some })] })).toBe(false);
  });

  it("are an image, an audio clip or a video, a video optionally with a cover", () => {
    const options = [
      { label: "Sea", media: { kind: "video", url: `${ALLOWED}sea.mp4`, poster: `${ALLOWED}sea.jpg` } },
      { label: "Beat", media: { kind: "audio", url: `${ALLOWED}beat.mp3` } },
    ];
    expect(accepts({ questions: [question({ options })] })).toBe(true);
    const wrongKind = [{ label: "Doc", media: { kind: "pdf", url: `${ALLOWED}a.pdf` } }];
    expect(accepts({ questions: [question({ options: wrongKind })] })).toBe(false);
  });

  it("come only from an address we vouch for, and a refusal names the address and the sources allowed", () => {
    const foreign = "https://elsewhere.test/a.png";
    const options = [imageOption("A", foreign), imageOption("B", `${ALLOWED}b.png`)];
    expect(accepts({ questions: [question({ options })] })).toBe(false);
    const said = refusal({ questions: [question({ options })] });
    expect(said).toContain(foreign);
    expect(said).toContain("our storage");
    expect(said).toContain("search_images");
  });

  it("hold a cover to the same rule as the video itself", () => {
    const options = [
      { label: "Sea", media: { kind: "video", url: `${ALLOWED}sea.mp4`, poster: "https://elsewhere.test/c.jpg" } },
    ];
    expect(accepts({ questions: [question({ options })] })).toBe(false);
  });

  it("are checked when the call arrives, so an address vouched for during the turn passes", () => {
    const vouched = new Set<string>();
    const tool = makeAskUserTool({ mediaUrlAllowed: (url) => vouched.has(url) });
    const parse = (tool.inputSchema as unknown as { safeParse: (v: unknown) => { success: boolean } }).safeParse;
    const options = [imageOption("A", "https://found.test/a.png"), imageOption("B", "https://found.test/b.png")];
    expect(parse({ questions: [question({ options })] }).success).toBe(false);
    vouched.add("https://found.test/a.png");
    vouched.add("https://found.test/b.png");
    expect(parse({ questions: [question({ options })] }).success).toBe(true);
  });
});

describe("what the model may not send", () => {
  it("is refused rather than dropped when a field is not in the schema", () => {
    expect(accepts({ questions: [question()], howToAnswer: "Pick one" })).toBe(false);
    expect(accepts({ questions: [question({ choices: ["A"] })] })).toBe(false);
  });

  it("is the old single-question shape, which this tool no longer takes", () => {
    expect(accepts({ question: "Which pace?", options: ["Fast", "Slow"] })).toBe(false);
  });
});

describe("how the tool runs", () => {
  it("has no execute, so a call waits for the reader's answer", () => {
    expect((askUser as { execute?: unknown }).execute).toBeUndefined();
  });

  it("tells the model the card numbers its questions from one and that a typed reply may point at them", () => {
    expect(askUser.description).toMatch(/numbered from 1/);
    expect(askUser.description).toMatch(/by (its|their) number/);
  });

  it("tells the model the card adds the numbers, so a header and a question carry none", () => {
    expect(askUser.description).toMatch(/write no number/i);
    const shape = (askUser.inputSchema as unknown as { shape: { questions: { element: { shape: Record<string, { description?: string }> } } } })
      .shape.questions.element.shape;
    expect(shape.header?.description).toMatch(/no number/i);
    expect(shape.question?.description).toMatch(/no number/i);
  });

  it("tells the model each answer names its question by an index counting from 0", () => {
    expect(askUser.description).toMatch(/`index`[^.]*counting from 0/);
  });
});
