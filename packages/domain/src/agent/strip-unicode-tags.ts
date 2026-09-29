// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Unicode tag characters (U+E0000–E007F) taken out of text before a model
 * reads it.
 *
 * They render as nothing, and each one maps to an ASCII character, so a run
 * of them spells a line no reader sees and a model's tokenizer reads back as
 * words. A page, a document or a pasted line can carry an instruction that
 * way. Their one legitimate use left is the England, Scotland and Wales flags
 * (black flag, tag letters, cancel tag), and those three pass through whole.
 */

import type { LanguageModelMiddleware } from "ai";

/**
 * The three subdivision flags, each kept as one match, or any single tag
 * character on its own. The flags are listed exactly: a black flag followed
 * by any other tag letters is a sequence no platform draws, so its tags go.
 */
const TAGS_OUTSIDE_FLAGS =
  /(\u{1F3F4}\u{E0067}\u{E0062}(?:\u{E0065}\u{E006E}\u{E0067}|\u{E0073}\u{E0063}\u{E0074}|\u{E0077}\u{E006C}\u{E0073})\u{E007F})|[\u{E0000}-\u{E007F}]/gu;

/**
 * Take the tag characters out of one piece of text.
 * @param text - The text.
 * @returns The same text without tag characters, the three flags kept.
 */
export function stripUnicodeTags(text: string): string {
  return text.replace(TAGS_OUTSIDE_FLAGS, (_match, flag: string | undefined) => flag ?? "");
}

/**
 * Take the tag characters out of every string inside a value.
 *
 * Only plain objects and arrays are walked. Anything else -- bytes, a URL --
 * is handed back as the same object, since its contents are not text a model
 * reads.
 * @param value - Anything.
 * @returns A copy with every string cleaned; the value itself when it holds no text.
 */
export function stripUnicodeTagsDeep<T>(value: T): T {
  return cleanValue(value) as T;
}

/**
 * The untyped walk behind `stripUnicodeTagsDeep`.
 * @param value - Anything.
 * @returns The cleaned value.
 */
function cleanValue(value: unknown): unknown {
  if (typeof value === "string") return stripUnicodeTags(value);
  if (Array.isArray(value)) return value.map(cleanValue);
  if (value !== null && typeof value === "object") {
    const proto: unknown = Object.getPrototypeOf(value);
    if (proto !== Object.prototype && proto !== null) return value;
    return Object.fromEntries(
      Object.entries(value).map(([key, inner]) => [key, cleanValue(inner)]),
    );
  }
  return value;
}

/** The prompt one model call is about to be sent. */
type Prompt = Parameters<NonNullable<LanguageModelMiddleware["transformParams"]>>[0]["params"]["prompt"];

/** One message in it. */
type PromptMessage = Prompt[number];

/**
 * Clean one message of a prompt.
 *
 * What the model wrote itself is sent back as it was: its input was cleaned
 * already, and a provider that signs its reasoning (Anthropic) refuses the
 * next step if the signed text has changed. A tool result inside the model's
 * own message is a provider-run tool's output, so it is cleaned like any other.
 * @param message - The message.
 * @returns The message with its outside text cleaned.
 */
function cleanMessage(message: PromptMessage): PromptMessage {
  if (message.role !== "assistant") return stripUnicodeTagsDeep(message);
  return {
    ...message,
    content: message.content.map((part) =>
      part.type === "tool-result" ? stripUnicodeTagsDeep(part) : part,
    ),
  };
}

/** Cleans every prompt on its way to the provider, one step at a time. */
export const unicodeTagMiddleware: LanguageModelMiddleware = {
  transformParams: async ({ params }) => ({ ...params, prompt: params.prompt.map(cleanMessage) }),
};
