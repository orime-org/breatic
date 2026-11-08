// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * The links a conversation holds, and the one key two spellings of a link
 * are compared by (inner#1664).
 *
 * Both sides read links the same way: the server decides which pages the
 * Agent may read, and the panel merges two sources that name one page.
 */

/**
 * Every link written in a piece of text, in the order they appear.
 * @param text - The text.
 * @returns The links, each cleaned of the punctuation around it.
 * @throws {Error} Always, until implemented.
 */
export function pageLinksIn(text: string): string[] {
  void text;
  throw new Error("not implemented: pageLinksIn");
}

/**
 * The key two spellings of one page share.
 * @param link - A link, with or without its scheme.
 * @returns The key.
 * @throws {Error} Always, until implemented.
 */
export function pageLinkKey(link: string): string {
  void link;
  throw new Error("not implemented: pageLinkKey");
}
