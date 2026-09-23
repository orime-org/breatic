// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Ask for a judgement, with the odds attached.
 *
 * The model composes the whole request. Which of the three question shapes
 * fits what it is unsure about, how many to ask at once, what to put in the
 * state and how to word each option are all its to decide, so the parameters
 * are the endpoint's own and the description says plainly what the thing can
 * do rather than drawing a boundary around it.
 *
 * What comes back reaches the model whole. The payload is a handful of
 * numbers, so nothing is rendered down on the way: a description of it would
 * cost more to keep true than the JSON costs to carry.
 */

import { getAgentConfig, getRawEnvVar } from "@breatic/core";
import { FAILURE_LINES } from "@breatic/shared";
import { tool } from "ai";
import type { Tool } from "ai";
import { z } from "zod";

import type { FailureVoice } from "@domain/agent/tools/failure.js";
import { toolFailed } from "@domain/agent/tools/failure.js";
import { askJev } from "@domain/agent/tools/jev.js";
import type { JevAnswers } from "@domain/agent/tools/jev.js";

/** How this tool names what it does, in the sentences a failure carries. */
const VOICE: FailureVoice = {
  act: "judgement",
  results: "that judgement",
  retrying: "Asking once more",
  elsewhere: "decide from what you already hold",
  attempting: "Judging",
};

const questionSchema = z.union([
  z.object({
    type: z.literal("noul"),
    instructions: z
      .string()
      .min(1)
      .describe("The claim to judge, as a question this can answer with one probability."),
  }),
  z.object({
    type: z.literal("choice"),
    instructions: z.string().min(1).describe("What is being decided between these options."),
    criteria: z
      .record(z.string(), z.string().min(1))
      .describe("The options: your own name for each one, and what that option is."),
  }),
  z.object({
    type: z.literal("score"),
    instructions: z.string().min(1).describe("What is being placed on this scale."),
    criteria: z
      .array(z.string().min(1))
      .min(2)
      .describe("The rungs of the scale, lowest first."),
  }),
]);

const inputSchema = z.object({
  state: z
    .unknown()
    .describe(
      "Everything you are judging against, in whatever shape you hold it: what the reader " +
        "said, earlier turns, what is on the canvas, the catalog rows. The fuller this is, " +
        "the better the answer.",
    ),
  questions: z
    .record(z.string(), questionSchema)
    .refine((asked) => Object.keys(asked).length > 0, "ask at least one question")
    .describe(
      "One or more questions, under names of your choosing. Answers come back under the " +
        "same names.",
    ),
});

/**
 * The description the model reads.
 *
 * Written plainly and with examples, and drawing no boundaries: a description
 * that rules something out is a use the model will not make of it, and the
 * cases it is worth asking about are wider than any list written here.
 */
const DESCRIPTION = [
    "Hand it what you are holding, ask it one or several questions, and it answers a " +
      "judgement with the odds attached. It judges what stands up given what you gave it.",
    "",
    "Three ways to ask, and one call may mix them:",
    "- whether a claim holds -- it answers one probability. \"Does what I am about to say " +
      "square with the material I have?\"",
    "- a set of options -- it answers a probability for each, which one comes out on top, " +
      "and how sure it is. The options are yours: you name them, and the answer uses your names.",
    "- a scale of rungs in order -- it answers where this falls, which may be between rungs.",
    "",
    "Put what you are judging against into `state`: what the reader said, the turns before " +
      "this, what is on the canvas, the catalog rows. The fuller it is, the better it answers.",
    "",
    "Use it when you are unsure. For instance:",
    "- the reader's sentence has several readings and you do not know which to act on",
    "- you can see several ways to do something and cannot tell which suits this time",
    "- you are about to say something and are unsure it squares with what you hold",
    "- the reader asked for something you think is off, and you are unsure whether to do it",
    "- you cannot tell whether they said enough to start on, or whether to ask them first",
    "",
    "When it says it is unsure, the question has no answer in the material you gave it: the " +
      "option and scale shapes answer a confidence, and the claim shape answers a probability " +
      "near a half. That is when to ask the reader, or to put more in and ask again.",
    "",
    "Asking the reader is for what only they know. This is for what stands up in what you " +
      "already hold.",
].join("\n");

/**
 * The tool, ready to be registered.
 * @throws {Error} Carrying tool failure detail, or the reader's stop.
 */
export const judgeLikelihood: Tool<z.infer<typeof inputSchema>, JevAnswers> = tool({
  description: DESCRIPTION,
  inputSchema,
  // What the panel reads about a running call, resolved by the web package.
  metadata: { runningLine: "chat.tool.judging" },
  execute: async (
    { state, questions },
    { abortSignal }: { abortSignal?: AbortSignal },
  ): Promise<JevAnswers> => {
    const apiKey = getRawEnvVar("OPENROUTER_API_KEY") ?? "";
    if (!apiKey) {
      // Defensive: `buildToolSet` leaves this tool out of the set entirely
      // when the key is missing, so a turn should not reach here.
      throw toolFailed(
        "Judgement is not available on this deployment: it has no credentials. Tell the " +
          "user, and do not try again.",
        FAILURE_LINES.generic,
      );
    }

    return askJev({
      apiKey,
      state,
      questions,
      budgetMs: getAgentConfig().judge_likelihood_timeout_ms,
      voice: VOICE,
      ...(abortSignal ? { abortSignal } : {}),
    });
  },
});
