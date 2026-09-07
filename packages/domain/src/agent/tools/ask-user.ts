// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Ask-user tool — put a question to the reader and end the turn there.
 */
import { tool, type Tool } from "ai";
import { z } from "zod";

/**
 * One line of prose, as CommonMark will read it.
 *
 * Two things it may not be. It may not run past a line ending -- a carriage
 * return counts, and an option carrying one renders as two numbered items, so
 * the numbers the reader answers with stop matching the ones the call carried.
 * And it may not open a block of its own: the numbering, the paragraphs and the
 * list are drawn for the model, so an option that numbers itself renders as a
 * list inside a list and a question opening with a hash as a heading in the
 * middle of the reply. A hash or a dash further along the line is a character.
 */
const PROSE_LINE = /^(?![#>|]|[-*+][ \t]|\d+[.)][ \t]|```|~~~)[^\n\r\u2028\u2029]+$/;

/**
 * One line of what the reader will read: not blank, and prose.
 * @param max - How many characters this line may run to.
 * @returns A schema accepting one such line no longer than that.
 */
const line = (max: number): z.ZodString =>
  z.string().trim().min(1).max(max).regex(PROSE_LINE);

const inputSchema = z
  .object({
    question: line(200).describe("The question to ask the user, in one line"),
    options: z
      .array(line(60))
      .max(5)
      // Empty is what an open question has always looked like here. Fewer than
      // two is a reason to draw no list rather than a reason to refuse.
      .refine((given) => given.length === 0 || given.length >= 2, {
        message: "Give two to five options, or none at all",
      })
      .optional()
      .describe("Two to five answers to choose from, one line each"),
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
