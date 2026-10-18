// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The questionnaire the agent puts to the reader, and the answer that comes
 * back.
 *
 * Shared because three places read one shape: the tool that takes the model's
 * call, the card that draws it in the browser, and the route that takes the
 * reader's answer and checks it against the questions it answers.
 */
import { z } from "zod";

/**
 * One line, counting every character a line can end on.
 *
 * A carriage return ends a line the way a newline does, so a value carrying one
 * is two lines wherever it is read.
 */
const ONE_LINE = /^[^\n\r\u2028\u2029]+$/;

/**
 * One line of what the reader will read: not blank, and one line.
 * @param max - How many characters this line may run to.
 * @returns A schema accepting one such line no longer than that.
 */
const line = (max: number): z.ZodString => z.string().trim().min(1).max(max).regex(ONE_LINE);

/** How many questions one card holds. */
export const ASK_USER_MAX_QUESTIONS = 4;

/** How many options one question offers. */
export const ASK_USER_MAX_OPTIONS = 5;

/** How long the reader's own words on one question's "Other" line may be. */
export const ASK_USER_OTHER_MAX_CHARS = 500;

/** A picture, a sound or a clip shown on an option. */
export const askUserMediaSchema = z
  .object({
    kind: z.enum(["image", "audio", "video"]),
    url: z.string().url(),
    poster: z.string().url().optional().describe("A cover image for a video"),
  })
  .strict();

/** One option on a question. */
export const askUserOptionSchema = z
  .object({
    label: line(60).describe("What the option is, in one line"),
    description: line(120).optional().describe("One line saying more about it, when the label alone is not enough"),
    media: askUserMediaSchema
      .optional()
      .describe("A picture, sound or clip that shows the option; on every option of the question or on none"),
  })
  .strict();

/** One question on the card. */
export const askUserQuestionSchema = z
  .object({
    header: line(12).describe("A short label for the question, up to 12 characters"),
    question: line(200).describe("The question, in one line"),
    multiSelect: z.boolean().default(false).describe("Whether the reader may pick more than one option"),
    options: z
      .array(askUserOptionSchema)
      .max(ASK_USER_MAX_OPTIONS)
      .default([])
      .describe("Up to five options; none makes it an open question answered in the reader's own words"),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.multiSelect && value.options.length < 2) {
      ctx.addIssue({
        code: "custom",
        path: ["options"],
        message: `A question that takes several answers needs at least two options; this one has ${String(value.options.length)}.`,
      });
    }
    const withMedia = value.options.filter((option) => option.media !== undefined).length;
    if (withMedia !== 0 && withMedia !== value.options.length) {
      ctx.addIssue({
        code: "custom",
        path: ["options"],
        message:
          `Media is on every option of a question or on none; ${String(withMedia)} of ` +
          `${String(value.options.length)} options here carry it.`,
      });
    }
  });

/** What the model sends: the questions, and nothing else. */
export const askUserInputSchema = z
  .object({
    questions: z.array(askUserQuestionSchema).min(1).max(ASK_USER_MAX_QUESTIONS),
  })
  .strict();

/** One questionnaire, as it is stored and drawn. */
export type AskUserInput = z.infer<typeof askUserInputSchema>;

/** One question, as it is stored and drawn. */
export type AskUserQuestion = AskUserInput["questions"][number];

/** The reader's answer to one question. */
export const askUserAnswerItemSchema = z
  .object({
    /** Which question, counting from zero in the order they were asked. */
    index: z.number().int().min(0).max(ASK_USER_MAX_QUESTIONS - 1),
    /** The labels of the options picked. */
    selected: z.array(z.string()).max(ASK_USER_MAX_OPTIONS),
    /** What the reader wrote on the question's "Other" line. */
    other: z.string().trim().min(1).max(ASK_USER_OTHER_MAX_CHARS).optional(),
  })
  .strict();

/** The reader's answers to one card, as the browser sends them. */
export const askUserAnswerSchema = z
  .object({
    toolCallId: z.string().min(1).max(200),
    answers: z.array(askUserAnswerItemSchema).max(ASK_USER_MAX_QUESTIONS),
  })
  .strict();

/** The reader's answers to one card. */
export type AskUserAnswer = z.infer<typeof askUserAnswerSchema>;

/**
 * What a questionnaire call ends with: the answers given on the card, or word
 * that the reader wrote a message instead.
 */
export type AskUserResult =
  | { answers: AskUserAnswer["answers"] }
  | { repliedInChat: true };

/**
 * Hold a set of answers to the questions they answer.
 *
 * The shape is the schema's business; this is the part only the stored
 * questions can settle: that each answer names a question that exists, once,
 * picks only options that question offers, picks one at most where only one
 * may be picked, and that at least one question is answered.
 * @param questions - The questions as they were asked.
 * @param answers - What the reader sent.
 * @returns Why the answers do not fit, or null when they do.
 */
export function answersMismatch(
  questions: readonly AskUserQuestion[],
  answers: AskUserAnswer["answers"],
): string | null {
  const seen = new Set<number>();
  let answered = 0;
  for (const answer of answers) {
    const asked = questions[answer.index];
    if (asked === undefined) return `There is no question ${String(answer.index + 1)} on this card.`;
    if (seen.has(answer.index)) return `Question ${String(answer.index + 1)} is answered twice.`;
    seen.add(answer.index);
    const offered = new Set(asked.options.map((option) => option.label));
    const stranger = answer.selected.find((label) => !offered.has(label));
    if (stranger !== undefined) return `"${stranger}" is not an option on question ${String(answer.index + 1)}.`;
    if (new Set(answer.selected).size !== answer.selected.length) {
      return `An option is picked twice on question ${String(answer.index + 1)}.`;
    }
    if (!asked.multiSelect && answer.selected.length + (answer.other === undefined ? 0 : 1) > 1) {
      return `Question ${String(answer.index + 1)} takes one answer.`;
    }
    if (answer.selected.length > 0 || answer.other !== undefined) answered += 1;
  }
  if (answered === 0) return "At least one question is answered.";
  return null;
}

/**
 * Read a stored call's input as a questionnaire, when it is one.
 *
 * Calls stored before the card existed carry a single `question` instead, and
 * they are drawn from the words already in the reply rather than as a card.
 * @param input - The call's stored input.
 * @returns The questionnaire, or null for any other shape.
 */
export function readQuestionnaire(input: unknown): AskUserInput | null {
  const parsed = askUserInputSchema.safeParse(input);
  return parsed.success ? parsed.data : null;
}
