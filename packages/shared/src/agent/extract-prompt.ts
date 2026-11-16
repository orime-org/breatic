// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * Extract safe plain text from a rich-text prompt field.
 *
 * Strips HTML tags, HTML comments, zero-width characters and Unicode tag
 * characters (`stripUnicodeTags`), and normalizes whitespace. This is the sanctioned way to clean
 * a canvas node prompt before passing it to an AIGC provider.
 *
 * NOTE: This reduces the HTML injection attack surface but does
 * NOT prevent prompt injection via plain text. LLM-level defenses
 * (system prompt design, output filtering) are separate concerns.
 */

import { stripUnicodeTags } from "@shared/agent/strip-unicode-tags.js";

/**
 * Reduce a raw prompt value to clean plain text for an AIGC provider —
 * strips HTML tags, comments, zero-width and Unicode tag characters.
 * @param prompt - Raw prompt value (string, HTML, or unknown)
 * @returns Clean plain text suitable for AIGC provider input
 */
export function extractPromptText(prompt: unknown): string {
  if (prompt == null) return "";

  let text = typeof prompt === "string" ? prompt : String(prompt);

  // Strip HTML comments, each within one line.
  text = text.replace(/<!--[^\n]*?-->/g, " ");

  // Strip HTML tags. A tag opens with a letter, optionally behind a slash —
  // requiring that is what separates markup from a pair of angle brackets a
  // person typed. `<[^>]*>` matched both, and a voiceover script is read out
  // word for word: `under <100, over >50` lost the clause between the two,
  // and `5 < 6` lost every line down to the next `>`. A tag and a comment end
  // on the line they open on: a line break is the user's own, and a dialogue
  // sends one turn per line (#1521).
  text = text.replace(/<\/?[a-zA-Z][^<>\n]*>/g, " ");

  // Decode common HTML entities
  text = text
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ");

  // Remove zero-width characters, and the tag characters a hidden instruction
  // is spelled in
  text = stripUnicodeTags(text.replace(/[\u200B-\u200D\uFEFF\u2060]/g, ""));

  // Normalize horizontal whitespace, keep the line structure. A line break a
  // user typed is their own content — in a voiceover script it is where the
  // pacing lives — so flattening it here changes the text a provider is sent.
  // Tag removal above substitutes a space, never a break, so nothing that was
  // one line becomes two.
  text = text
    .replace(/\r\n?/g, "\n")
    .replace(/[^\S\n]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  return text;
}

/** What {@link cleanTextParams} reads of a param's declaration. */
export interface TextParamSpec {
  readonly type?: string;
  /** Where the panel takes the value from; `editor` is words the user writes in a box of their own, such as lyrics. */
  readonly fill?: string;
  /** For an `items` param, the declaration of each field of an item. */
  readonly fields?: Readonly<Record<string, { readonly type?: string }>>;
}

/**
 * A run's params with every text param (declared `text`, or written in an editor box), and every text field of an
 * `items` param, passed through {@link extractPromptText}: what the worker sends, and so what every check before it
 * asks about.
 * @param model - The model, for which params are text.
 * @param model.params - Its param declarations.
 * @param params - The params as written.
 * @returns The params, text cleaned; everything else as it was.
 * @throws {never} Never.
 */
export function cleanTextParams(
  model: { readonly params?: Readonly<Record<string, TextParamSpec>> },
  params: Readonly<Record<string, unknown>>,
): Record<string, unknown> {
  return Object.fromEntries(Object.entries(params).map(([key, value]) => {
    const spec = model.params?.[key];
    if ((spec?.type === "text" || spec?.fill === "editor") && typeof value === "string") return [key, extractPromptText(value)];
    if (spec?.type !== "items" || !Array.isArray(value)) return [key, value];
    const fields = spec.fields ?? {};
    return [key, value.map((item: unknown) =>
      typeof item === "object" && item !== null && !Array.isArray(item)
        ? Object.fromEntries(Object.entries(item as Record<string, unknown>).map(([field, held]) =>
          [field, fields[field]?.type === "text" && typeof held === "string" ? extractPromptText(held) : held]))
        : item,
    )];
  }));
}
