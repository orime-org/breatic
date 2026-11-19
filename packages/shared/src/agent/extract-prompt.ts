// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

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
 *
 * One pass can leave a tag behind (`&lt;b&gt;` decodes into one, an invisible
 * character inside brackets goes after the tags are stripped), so it runs
 * until the text stops changing: cleaning a value twice gives what cleaning it
 * once gave, and a check that cleans once judges what a sender that cleans
 * twice sends (#1521). Every pass only removes, decodes or folds and takes time
 * in proportion to the text, and a pass can leave at most a tag or an entity
 * decoded or joined behind, so a few passes reach the end.
 * @param prompt - Raw prompt value (string, HTML, or unknown)
 * @returns Clean plain text suitable for AIGC provider input
 */
export function extractPromptText(prompt: unknown): string {
  if (prompt == null) return "";
  let text = typeof prompt === "string" ? prompt : String(prompt);
  for (let next = cleanOnce(text); next !== text; next = cleanOnce(text)) text = next;
  return text;
}

/** The entities the cleaning decodes, by name. */
const DECODED: Readonly<Record<string, string>> = { lt: "<", gt: ">", amp: "&", quot: '"', "#39": "'", nbsp: " " };

/** One entity, behind any number of `amp;` it was escaped with. */
const ENTITY = /&(?:amp;)*(lt|gt|amp|quot|#39|nbsp);/g;

/**
 * The text with every HTML comment removed, each from its `<!--` to the first `-->` after it on the same line,
 * scanning each line once.
 * @param text - The text.
 * @returns The text, each comment replaced by a space.
 * @throws {never} Never.
 */
function stripComments(text: string): string {
  return text.split("\n").map((line) => {
    let kept = "";
    let from = 0;
    for (;;) {
      const open = line.indexOf("<!--", from);
      if (open < 0) break;
      const close = line.indexOf("-->", open + 4);
      // No comment closes on this line after this one opens, so none after it does either.
      if (close < 0) break;
      kept += `${line.slice(from, open)} `;
      from = close + 3;
    }
    return kept + line.slice(from);
  }).join("\n");
}

/** A letter, which is what a tag's name opens with. */
const LETTER = /[a-zA-Z]/;

/**
 * The text with every HTML tag removed: a `<` followed by a letter, or by `/` and a letter, up to the next `>` on
 * the same line with no other `<` between. A tag nested inside another goes first, and the one around it then
 * closes over the space left behind, so tags come out from the inside in one scan of each line.
 * @param text - The text.
 * @returns The text, each tag replaced by a space.
 * @throws {never} Never.
 */
function stripTags(text: string): string {
  return text.split("\n").map((line) => {
    const kept: string[] = [];
    // Where each tag still open starts in `kept`, innermost last.
    const open: number[] = [];
    for (let at = 0; at < line.length; at += 1) {
      const char = line.charAt(at);
      if (char === "<") {
        const next = line.charAt(at + 1);
        const opens = LETTER.test(next) || (next === "/" && LETTER.test(line.charAt(at + 2)));
        // A `<` that opens no tag stands between any tag open before it and its `>`.
        if (opens) open.push(kept.length);
        else open.length = 0;
        kept.push(char);
      } else if (char === ">" && open.length > 0) {
        kept.length = open.pop() ?? 0;
        kept.push(" ");
      } else {
        kept.push(char);
      }
    }
    return kept.join("");
  }).join("\n");
}

/**
 * One pass of the cleaning {@link extractPromptText} repeats.
 * @param raw - The text.
 * @returns The text after one pass.
 * @throws {never} Never.
 */
function cleanOnce(raw: string): string {
  // Every line break as one `\n` first, so no tag or comment reaches across a bare `\r` either.
  let text = raw.replace(/\r\n?/g, "\n");

  // Strip HTML comments, each within one line.
  text = stripComments(text);

  // Strip HTML tags. A tag opens with a letter, optionally behind a slash —
  // requiring that is what separates markup from a pair of angle brackets a
  // person typed. `<[^>]*>` matched both, and a voiceover script is read out
  // word for word: `under <100, over >50` lost the clause between the two,
  // and `5 < 6` lost every line down to the next `>`. A tag and a comment end
  // on the line they open on: a line break is the user's own, and a dialogue
  // sends one turn per line (#1521).
  text = stripTags(text);

  // Decode common HTML entities, a whole `&amp;amp;…` chain at once so its
  // depth never sets the number of passes.
  text = text.replace(ENTITY, (_chain, name: string) => DECODED[name] ?? "");

  // Remove zero-width characters, and the tag characters a hidden instruction
  // is spelled in
  text = stripUnicodeTags(text.replace(/[\u200B-\u200D\uFEFF\u2060]/g, ""));

  // Normalize horizontal whitespace, keep the line structure. A line break a
  // user typed is their own content — in a voiceover script it is where the
  // pacing lives — so flattening it here changes the text a provider is sent.
  // Tag removal above substitutes a space, never a break, so nothing that was
  // one line becomes two.
  text = text
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
