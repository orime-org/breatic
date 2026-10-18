// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Ask-user tool — put a card of questions to the reader and wait there for
 * the answer.
 */
import { askUserInputSchema, type AskUserInput } from "@breatic/shared";
import { tool, type Tool } from "ai";
import type { z } from "zod";

/** What a turn hands the tool when it builds it. */
export interface AskUserContext {
  /**
   * Whether media at this address may be shown on the card: our own storage,
   * or a picture `search_images` returned in this conversation. Asked each
   * time a call arrives, so a search earlier in the same turn counts.
   */
  mediaUrlAllowed: (url: string) => boolean;
}

/** What the model may send: the card, and media only from where we vouch for it. */
type AskUserSchema = z.ZodType<AskUserInput, AskUserInput>;

/**
 * The card's shape, with every media address checked when the call arrives.
 * @param context - Where media may come from.
 * @returns The schema the tool takes.
 */
function schemaFor(context: AskUserContext): AskUserSchema {
  return askUserInputSchema.superRefine((value, ctx) => {
    value.questions.forEach((question, q) => {
      question.options.forEach((option, o) => {
        const media = option.media;
        if (media === undefined) return;
        for (const [field, url] of [["url", media.url], ["poster", media.poster]] as const) {
          if (url === undefined || context.mediaUrlAllowed(url)) continue;
          ctx.addIssue({
            code: "custom",
            path: ["questions", q, "options", o, "media", field],
            message:
              `Option "${option.label}" on question ${String(q + 1)} has media at ${url}, which is neither ` +
              "in our storage nor a picture search_images returned in this conversation. Media on a card " +
              "comes only from those two sources.",
          });
        }
      });
    });
  }) as unknown as AskUserSchema;
}

/**
 * The ask-user tool, as a turn receives it.
 *
 * It has no `execute`. A call is a card the reader answers in their own time,
 * and `ai@7.0.68` moves on to the next step only once every call in a step
 * has a result (`dist/index.js:10049`), so the turn stops at the card; the
 * answer comes back as this call's result in the request that resumes it.
 * @param context - Where media on the card may come from.
 * @returns The tool.
 */
export function makeAskUserTool(context: AskUserContext): Tool<AskUserInput, never> {
  return tool({
    description:
      "Ask the user what you need to know before you go on, as a card of one to four questions in a single " +
      "call. The turn waits at the card: what comes back as this call's result is either the user's answers " +
      "(the options they picked and anything they wrote on a question's Other line, each answer naming its " +
      "question by `index`, counting from 0 in the order you gave them; a question they skipped is absent) or word that they wrote a message instead, in which case read that message, which may " +
      "answer the card or be about something else. Use it when you genuinely need an answer to continue, " +
      "not to fill a pause, and call it once: a second call in the same step is turned away. Put every " +
      "question here rather than writing it yourself, and every answer you are offering in its options -- " +
      "the card draws them as choices to click, and adds an Other line to each question for the user's own " +
      "words, so do not offer an \"other\" option yourself. The card shows the questions numbered from 1 in " +
      "the order you give them, and a user who types instead may point at a question by its number. Keep " +
      "each option to one line saying what it is, with no argument for or against it. Give an option media " +
      "only when it has to be seen or heard to be understood (a style, a voice, a shot), on every option of " +
      "that question or on none.",
    inputSchema: schemaFor(context),
  });
}
