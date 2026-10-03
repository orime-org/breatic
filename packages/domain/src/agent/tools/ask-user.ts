// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Ask-user tool — put a question to the reader and end the turn there.
 */
import { tool, type Tool } from "ai";
import { z } from "zod";

import { turnedAway } from "@domain/agent/tools/failure.js";

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
      // A ceiling and nothing else: every count below it is drawn. Empty is an
      // open question, and one is drawn as a list of one.
      .max(5)
      .optional()
      .describe("Up to five answers to choose from, one line each"),
    howToAnswer: line(120)
      .optional()
      .describe(
        "One line telling the user how to answer, in your own words and in " +
          "the language you are replying in: that a number will do, and that " +
          "they may answer in their own words instead. Drawn on its own under " +
          "the options. Leave it out when the question speaks for itself.",
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

/**
 * The ask-user tool, as a turn receives it.
 *
 * A fresh one per turn, because it carries a turn's worth of state: whether a
 * question has been put yet. A reader is put one question a turn, so that
 * they can think it through and talk about it before the next one comes.
 * Holding that line here rather than in the description is what makes it
 * hold: a model can call this twice in one step, and `ai@7.0.68` starts a
 * step's calls in the order they were sent, so the first one to start is the
 * one the reader sees and every later one is turned away.
 * @returns The tool.
 * @throws {Error} From `execute`, a turned-away failure for any call after
 *   the turn's first.
 */
export function makeAskUserTool(): Tool<z.infer<typeof inputSchema>, AskUserPayload> {
  let asked = false;

  return tool({
    description:
      "Ask the user a clarifying question. It ends your turn there, so use it " +
      "when you genuinely need an answer to continue, not to fill a pause. Ask " +
      "one question at a time, and call this once a turn: the user answers one " +
      "thing before the next is put to them. If there is more than one thing " +
      "you need to know, ask the most important one first. Put the question " +
      "here rather than writing it yourself, and put every answer you are " +
      "offering in `options` -- both are drawn for you, the options numbered " +
      "from one. A question you also write out arrives twice, and answers " +
      "listed in your own prose arrive as a run-on sentence with nothing to " +
      "pick from. Keep each option to one line saying what it is, with no " +
      "argument for or against it. Nothing is written for you beyond the " +
      "numbering: what the reader is told about answering is `howToAnswer`.",
    inputSchema,
    execute: async (
      input: z.infer<typeof inputSchema>,
      // Unused: this tool assembles a value and returns it, so there is nothing
      // to abandon. Declared so the shape is the same across every tool — the
      // reasoning lives in tools/__tests__/tool-cancellation.test.ts.
      _options: { abortSignal?: AbortSignal },
    ): Promise<AskUserPayload> => {
      if (asked) {
        // Past tense: the next turn reads this, when the first question has
        // its answer.
        throw turnedAway(
          "This question was not put to the user: one question a turn, and " +
            "another one was asked first. Ask it once the first one is answered, " +
            "if you still need to.",
        );
      }
      asked = true;
      return input;
    },
  });
}
