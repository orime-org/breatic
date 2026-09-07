// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Drawing a question the model asked as the markdown the reader sees.
 *
 * The tool's arguments are the format: a question, and up to five options. What
 * they look like is decided here rather than asked of the model, which is the
 * whole reason the tool exists.
 *
 * Built as a document and serialised rather than joined as strings. A rule of
 * ours about which characters are dangerous would have to enumerate a markdown
 * grammar and would be wrong in both directions -- refusing a hex colour, which
 * is prose, while letting through three dashes, which are a rule that swallows
 * the question above the list. The serialiser owns that knowledge, so a value
 * arrives as the characters it is.
 *
 * Which grammar it owns is a setting, and it has to be the one the panel reads
 * back: `MarkdownMessage` parses CommonMark plus GFM plus math, so the same two
 * extensions go in here. Left to CommonMark alone, everything those two add is
 * escaped by neither side and re-read as syntax -- a question offering a range
 * of `20~25` against one of `30~35` arrives with its middle struck through and
 * deleted, and a URL carrying an underscore arrives as a link to an address
 * with a backslash in it.
 *
 * Every word of it is the model's own, and that is what keeps the paragraph in
 * the language the conversation is being held in. Which language that is, is
 * the model's to judge; the interface switch says what the buttons are in, not
 * what the reader wants to be answered in. So a line of ours pinned under the
 * list would be the one part of the paragraph in a language nobody chose for
 * it. Telling the reader how to answer is a field of the call instead: the
 * tool decides where it sits, the model decides whether to say it and what it
 * says.
 */

import type { UIMessageStreamWriter } from "ai";
import { gfmToMarkdown } from "mdast-util-gfm";
import { mathToMarkdown } from "mdast-util-math";
import { toMarkdown } from "mdast-util-to-markdown";
import type { List, Paragraph, RootContent } from "mdast";

import type { AskUserPayload } from "@breatic/domain";

/** What the panel reads on top of CommonMark, so that the escaping matches. */
const PANEL_GRAMMAR = [gfmToMarkdown(), mathToMarkdown()];

/**
 * One line of the model's words, as a paragraph of its own.
 * @param value - What the model wrote.
 * @returns That line as a document node.
 */
function paragraph(value: string): Paragraph {
  return { type: "paragraph", children: [{ type: "text", value }] };
}

/**
 * The answers on offer, numbered from one.
 * @param options - What the model is offering, in the order it offered them.
 * @returns Those answers as an ordered list.
 */
function numbered(options: readonly string[]): List {
  return {
    type: "list",
    ordered: true,
    start: 1,
    spread: false,
    children: options.map((option) => ({
      type: "listItem",
      spread: false,
      children: [paragraph(option)],
    })),
  };
}

/**
 * Draw one question as the paragraph it appears as in the reply.
 * @param payload - What the tool returned.
 * @returns Markdown: the question, the options numbered from one, and what the
 *   model said about answering, each a paragraph apart.
 */
export function askUserMarkdown(payload: AskUserPayload): string {
  const blocks: RootContent[] = [paragraph(payload.question)];

  if (payload.options !== undefined && payload.options.length > 0) {
    blocks.push(numbered(payload.options));
  }
  if (payload.howToAnswer !== undefined) blocks.push(paragraph(payload.howToAnswer));

  return toMarkdown({ type: "root", children: blocks }, { extensions: PANEL_GRAMMAR }).trimEnd();
}

/**
 * Write one question onto the reply as text.
 *
 * A payload on a tool part reaches nobody: the panel draws the reply's text.
 * So the turn writes it, and what it writes is the reply -- copyable, stored,
 * and rebuilt on a reload the way every other line of an answer is.
 *
 * Fenced by blank lines because the panel joins every text part of a reply into
 * one string and renders that once: without them this paragraph runs into
 * whatever the model wrote before it, and a second question lands inside the
 * first one's last option.
 * @param writer - The stream this turn is being written to.
 * @param toolCallId - Which call this is, so the part has an id of its own.
 * @param payload - What the tool returned.
 */
export function writeAskUserText(
  writer: UIMessageStreamWriter,
  toolCallId: string,
  payload: AskUserPayload,
): void {
  const id = `ask-${toolCallId}`;
  writer.write({ type: "text-start", id });
  writer.write({ type: "text-delta", id, delta: `\n\n${askUserMarkdown(payload)}\n\n` });
  writer.write({ type: "text-end", id });
}
