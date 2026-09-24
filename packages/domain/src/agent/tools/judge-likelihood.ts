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

import { toolFailed } from "@domain/agent/tools/failure.js";
import { askJev } from "@domain/agent/tools/jev.js";
import type { JevAnswers } from "@domain/agent/tools/jev.js";

/**
 * One question, in whichever of the three shapes it is being asked.
 *
 * The endpoint owns this format and judges it precisely: a wrong shape comes
 * back naming the field (`path:["questions","a","criteria"] expected array`),
 * and the model reads that and writes the call again. So what is declared
 * here is what the model was told the shapes are -- the three types and the
 * field each one carries -- and nothing about whether the content is any
 * good. Whether one option is enough, or a scale of one rung is worth asking,
 * is the endpoint's to answer; measured, it answers both.
 *
 * Each arm is loose, so a field this side never heard of travels on to the
 * endpoint rather than being dropped in silence. Measured: a `choice`
 * carrying `weights` answers 200.
 */
const questionSchema = z.discriminatedUnion("type", [
  z.looseObject({
    type: z.literal("noul"),
    instructions: z
      .string()
      .describe("The claim to judge, as a question this can answer with one probability."),
  }),
  z.looseObject({
    type: z.literal("choice"),
    instructions: z.string().describe("What is being decided between these options."),
    criteria: z
      .record(z.string(), z.string())
      .describe("The options: your own name for each one, and what that option is."),
  }),
  z.looseObject({
    type: z.literal("score"),
    instructions: z.string().describe("What is being placed on this scale."),
    criteria: z.array(z.string()).describe("The rungs of the scale, lowest first."),
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
    "- whether a claim holds -- `{\"type\":\"noul\",\"instructions\":\"...\"}`. It answers one " +
      "probability. \"Does what I am about to say square with the material I have?\"",
    "- a set of options -- `{\"type\":\"choice\",\"instructions\":\"...\",\"criteria\":" +
      "{\"your_name_for_it\":\"what that option is\"}}`. It answers a probability for each, " +
      "which one comes out on top, and how sure it is. The options are yours: you name them, " +
      "and the answer uses your names.",
    "- a scale of rungs in order -- `{\"type\":\"score\",\"instructions\":\"...\"," +
      "\"criteria\":[\"lowest\",\"...\",\"highest\"]}`. It answers where this falls, which " +
      "may be between rungs.",
    "",
    "Put what you are judging against into `state`.",
    "",
    "Use it when you are unsure. For instance:",
    "- the reader's sentence has several readings and you do not know which to act on",
    "- you can see several ways to do something and cannot tell which suits this time",
    "- you are about to say something and are unsure it squares with what you hold",
    "- the reader asked for something you think is off, and you are unsure whether to do it",
    "- you cannot tell whether they said enough to start on, or whether to ask them first",
    "",
    "It judges the questions, so word one badly and it says so by name. What it answers " +
      "that back with reaches you unchanged; write the call again from it.",
    "",
    "A question whose answer came back in a shape this side cannot read, or which it did " +
      "not answer at all, is named in `unreadable` instead of `answers`. The rest stand.",
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
      ...(abortSignal ? { abortSignal } : {}),
    });
  },
});
