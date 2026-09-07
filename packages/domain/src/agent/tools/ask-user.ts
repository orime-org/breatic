// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Ask-user tool — put a question to the reader and end the turn there.
 */
import { tool, type Tool } from "ai";
import { z } from "zod";

/**
 * One line of what the reader will read: not blank, and not a paragraph.
 * @param max - How many characters this line may run to.
 * @returns A schema accepting one non-blank line no longer than that.
 */
const line = (max: number): z.ZodString =>
  z.string().trim().min(1).max(max).regex(/^[^\n]+$/);

/**
 * Ask the user a clarifying question before proceeding.
 *
 * These arguments are the format. The question and its options are drawn as a
 * paragraph in the reply, so what the schema accepts is what a reader can end
 * up looking at: a question folded into three lines arrives as three lines,
 * and a blank one arrives as an empty space above a row saying the turn is
 * waiting for an answer to it.
 *
 * Strict, because the default is to drop an unknown field in silence -- the
 * model would lose whatever it was trying to say with no error to read.
 */
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
  })
  .strict();

/** What the turn needs to draw the question. */
type AskUserPayload = { question: string; options: string[] };

export const askUser: Tool<z.infer<typeof inputSchema>, AskUserPayload> = tool({
  description:
    "Ask the user a clarifying question. Use when you need more " +
    "information to proceed. Put the question here rather than writing it " +
    "yourself, and put every option in `options` -- both are drawn for you. " +
    "Keep each option to one line saying what it is, with no argument for " +
    "or against it.",
  inputSchema,
  execute: async (
    input: z.infer<typeof inputSchema>,
    // Unused: this tool assembles a value and returns it, so there is nothing
    // to abandon. Declared so the shape is the same across every tool — the
    // reasoning lives in tools/__tests__/tool-cancellation.test.ts.
    _options: { abortSignal?: AbortSignal },
  ): Promise<AskUserPayload> => {
    const payload = { question: input.question, options: input.options ?? [] };
    return payload;
  },
});
