// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Extract safe plain text from a rich-text prompt field.
 *
 * Strips HTML tags, invisible characters, HTML comments, and
 * normalizes whitespace. This is the sanctioned way to clean
 * a canvas node prompt before passing it to an AIGC provider.
 *
 * NOTE: This reduces the HTML injection attack surface but does
 * NOT prevent prompt injection via plain text. LLM-level defenses
 * (system prompt design, output filtering) are separate concerns.
 */

/**
 * Reduce a raw prompt value to clean plain text for an AIGC provider —
 * strips HTML tags, comments, and invisible characters.
 * @param prompt - Raw prompt value (string, HTML, or unknown)
 * @returns Clean plain text suitable for AIGC provider input
 */
export function extractPromptText(prompt: unknown): string {
  if (prompt == null) return "";

  let text = typeof prompt === "string" ? prompt : String(prompt);

  // Strip HTML comments
  text = text.replace(/<!--[\s\S]*?-->/g, " ");

  // Strip HTML tags
  text = text.replace(/<[^>]*>/g, " ");

  // Decode common HTML entities
  text = text
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ");

  // Remove zero-width and invisible characters
  text = text.replace(/[\u200B-\u200D\uFEFF\u2060]/g, "");

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
