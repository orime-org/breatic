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
import type { ToolResultPart } from "ai";

import type { MessageData, MessagePart } from "@breatic/shared";

/** A tool part, once narrowed out of the union. */
type ToolPart = Extract<MessagePart, { type: "tool" }>;

/**
 * Render what a tool returned in the typed form the SDK requires.
 *
 * The field is a discriminated union, not a string — `ai@7.0.68` validates it
 * with `z.discriminatedUnion` before the request goes out, so handing over the
 * stored string is rejected at the door.
 *
 * Which arm depends on what the tool answered with, and both arms are real:
 * a search tool answers with prose, and the four interaction tools answer
 * with the object the panel needs to draw the question. Putting an object in
 * the `text` arm fails validation, and it fails inside the stream -- nothing
 * reaches the screen and nothing says why, so a conversation goes quiet from
 * its first interaction tool onward.
 *
 * Only called for parts that ended, so an `error` here always carries its
 * detail -- and it is the model's half of that detail that goes, never the
 * key the panel translates.
 * @param part - The tool part to render
 * @returns The output in its typed form, saying plainly when the tool failed
 */
function toolOutput(part: ToolPart): ToolResultPart["output"] {
  if (part.status === "error") {
    return { type: "error-text", value: part.failure?.forModel ?? "" };
  }
  if (typeof part.output === "string") return { type: "text", value: part.output };
  // Whatever the tool answered with, as it was stored. It came out of a
  // `JSON.stringify` on the way into the table, so it is JSON by
  // construction -- the cast says that rather than re-deriving it.
  return {
    type: "json",
    value: (part.output ?? null) as Extract<
      ToolResultPart["output"],
      { type: "json" }
    >["value"],
  };
}

/**
 * Turn stored messages into the messages the model is sent.
 *
 * Reasoning never goes back: it is the model's own working, and returning it
 * teaches nothing while costing every turn. A call still in flight is left out
 * along with its own half — a call with no answer puts the exchange in a state
 * the protocol has no move for.
 *
 * A call the user stopped does go back, saying so. It used to be dropped whole,
 * which left the next turn reading as one the model had finished answering: it
 * had no way to know its own reply had been cut off, and carried on as though
 * it had.
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

      if (part.type !== "tool" || part.status === "pending") continue;

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
