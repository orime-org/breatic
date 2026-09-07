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
 * three options on three lines would arrive as one run-on sentence.
 */
import { t } from "@breatic/shared";

/** What `ask_user` hands back. */
export type AskUserPayload = { question: string; options: readonly string[] };

/**
 * Draw one question as the paragraph it appears as in the reply.
 * @param payload - What the tool returned.
 * @returns Markdown: the question, the numbered options, the closing line.
 */
export function askUserMarkdown(payload: AskUserPayload): string {
  // An open question is the question. There is nothing to number and nothing
  // to say about answering with a number.
  if (payload.options.length === 0) return payload.question;

  const numbered = payload.options
    .map((option, index) => `${String(index + 1)}. ${option}`)
    .join("\n");

  // Ours rather than the model's, so it is translated. It takes the interface
  // language the request negotiated, which is the one the reader picked.
  return [payload.question, numbered, t("server.chat.ask_user_hint")].join("\n\n");
}
