// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Unicode tag characters taken out of everything a model is sent: the deep
 * walk for structured payloads, and the middleware that cleans each step's
 * prompt. The text rule itself is `stripUnicodeTags` in `@breatic/shared`,
 * which `extractPromptText` uses as well.
 */

import type { LanguageModelMiddleware } from "ai";
import { stripUnicodeTags } from "@breatic/shared";

/**
 * Take the tag characters out of every string inside a value, keys included.
 *
 * Only plain objects and arrays are walked. Anything else -- bytes, a URL --
 * is handed back as the same object, since its contents are not text a model
 * reads.
 * @param value - Anything.
 * @returns A copy with every string cleaned.
 */
export function stripUnicodeTagsDeep<T>(value: T): T {
  if (typeof value === "string") return stripUnicodeTags(value) as T;
  if (Array.isArray(value)) return value.map(stripUnicodeTagsDeep) as T;
  if (value !== null && typeof value === "object") {
    const proto: unknown = Object.getPrototypeOf(value);
    if (proto !== Object.prototype && proto !== null) return value;
    return Object.fromEntries(
      Object.entries(value).map(([key, inner]) => [stripUnicodeTags(key), stripUnicodeTagsDeep(inner)]),
    ) as T;
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
