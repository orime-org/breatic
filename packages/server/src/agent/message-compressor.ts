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

/**
 * What an old tool result reads as once its body is gone.
 *
 * Says the result was dropped rather than leaving an empty string: an empty
 * result is a claim that the tool answered with nothing, and the model plans
 * its next call on that claim.
 */
export const DROPPED_TOOL_RESULT = "[earlier tool result omitted from context]";

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
    (sum, message) => sum + message.parts.filter((p) => p.type === "tool").length,
    0,
  );

  const dropBefore = totalUses - toolResultKeep;
  if (dropBefore <= 0) return [...messages];

  let seen = 0;
  return messages.map((message) => {
    if (!message.parts.some((p) => p.type === "tool")) return message;
    const parts = message.parts.map((part): MessagePart => {
      if (part.type !== "tool") return part;
      const isOld = seen < dropBefore;
      seen += 1;
      if (!isOld || part.output === undefined) return part;
      return { ...part, output: DROPPED_TOOL_RESULT };
    });
    return { ...message, parts };
  });
}
