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

import { askUser } from "@domain/agent/tools/ask-user.js";
import { judgeLikelihood } from "@domain/agent/tools/judge-likelihood.js";
import { proposeCanvasAction } from "@domain/agent/tools/propose-canvas-action.js";
import { makeSearchTools } from "@domain/agent/tools/web-search.js";

/**
 * What one input field of a tool says about itself.
 * @param schema - The tool's input schema, as declared.
 * @param field - The field.
 * @returns Its `.describe()` text on one line, or empty when it has none.
 */
function fieldSays(schema: unknown, field: string): string {
  const shape = (schema as { shape?: Record<string, { description?: unknown }> }).shape;
  return flat(shape?.[field]?.description);
}

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
  const said = (): string => flat(askUser.description);

  it("says it ends the turn, and when that is worth it", () => {
    expect(said()).toMatch(/ends your turn/i);
    expect(said()).toMatch(/not to fill a pause/i);
  });

  it("says why the question and the answers go in the call", () => {
    expect(said()).toMatch(/arrives twice/i);
    expect(said()).toMatch(/run-on sentence with nothing to pick from/i);
  });

  it("points at the field that tells the reader how to answer", () => {
    expect(said()).toMatch(/howToAnswer/);
  });

  it("says in that field what the line tells the reader, whose words and whose language", () => {
    const line = fieldSays(askUser.inputSchema, "howToAnswer");
    expect(line).toMatch(/a number will do/i);
    expect(line).toMatch(/answer in their own words instead/i);
    expect(line).toMatch(/in the language you are replying in/i);
  });
});

describe("web_search says how to cite what it found", () => {
  const said = (): string => flat(makeSearchTools().web_search.description);

  it("asks for a marker the panel can resolve", () => {
    // The panel turns `[N]` into a chip for the source numbered N.
    expect(said()).toContain("[1]");
  });

  it("says what the numbers count, and that they do not carry across replies", () => {
    expect(said()).toMatch(/share one run of numbers/i);
    expect(said()).toMatch(/an earlier reply used stands for something else/i);
    expect(said()).toMatch(/never write a number no source arrived with/i);
  });
});

describe("propose_canvas_action says what the canvas is for", () => {
  const said = (): string => flat(proposeCanvasAction.description);

  it("says what the canvas is", () => {
    expect(said()).toMatch(/canvas is where models are run/i);
  });

  it("keeps copy that belongs to a canvas job with the rest of it", () => {
    expect(said()).toMatch(/rather than half in your reply/i);
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
