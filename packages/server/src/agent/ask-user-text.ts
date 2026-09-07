// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Drawing a question the model asked as the markdown the reader sees.
 *
 * The tool's arguments are the format: a question, and between two and five
 * options. What they look like is decided here rather than asked of the
 * model, which is the whole reason the tool exists.
 *
 * Written as a list because the chat body folds single newlines into spaces —
 * three options on three lines would arrive as one run-on sentence. Fenced by
 * blank lines because the panel joins every text part of a reply into one
 * string and renders that once: without them this paragraph runs into whatever
 * the model wrote before it, and a second question lands inside the first
 * one's last option.
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
import type { AskUserPayload } from "@breatic/domain";

/**
 * Draw one question as the paragraph it appears as in the reply.
 * @param payload - What the tool returned.
 * @returns Markdown: the question, the options numbered from one, and what the
 *   model said about answering, each a paragraph apart and the whole fenced.
 */
export function askUserMarkdown(payload: AskUserPayload): string {
  const blocks = [payload.question];

  if (payload.options !== undefined && payload.options.length > 0) {
    blocks.push(
      payload.options.map((option, index) => `${String(index + 1)}. ${option}`).join("\n"),
    );
  }
  if (payload.howToAnswer !== undefined) blocks.push(payload.howToAnswer);

  return `\n\n${blocks.join("\n\n")}\n\n`;
}

/**
 * Write one question onto the reply as text.
 *
 * A payload on a tool part reaches nobody: the panel draws the reply's text.
 * So the turn writes it, and what it writes is the reply -- copyable, stored,
 * and rebuilt on a reload the way every other line of an answer is.
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
  writer.write({ type: "text-delta", id, delta: askUserMarkdown(payload) });
  writer.write({ type: "text-end", id });
}
