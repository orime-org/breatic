// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * Stored history, in the form the model is given.
 *
 * These are two shapes for two audiences and they are not the same shape.
 * Storage keeps one message per turn with its pieces in order — the reply and
 * everything it did along the way, which is what a person reads. The protocol
 * wants the same history split differently: a tool call belongs to the
 * assistant, its result arrives as a message of its own.
 *
 * The conversion is one function because both chat entry points need it and a
 * second copy would drift; it is here rather than in the repository because
 * the repository answers to every reader, and only this one wants the
 * protocol's shape.
 */

import type { ModelMessage } from "ai";
import { toolCallHasOutcome } from "@breatic/shared";
import type { MessageData, MessagePart } from "@breatic/shared";

/** A tool part, once narrowed out of the union. */
type ToolPart = Extract<MessagePart, { type: "tool" }>;

/**
 * Render what a tool returned in the typed form the SDK requires.
 *
 * The field is a discriminated union, not a string — `ai@7.0.58` validates it
 * with `z.discriminatedUnion` before the request goes out, so handing over the
 * stored string is rejected at the door.
 *
 * Only called for parts that `toolCallHasOutcome` accepted, so an `error`
 * here always carries its reason.
 * @param part - The tool part to render
 * @returns The output in its typed form, saying plainly when the tool failed
 */
function toolOutput(part: ToolPart): { type: "text" | "error-text"; value: string } {
  if (part.status === "error") {
    return { type: "error-text", value: part.errorMessage ?? "" };
  }
  return { type: "text", value: part.output ?? "" };
}

/**
 * Turn stored messages into the messages the model is sent.
 *
 * Reasoning never goes back: it is the model's own working, and returning it
 * teaches nothing while costing every turn. A call that never came back is
 * left out along with its own half — a call with no answer puts the exchange
 * in a state the protocol has no move for, and that is what a turn stopped
 * mid-tool leaves behind.
 * @param history - Stored messages, oldest first
 * @returns The same history in protocol form, oldest first
 */
export function toModelMessages(history: readonly MessageData[]): ModelMessage[] {
  const out: ModelMessage[] = [];

  for (const message of history) {
    if (message.role === "user") {
      out.push({ role: "user", content: message.content });
      continue;
    }

    for (const part of message.parts) {
      if (part.type === "text") {
        out.push({ role: "assistant", content: part.text });
        continue;
      }

      if (part.type !== "tool" || !toolCallHasOutcome(part)) continue;

      out.push({
        role: "assistant",
        content: [
          {
            type: "tool-call",
            toolCallId: part.toolCallId,
            toolName: part.toolName,
            input: part.input,
          },
        ],
      });
      out.push({
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: part.toolCallId,
            toolName: part.toolName,
            output: toolOutput(part),
          },
        ],
      });
    }
  }

  return out;
}
