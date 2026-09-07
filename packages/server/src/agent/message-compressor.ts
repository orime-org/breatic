// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Message compressor — drops the body of tool results older than the window.
 *
 * The unit is the tool use/result pair, not the turn. `turnIndex` counts user
 * questions, and one question can run forty model calls whose entire output
 * lands in a single stored assistant row, so "the last three turns" is "the
 * last hundred and twenty steps, verbatim" — three orders of magnitude coarser
 * than the thing actually filling the context. Every implementation surveyed
 * counts pairs; Anthropic's `clear_tool_uses_20250919` defaults to `keep: 3
 * tool uses`.
 *
 * What a call was and what it asked for stays: the name and the arguments are
 * the record of what the assistant did, and they are small. Only what came
 * back — which is the part with no upper bound — is replaced.
 *
 * This runs at context-build time only; stored messages are never mutated.
 */

import type { MessageData, MessagePart } from "@breatic/shared";
import { reachesTheModel } from "@server/agent/model-messages.js";

/** A tool part, once narrowed out of the union. */
type ToolPart = Extract<MessagePart, { type: "tool" }>;

/**
 * Whether this part is a use of a tool the window is measured over.
 *
 * The same set the conversion emits: counting a use the model never sees
 * would spend one of the configured slots on it, and the reader would get
 * fewer recent results than the number they set.
 * @param part - A part of a message's content.
 * @returns True when it is a tool use the model is shown.
 */
function isCountedUse(part: MessagePart): part is ToolPart {
  return part.type === "tool" && reachesTheModel(part);
}

/**
 * What an old tool result reads as once its body is gone.
 *
 * Says the result was dropped rather than leaving an empty string: an empty
 * result is a claim that the tool answered with nothing, and the model plans
 * its next call on that claim.
 */
export const DROPPED_TOOL_RESULT = "[earlier tool result omitted from context]";

/**
 * Replace what one use of a tool gave back.
 *
 * Which field that is depends on how the call ended: a call that succeeded is
 * read off `output`, and one that failed is read off `failure.forModel` —
 * `toModelMessages` never looks at `output` for a failed call. Replacing only
 * the first leaves every failed call in the history at full length, and the
 * text of an invalid-arguments failure quotes back everything the model sent.
 * @param part - The tool part to shorten.
 * @returns The same part with its account of itself replaced.
 */
function withoutItsResult(part: ToolPart): ToolPart {
  if (part.status === "error") {
    return part.failure
      ? { ...part, failure: { ...part.failure, forModel: DROPPED_TOOL_RESULT } }
      : part;
  }
  return part.output === undefined ? part : { ...part, output: DROPPED_TOOL_RESULT };
}

/**
 * Compress history for the model by dropping old tool result bodies.
 * @param messages - The unconsolidated history, oldest first.
 * @param toolResultKeep - How many of the most recent tool uses keep their result.
 * @returns The same history with older tool results replaced.
 */
export function compressForContext(
  messages: readonly MessageData[],
  toolResultKeep: number,
): MessageData[] {
  const totalUses = messages.reduce(
    (sum, message) => sum + message.parts.filter(isCountedUse).length,
    0,
  );

  const dropBefore = totalUses - toolResultKeep;
  if (dropBefore <= 0) return [...messages];

  let seen = 0;
  return messages.map((message) => {
    if (!message.parts.some(isCountedUse)) return message;
    const parts = message.parts.map((part): MessagePart => {
      if (!isCountedUse(part)) return part;
      const isOld = seen < dropBefore;
      seen += 1;
      return isOld ? withoutItsResult(part) : part;
    });
    return { ...message, parts };
  });
}
