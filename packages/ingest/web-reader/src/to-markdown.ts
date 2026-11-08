// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/** A page's article HTML as the Markdown the Agent reads (inner#1664). */
import TurndownService from "turndown";

const turndown = new TurndownService({ headingStyle: "atx", codeBlockStyle: "fenced" });

/**
 * Convert an article's HTML to Markdown.
 * @param html - The HTML Readability extracted.
 * @returns The Markdown.
 * @throws {never} Never.
 */
export function toMarkdown(html: string): string {
  return turndown.turndown(html);
}
