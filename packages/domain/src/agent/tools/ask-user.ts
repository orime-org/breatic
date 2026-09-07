// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Ask-user tool — put a question to the reader and end the turn there.
 */
import { tool, type Tool } from "ai";
import { z } from "zod";

/**
 * One line, counting every character a line can end on.
 *
 * A carriage return ends a line the way a newline does, so a value carrying one
 * is two lines wherever it is read. One option is one line and one question is
 * one line, which is what keeps a list of five from arriving as a wall of text.
 * What a line renders as is settled where the paragraph is drawn, by a
 * serialiser that owns the whole of CommonMark.
 */
const ONE_LINE = /^[^\n\r\u2028\u2029]+$/;

/**
 * One line of what the reader will read: not blank, and one line.
 * @param max - How many characters this line may run to.
 * @returns A schema accepting one such line no longer than that.
 */
const line = (max: number): z.ZodString => z.string().trim().min(1).max(max).regex(ONE_LINE);

const inputSchema = z
  .object({
    question: line(200).describe("The question to ask the user, in one line"),
    options: z
      .array(line(60))
      // A ceiling and nothing else, because a ceiling is what the model is
      // shown: `zodSchema` renders this array as `maxItems` and drops a
      // `.refine` on the way, so a floor enforced here would refuse calls over
      // a rule that never reached the model. Empty is an open question, and one
      // is drawn as a list of one.
      .max(5)
      .optional()
      .describe("Up to five answers to choose from, one line each"),
    howToAnswer: line(120)
      .optional()
      .describe(
        "One line telling the user how to answer, in your own words and in " +
          "the language you are replying in. Drawn on its own under the " +
          "options. Leave it out when the question speaks for itself.",
      ),
  })
  .strict();

/**
 * What the turn needs to draw the question.
 *
 * Read off the schema so there is one declaration of the shape: a field added
 * there arrives here, and at the one place that draws it, without anyone
 * remembering to say so twice.
 */
export type AskUserPayload = z.infer<typeof inputSchema>;

export const askUser: Tool<z.infer<typeof inputSchema>, AskUserPayload> = tool({
  description:
    "Ask the user a clarifying question. Use when you need more " +
    "information to proceed. Put the question here rather than writing it " +
    "yourself, and put every option in `options` -- both are drawn for you, " +
    "the options numbered from one. Keep each option to one line saying what " +
    "it is, with no argument for or against it. Nothing is written for you " +
    "beyond the numbering: what the reader is told about answering is " +
    "`howToAnswer`, in your own words.",
  inputSchema,
  execute: async (
    input: z.infer<typeof inputSchema>,
    // Unused: this tool assembles a value and returns it, so there is nothing
    // to abandon. Declared so the shape is the same across every tool — the
    // reasoning lives in tools/__tests__/tool-cancellation.test.ts.
    _options: { abortSignal?: AbortSignal },
  ): Promise<AskUserPayload> => input,
});
