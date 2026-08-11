// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * Message compressor — reduces token usage by trimming old turn details.
 *
 * Recent turns keep full step detail (tool calls + results). Older turns
 * are compressed to only user message + assistant final reply, dropping
 * intermediate tool_call / tool_result messages.
 *
 * This runs at context-build time only — stored messages are never mutated.
 */

import type { MessageData } from "@breatic/shared";

/**
 * Group flat messages by turnIndex.
 * @param messages - Flat array of messages (all with turnIndex set)
 * @returns Map from turnIndex to its messages in order
 */
export function groupByTurn(messages: readonly MessageData[]): Map<number, MessageData[]> {
  const groups = new Map<number, MessageData[]>();

  for (const msg of messages) {
    const turn = msg.turnIndex;
    const arr = groups.get(turn);
    if (arr) {
      arr.push(msg);
    } else {
      groups.set(turn, [msg]);
    }
  }

  return groups;
}

/**
 * Compress a single turn's messages to just user + assistant final reply.
 *
 * Keeps:
 * - The first `role: "user"` message
 * - The last `role: "assistant"` message that has non-empty content
 *   (skips tool_call-only assistant messages)
 *
 * Drops:
 * - All `role: "tool"` messages (tool results)
 * - Intermediate `role: "assistant"` messages with only tool_calls
 * - The `thinking` field from all kept messages
 * @param turnMessages - All messages for a single turn, in order
 * @returns Compressed messages (1-2 items)
 */
export function compressTurn(turnMessages: readonly MessageData[]): MessageData[] {
  const result: MessageData[] = [];

  // Keep the user message
  const userMsg = turnMessages.find((m) => m.role === "user");
  if (userMsg) {
    result.push(proseOnly(userMsg));
  }

  // Keep the last assistant message with actual text content
  for (let i = turnMessages.length - 1; i >= 0; i--) {
    const msg = turnMessages[i]!;
    if (msg.role === "assistant" && msg.content.trim().length > 0) {
      result.push(proseOnly(msg));
      break;
    }
  }

  return result;
}

/**
 * Reduce a message to what it said.
 *
 * An old turn is kept for what it established, not for how it got there, so
 * the reasoning and the tool use go — the parts as well as the flat fields
 * read off them, since the parts are the message and dropping only the flat
 * view would leave the whole of it still there.
 * @param msg - The message to reduce
 * @returns The same message carrying its prose and nothing else
 */
function proseOnly(msg: MessageData): MessageData {
  const { thinking: _thinking, ...rest } = msg;
  return { ...rest, parts: msg.parts.filter((p) => p.type === "text") };
}

/**
 * Compress messages for LLM context, preserving full detail for recent turns.
 * @param messages - All unconsolidated messages (turnIndex > lastConsolidatedTurn)
 * @param fullDetailTurns - Number of most recent turns to keep uncompressed
 * @returns Messages ready for LLM, with old turns compressed
 */
export function compressForContext(
  messages: readonly MessageData[],
  fullDetailTurns: number,
): MessageData[] {
  if (messages.length === 0) return [];

  const groups = groupByTurn(messages);
  const turnIndices = [...groups.keys()].sort((a, b) => a - b);

  if (turnIndices.length <= fullDetailTurns) {
    // All turns fit within the full-detail window — strip thinking only
    return messages.map(({ thinking: _th, ...rest }) => rest as MessageData);
  }

  const cutoff = turnIndices[turnIndices.length - fullDetailTurns]!;
  const result: MessageData[] = [];

  for (const turnIdx of turnIndices) {
    const turnMsgs = groups.get(turnIdx)!;

    if (turnIdx < cutoff) {
      // Old turn — compress
      result.push(...compressTurn(turnMsgs));
    } else {
      // Recent turn — keep full detail, strip thinking
      for (const msg of turnMsgs) {
        const { thinking: _th, ...rest } = msg;
        result.push(rest as MessageData);
      }
    }
  }

  return result;
}
