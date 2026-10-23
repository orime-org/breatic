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
 * Characters are the fallback: the fold is decided by the provider's own
 * token counts, and these measure only what no count covers -- a turn whose
 * reply kept no count (its calls reported nothing, or it was stored before
 * any copy was kept), what came after the newest reply sent again as it was
 * sent, this turn's question, and the system prompt and tools when no reply
 * goes out as it was sent. A character is never more than a token in the tokenizers
 * this build meets, so counting one as a token can only make a fold come
 * early. There is no library that counts tokens for a model reached through
 * OpenRouter — see the design's DD section.
 */

import { asSchema } from "ai";
import type { ModelMessage, Tool } from "ai";
import { AGENT_TOOL_PICTURE_MARKER, instructionsText } from "@breatic/domain";
import { getAgentConfig } from "@breatic/core";
import type { Instructions } from "@breatic/domain";

/**
 * The length of one content part, by what the model is shown of it.
 * @param part - A part of a message's content.
 * @param picturesExpanded - Native files immediately following the tool group already represent its pictures.
 * @returns Its length in characters.
 */
function measurePart(part: unknown, picturesExpanded = false): number {
  if (typeof part === "string") return part.length;
  if (part === null || typeof part !== "object") return String(part).length;

  const p = part as { type?: string; text?: string; mediaType?: string; toolName?: string; input?: unknown; output?: unknown };
  switch (p.type) {
    case "text":
    case "reasoning":
      return p.text?.length ?? 0;
    case "tool-call":
      return (p.toolName?.length ?? 0) + JSON.stringify(p.input ?? null).length;
    case "tool-result":
      if (p.output !== null && typeof p.output === "object") {
        const output = p.output as { type?: string; value?: unknown };
        if (output.type === "json" && output.value !== null && typeof output.value === "object") {
          const value = output.value as { kind?: string; pictures?: unknown[] };
          if (value.kind === "agent-pictures-v1" && Array.isArray(value.pictures)) {
            return JSON.stringify({ ...output, value: { ...value, pictures: [] } }).length +
              (picturesExpanded ? 0 : value.pictures.length * getAgentConfig().picture_tokens_estimate);
          }
        }
      }
      return JSON.stringify(p.output ?? null).length;
    case "file":
      return p.mediaType?.startsWith("image/") ? getAgentConfig().picture_tokens_estimate : JSON.stringify(part).length;
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
 * @param picturesExpanded - The tool group's pictures are present as native files after it.
 * @returns Its length in characters.
 */
function measureMessage(message: ModelMessage, picturesExpanded = false): number {
  const { content } = message;
  if (typeof content === "string") return content.length;
  if (!Array.isArray(content)) return 0;
  return content.reduce((sum: number, part) => sum + measurePart(part, picturesExpanded), 0);
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
  return messages.reduce((sum, message, index) => {
    let after = index + 1;
    while (messages[after]?.role === "tool") after += 1;
    const next = messages[after];
    const expanded = message.role === "tool" && next?.role === "user" && Array.isArray(next.content) &&
      next.content[0]?.type === "text" && next.content[0].text === AGENT_TOOL_PICTURE_MARKER;
    return sum + measureMessage(message, expanded);
  }, 0);
}

/**
 * How long the system prompt and the tool definitions are, in characters.
 * @param request - What the request carries besides its messages.
 * @param request.instructions - The system prompt, persona through memory, in its parts.
 * @param request.tools - The tools as the factory resolved them, keyed by name.
 * @returns The total length.
 */
export function measureInstructionsAndTools(request: {
  instructions: Instructions;
  tools: Readonly<Record<string, Tool>>;
}): number {
  return Object.entries(request.tools).reduce(
    (sum, [name, definition]) => sum + measureTool(name, definition),
    instructionsText(request.instructions).length,
  );
}
