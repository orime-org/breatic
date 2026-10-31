// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * What a tool is for, and how to use it, is said in its own description.
 *
 * The system prompt says how to behave with tools in general and nothing
 * about any one of them. Guidance about one tool written anywhere else is a
 * second copy of the description, and the two drift. So what the prompt used
 * to say about asking the user, citing search sources and proposing canvas
 * work lives here, with the tool it is about.
 */
import { describe, expect, it } from "vitest";

import { makeAskUserTool } from "@domain/agent/tools/ask-user.js";
import { NO_TOOL_CONTEXT } from "@domain/agent/tools/index.js";
import { judgeLikelihood } from "@domain/agent/tools/judge-likelihood.js";
import { makeProposeCanvasAction } from "@domain/agent/tools/propose-canvas-action.js";
import { makeSearchTools } from "@domain/agent/tools/web-search.js";

/**
 * A description with its hard wraps folded, so assertions are about wording.
 *
 * The SDK also allows a description computed per call; these tools declare a
 * string, and anything else reads as empty so the assertions below fail.
 * @param description - The description as declared.
 * @returns It on one line.
 */
function flat(description: unknown): string {
  return typeof description === "string" ? description.replace(/\s+/g, " ") : "";
}

describe("ask_user says how to ask", () => {
  const askUser = makeAskUserTool(NO_TOOL_CONTEXT);
  const said = (): string => flat(askUser.description);

  it("says the turn waits at the card, and when that is worth it", () => {
    expect(said()).toMatch(/turn waits at the card/i);
    expect(said()).toMatch(/not to fill a pause/i);
  });

  it("says what comes back: the answers, or word that the reader wrote a message instead", () => {
    expect(said()).toMatch(/the user's answers/i);
    expect(said()).toMatch(/wrote a message instead/i);
    expect(said()).toMatch(/may answer the card or be about something else/i);
  });

  it("says to call it once, with one to four questions in the call", () => {
    expect(said()).toMatch(/one to four questions in a single call/i);
    expect(said()).toMatch(/call it once/i);
  });

  it("says the questions and options go in the call, and that the card adds the Other line", () => {
    expect(said()).toMatch(/every question here rather than writing it yourself/i);
    expect(said()).toMatch(/adds an Other line/i);
  });

  it("says how the card numbers the questions", () => {
    expect(said()).toMatch(/numbered from 1/i);
  });

  it("says when an option earns media, and that a question carries it on all options or none", () => {
    expect(said()).toMatch(/seen or heard to be understood/i);
    expect(said()).toMatch(/on every option of that question or on none/i);
  });
});

describe("web_search says how to cite what it found", () => {
  const said = (): string => flat(makeSearchTools().web_search.description);

  it("asks for a marker the panel can resolve", () => {
    // The panel turns `[N]` into a chip for the source numbered N.
    expect(said()).toContain("[1]");
  });

  it("says the sources are shown by the panel, so the reply does not list them", () => {
    expect(said()).toMatch(/do not list their addresses/i);
  });

  it("says what the numbers count, and that they do not carry across replies", () => {
    expect(said()).toMatch(/share one run of numbers/i);
    expect(said()).toMatch(/an earlier reply used stands for something else/i);
    expect(said()).toMatch(/never write a number no source arrived with/i);
  });
});

describe("propose_canvas_action says what the canvas is for", () => {
  const said = (): string => flat(makeProposeCanvasAction().description);

  it("says what the canvas is", () => {
    expect(said()).toMatch(/canvas is where models are run/i);
  });

  it("keeps copy that belongs to a canvas job with the rest of it", () => {
    expect(said()).toMatch(/rather than half in your reply/i);
  });

  it("writes the steps after placing from the product guide", () => {
    expect(said()).toMatch(/numbered steps[^.]*get_product_guide/i);
  });
});

describe("judge_likelihood says when to use it", () => {
  const said = (): string => flat(judgeLikelihood.description);

  it("says it is for when the model is unsure, with cases", () => {
    expect(said()).toMatch(/Use it when you are unsure/);
    expect(said()).toMatch(/several readings/i);
  });

  it("says where it stops and asking the reader starts", () => {
    expect(said()).toMatch(/Asking the reader is for what only they know/);
  });
});
