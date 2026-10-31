// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * What an `ask_user` call's result is sent to the model as (inner#1542).
 *
 * The call waits for the reader, so its result is written later than the call
 * -- when the reader answers on the card, writes a message instead, or the
 * turn turns a second question away -- and it is appended to the asking row's
 * copy of what was sent, beside the call it answers.
 */
import type { ModelMessage } from "ai";
import { ASK_USER } from "@breatic/domain";
import type { AskUserResult } from "@breatic/shared";

/** What the model reads for a questionnaire the user left without an answer. */
export const UNANSWERED_ASK = "The user did not answer this questionnaire.";

/** What a second question in one step is told, by the model reading it back. */
export const SECOND_QUESTION_TURNED_AWAY =
  "This card was not shown to the user: one card a step, and another one was put to them first. " +
  "Ask again once that one is answered, if you still need to.";

/**
 * The tool message carrying a questionnaire call's result.
 * @param toolCallId - The call.
 * @param result - What it ended with.
 * @returns The message, as it is sent and kept.
 */
export function askResultForModel(toolCallId: string, result: AskUserResult): ModelMessage {
  return {
    role: "tool",
    content: [{ type: "tool-result", toolCallId, toolName: ASK_USER, output: { type: "json", value: result } }],
  };
}

/**
 * The tool message carrying the refusals of questions turned away in a step.
 * @param toolCallIds - The calls turned away.
 * @returns The message, as it is sent and kept.
 */
export function turnedAwayForModel(toolCallIds: readonly string[]): ModelMessage {
  return {
    role: "tool",
    content: toolCallIds.map((toolCallId) => ({
      type: "tool-result" as const,
      toolCallId,
      toolName: ASK_USER,
      output: { type: "error-text" as const, value: SECOND_QUESTION_TURNED_AWAY },
    })),
  };
}
