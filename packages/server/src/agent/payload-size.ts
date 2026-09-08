// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * How long the thing about to go to the model is.
 *
 * The budget is drawn around the assembled request, which is three things:
 * the instructions, the tool definitions, and the messages. The tool
 * definitions are the segment that lives in neither of the other two — they
 * reach the provider as their own argument — so a measurement that adds up
 * only the two strings is short by the whole tool set, and short in a way
 * that grows every time a tool is added.
 *
 * Characters, not tokens: a character is never more than a token in the
 * tokenizers this build meets, so a character budget can only fire early.
 * There is no library that counts tokens for a model reached through
 * OpenRouter — see the design's DD section.
 */

import { asSchema } from "ai";
import type { ModelMessage, Tool } from "ai";

/** The three segments a request is assembled from. */
export interface AssembledPayload {
  /** The system prompt, persona through memory. */
  instructions: string;
  /** The tools as the factory resolved them, keyed by name. */
  tools: Readonly<Record<string, Tool>>;
  /** The history and this turn's question, as the SDK will send them. */
  messages: readonly ModelMessage[];
}

/**
 * The length of one content part, by what the model is shown of it.
 * @param part - A part of a message's content.
 * @returns Its length in characters.
 */
function measurePart(part: unknown): number {
  if (typeof part === "string") return part.length;
  if (part === null || typeof part !== "object") return String(part).length;

  const p = part as { type?: string; text?: string; toolName?: string; input?: unknown; output?: unknown };
  switch (p.type) {
    case "text":
    case "reasoning":
      return p.text?.length ?? 0;
    case "tool-call":
      return (p.toolName?.length ?? 0) + JSON.stringify(p.input ?? null).length;
    case "tool-result":
      return JSON.stringify(p.output ?? null).length;
    default:
      return JSON.stringify(part).length;
  }
}

/**
 * The length of one message, by what the model is shown of it.
 *
 * The role and the structural markers are left out: they are the envelope
 * rather than the content, and counting them would make the number depend on
 * how the SDK happens to serialise a message this month.
 * @param message - The message as the SDK will send it.
 * @returns Its length in characters.
 */
function measureMessage(message: ModelMessage): number {
  const { content } = message;
  if (typeof content === "string") return content.length;
  if (!Array.isArray(content)) return 0;
  return content.reduce((sum: number, part) => sum + measurePart(part), 0);
}

/**
 * The length of one tool's definition, as the provider is given it.
 * @param name - The name the model calls it by.
 * @param definition - The tool as the factory resolved it.
 * @returns Its length in characters.
 */
function measureTool(name: string, definition: Tool): number {
  const described = definition.description?.length ?? 0;
  // The SDK's own conversion, not a second one: it renders draft-7 from the
  // input side and adds `additionalProperties`, so a conversion written here
  // would measure a document no provider is ever sent. It also answers for a
  // tool that declares no schema — an empty object is what goes out for one.
  const declared = JSON.stringify(asSchema(definition.inputSchema).jsonSchema).length;
  return name.length + described + declared;
}

/**
 * How long a run of messages is, in characters.
 *
 * The same ruler the budget is read with, applied to one part of what it
 * measures: a consolidation decides how many turns to take by what each of
 * them costs the assembled request.
 * @param messages - The messages to measure.
 * @returns Their total length.
 */
export function measureMessages(messages: readonly ModelMessage[]): number {
  return messages.reduce((sum, message) => sum + measureMessage(message), 0);
}

/**
 * How long the assembled request is, in characters.
 * @param payload - The three segments, as they will be sent.
 * @returns The total length.
 */
export function measurePayload(payload: AssembledPayload): number {
  const instructions = payload.instructions.length;
  const tools = Object.entries(payload.tools).reduce(
    (sum, [name, definition]) => sum + measureTool(name, definition),
    0,
  );
  return instructions + tools + measureMessages(payload.messages);
}
