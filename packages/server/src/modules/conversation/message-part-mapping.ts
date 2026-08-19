// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * The boundary between the shape we store and the shape the wire carries.
 *
 * The transport speaks the SDK's protocol; the store keeps its own layout,
 * because a dependency's model of a message decides how it talks and not how
 * our rows are written. Code can be rewritten when the library changes; rows
 * already written cannot.
 *
 * Two of our parts have no counterpart in the SDK's list. `interrupted` and
 * `failed` are things we know about a turn, not things a model streamed, so
 * they travel as data parts -- the one channel the protocol leaves open for
 * what it does not define -- and not transient ones: a reader who reloads has
 * to still see that a turn was cut off.
 */
import { getToolName, isToolUIPart } from "ai";
import type { UIMessage } from "ai";
import type { MessageData, MessagePart } from "@breatic/shared";

/** What one message's parts look like on the wire. */
type UiParts = UIMessage["parts"];

/** One part of one message on the wire. */
type UiPart = UiParts[number];

/** The data part type carrying a turn that was stopped. */
const INTERRUPTED = "data-interrupted";

/** The data part type carrying a turn that could not be finished. */
const FAILED = "data-failed";

/**
 * How far a tool got, from the state the SDK last reported.
 * @param state - The tool part's state.
 * @returns Our word for the same thing.
 */
function statusOf(state: string): "pending" | "success" | "error" {
  if (state === "output-available") return "success";
  if (state === "output-error" || state === "output-denied") return "error";
  return "pending";
}

/**
 * Turn one tool part into the single row we store for one use of one tool.
 * @param part - The tool part, in whatever state it ended in.
 * @returns Our stored shape.
 */
function storedTool(part: Extract<UiPart, { toolCallId: string }>): MessagePart {
  const status = statusOf(part.state);
  const stored: Extract<MessagePart, { type: "tool" }> = {
    type: "tool",
    toolCallId: part.toolCallId,
    toolName: getToolName(part),
    input: (part.input ?? {}) as Record<string, unknown>,
    status,
  };
  // Written only in the state that has one. A pending row carrying an empty
  // output would read as a tool that answered with nothing.
  if (status === "success") stored.output = part.output;
  if (status === "error" && "errorText" in part) stored.errorMessage = part.errorText;
  return stored;
}

/**
 * Turn what a finished turn streamed into what gets written down.
 * @param parts - The parts the SDK assembled for this message.
 * @returns The same message in the shape the store keeps.
 */
export function toStoredParts(parts: UiParts): MessagePart[] {
  const stored: MessagePart[] = [];
  for (const part of parts) {
    if (isToolUIPart(part)) {
      stored.push(storedTool(part));
      continue;
    }
    if (part.type === "text") stored.push({ type: "text", text: part.text });
    else if (part.type === "reasoning") stored.push({ type: "reasoning", text: part.text });
    else if (part.type === INTERRUPTED) stored.push({ type: "interrupted" });
    else if (part.type === FAILED) stored.push({ type: "failed" });
    // Anything else the protocol carries -- step boundaries, sources, the
    // beat -- is about the exchange rather than the message, and the message
    // is what this stores.
  }
  return stored;
}

/**
 * Turn a stored message back into what the client renders.
 * @param parts - The parts as they were written down.
 * @returns The same message in the shape the SDK's client reads.
 */
export function toUiParts(parts: MessagePart[]): UiParts {
  return parts.map((part): UiPart => {
    if (part.type === "text") return { type: "text", text: part.text };
    if (part.type === "reasoning") return { type: "reasoning", text: part.text };
    if (part.type === "interrupted") return { type: INTERRUPTED, data: {} };
    if (part.type === "failed") return { type: FAILED, data: {} };

    const base = {
      type: `tool-${part.toolName}`,
      toolCallId: part.toolCallId,
      input: part.input,
    };
    if (part.status === "success") {
      return { ...base, state: "output-available", output: part.output } as UiPart;
    }
    if (part.status === "error") {
      return { ...base, state: "output-error", errorText: part.errorMessage } as UiPart;
    }
    return { ...base, state: "input-available" } as UiPart;
  });
}

/**
 * What a message carries besides its parts, on its way to the browser.
 *
 * The turn is what the client pages back with; the timestamp is what it shows.
 * Both are ours rather than the protocol's, which is what `metadata` is for.
 */
export type StoredMessageMetadata = {
  /** The turn this message belongs to. Increments on each user message. */
  turnIndex: number;
  /** When the row was written, ISO-formatted. */
  ts: string;
};

/** One stored message as the client's `Chat` takes it. */
export type StoredUiMessage = UIMessage<StoredMessageMetadata>;

/**
 * Turn stored messages into what the client renders them from.
 *
 * The flat views the row also carries -- `content` and `thinking`, the parts
 * read out as plain strings -- do not come along. They exist so a reader that
 * wants only the prose need not walk the parts, and on the wire they would be
 * a second copy of what the parts already say, which the client would have to
 * keep in step with the first.
 * @param messages - The messages as they were written down.
 * @returns The same messages in the shape the SDK's client holds.
 */
export function toUiMessages(messages: MessageData[]): StoredUiMessage[] {
  return messages.map((message) => ({
    // The row's own id. Keying on anything else -- position, turn index --
    // would be making up something the store already knows.
    id: message.id ?? "",
    role: message.role,
    parts: toUiParts(message.parts),
    metadata: { turnIndex: message.turnIndex, ts: message.ts },
  }));
}
