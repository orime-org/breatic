// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * ask-user-choice tool — interaction tool for multiple-choice questions.
 *
 * Per spec/07-chat-agent.md §10.18.4 (v13 Agent rich output protocol):
 * the LLM calls this NOT to execute logic but as a structured-data carrier.
 * The frontend identifies `tool_call.name === 'ask_user_choice'` and
 * renders a ChoicePicker UI component (question + option buttons).
 * After the user selects, the next user message carries the choice back
 * to the agent.
 *
 * Distinguished from `ask_user_question` (free-form text answer) — use
 * this when the agent has a discrete set of options the user should pick
 * from. DO NOT call for simple yes/no — use plain text for those.
 */
import { tool } from "ai";
import { z } from "zod";

/** Sentinel prefix detected by main-agent to interrupt the loop and yield AGENT_CHOICE SSE event. */
export const ASK_USER_CHOICE_SENTINEL = "__ASK_USER_CHOICE__";

const inputSchema = z.object({
  question: z.string().describe("The multiple-choice question to ask"),
  choices: z
    .array(
      z.object({
        id: z.string().describe("Stable id used to identify the choice in the next-turn echo"),
        label: z.string().describe("Display text shown on the option button"),
        description: z
          .string()
          .optional()
          .describe("Optional secondary text shown below the label"),
      }),
    )
    .min(2)
    .describe("Array of choices the user can pick from (at least 2)"),
  multiSelect: z
    .boolean()
    .optional()
    .describe("When true, user can select multiple choices; defaults to single-select"),
});

export const askUserChoice = tool({
  description:
    "Ask the user to pick from a discrete set of options. Use when " +
    "you need disambiguation or preference selection from a known " +
    "list (e.g. 'which color palette?'). DO NOT use for free-form " +
    "questions (use ask_user_question) or simple yes/no (use plain text).",
  inputSchema,
  execute: async (input: z.infer<typeof inputSchema>): Promise<string> => {
    return `${ASK_USER_CHOICE_SENTINEL}${JSON.stringify(input)}`;
  },
});
