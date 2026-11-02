// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * What the result of a call that waits for the reader is sent to the model
 * as: `ask_user` (inner#1542) and `request_space_content` (inner#1552).
 *
 * The call waits for the reader, so its result is written later than the call
 * -- when the reader answers on the card, writes a message instead, or the
 * turn turns a second card away -- and it is appended to the asking row's
 * copy of what was sent, beside the call it answers. Each result is filed
 * under the call's own tool name: one filed under another is a result the
 * provider pairs with nothing.
 */
import type { ModelMessage } from "ai";
import { ASK_USER } from "@breatic/domain";
import type { AskUserResult, SharedSpace } from "@breatic/shared";

/** What a Space request ends with: the Spaces as read, a refusal, or a message written instead. */
export type SpaceRequestResult = { spaces: SharedSpace[] } | { declined: true } | { repliedInChat: true };

/** What any call that waits for the reader ends with. */
export type CardResult = AskUserResult | SpaceRequestResult;

/** What the card keeps of one shared Space: what names it and how its read went, no content. */
export type SharedSpaceSummary = Pick<SharedSpace, "id" | "state"> & Partial<Pick<SharedSpace, "name" | "kind" | "part">>;

/** What the card draws of a waiting call's result. */
export type CardOutput = Exclude<CardResult, { spaces: SharedSpace[] }> | { spaces: SharedSpaceSummary[] };

/** A call turned away, named by its id and its tool. */
export interface TurnedAwayCall {
  toolCallId: string;
  toolName: string;
}

/** What the model reads for a questionnaire the user left without an answer. */
export const UNANSWERED_ASK = "The user did not answer this questionnaire.";

/** What the model reads for a request to read Spaces the user left without an answer. */
export const UNANSWERED_SPACE_REQUEST = "The user did not answer this request to read Spaces.";

/** What a second question in one step is told, by the model reading it back. */
export const SECOND_QUESTION_TURNED_AWAY =
  "This card was not shown to the user: one card a step, and another one was put to them first. " +
  "Ask again once that one is answered, if you still need to.";

/**
 * The tool message carrying a waiting call's result.
 * @param toolCallId - The call.
 * @param result - What it ended with.
 * @param toolName - The call's tool; a questionnaire unless said otherwise.
 * @returns The message, as it is sent and kept.
 */
export function askResultForModel(toolCallId: string, result: CardResult, toolName: string = ASK_USER): ModelMessage {
  return {
    role: "tool",
    content: [{ type: "tool-result", toolCallId, toolName, output: { type: "json", value: result } }],
  };
}

/**
 * The tool message carrying the refusals of cards turned away in a step.
 * @param calls - The calls turned away.
 * @returns The message, as it is sent and kept.
 */
export function turnedAwayForModel(calls: readonly TurnedAwayCall[]): ModelMessage {
  return {
    role: "tool",
    content: calls.map(({ toolCallId, toolName }) => ({
      type: "tool-result" as const,
      toolCallId,
      toolName,
      output: { type: "error-text" as const, value: SECOND_QUESTION_TURNED_AWAY },
    })),
  };
}

/**
 * What the card draws of a waiting call's result, and what the browser is
 * told it ended with. A shared Space keeps only what names it and how its read
 * went: the content goes to the model alone, never back to the page or into
 * the part the card is drawn from.
 * @param result - What the call ended with.
 * @returns The card's output.
 */
export function cardOutputOf(result: CardResult): CardOutput {
  if (!("spaces" in result)) return result;
  return {
    spaces: result.spaces.map(({ id, name, kind, part, state }) => ({
      id,
      ...(name === undefined ? {} : { name }),
      ...(kind === undefined ? {} : { kind }),
      ...(part === undefined ? {} : { part }),
      state,
    })),
  };
}
