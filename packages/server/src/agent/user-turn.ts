// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * One user message as the model is sent it.
 *
 * Only the server builds this text: the browser measures the attachments
 * against their limit with `attachmentSection`, which stays shared, but never
 * the whole turn.
 */

import type { ChatAttachedChip, ChatCurrentSpace, ChatSpace, ChatSpaceContext } from "@breatic/shared";
import { attachmentSection, attachmentTitle, writeReferences } from "@breatic/shared";

/** What one user message is made of. */
export interface UserTurn extends ChatSpaceContext {
  /** What the user attached to the message, in order. */
  chips: readonly ChatAttachedChip[];
  /** What the user typed. */
  message: string;
}

/**
 * The project's Spaces, one line each, the open one marked.
 * @param spaces - The Spaces listed.
 * @param total - How many there are, listed or not.
 * @param openId - The Space the reader has open and turned on, if any.
 * @returns The section.
 * @throws {never} Never.
 */
function spaceListSection(spaces: readonly ChatSpace[], total: number, openId: string | undefined): string {
  const lines = spaces.map(
    (s) => `- ${JSON.stringify(s.name)} (${s.kind})${s.id === openId ? " — the reader has this one open" : ""}`,
  );
  const unlisted = total - spaces.length;
  if (unlisted > 0) lines.push(`(${String(unlisted)} more not listed)`);
  return `## Spaces in this project\n\n${lines.join("\n")}`;
}

/**
 * What the open Space holds, or why it holds nothing the model can read.
 *
 * A document's text is quoted, so a heading in it is not read as a heading of
 * the turn; a canvas's text is JSON on one line and goes in as it is.
 * @param current - The Space the reader has open.
 * @returns The section.
 * @throws {never} Never.
 */
function openSpaceSection(current: ChatCurrentSpace): string {
  const heading = `## The Space the reader has open: ${JSON.stringify(current.name)} (${current.kind})`;
  if (current.state === "loading") return `${heading}\n\nIts content has not loaded yet.`;
  if (current.state === "unreadable") return `${heading}\n\nThe content of a ${current.kind} Space cannot be read.`;
  if (current.content === "") return `${heading}\n\nThis Space is empty.`;
  const isDocument = current.kind === "document";
  const body = isDocument ? JSON.stringify(current.content) : current.content;
  const shown = `${String(current.content.length)} of ${String(current.total_chars)} characters`;
  // A document is cut to its start; a canvas keeps the whole nodes that fit.
  const cut =
    current.total_chars <= current.content.length
      ? ""
      : isDocument
        ? `\n(Showing the first ${shown}.)`
        : `\n(The canvas is over the limit, so only some of its nodes are shown, with only the links between them: ${shown}.)`;
  return `${heading}\n\n${body}${cut}`;
}

/**
 * One user message as the model is sent it: the Spaces, the attachments, then
 * the words under their own heading.
 * @param turn - What the message is made of.
 * @returns The typed words alone when there is no Space and nothing attached.
 * @throws {never} Never.
 */
export function userTurnForModel(turn: UserTurn): string {
  const { chips, message, spaces = [], spaces_total: spacesTotal = spaces.length, current_space: current } = turn;
  const sections: string[] = [];
  if (spaces.length > 0) sections.push(spaceListSection(spaces, spacesTotal, current?.id));
  if (current) sections.push(openSpaceSection(current));
  if (chips.length > 0) sections.push(attachmentSection(chips));
  if (sections.length === 0) return message;
  const words = writeReferences(chips, message, (chip, n) => `[Attachment ${String(n)}: ${attachmentTitle(chip)}]`);
  return `${sections.join("\n\n")}\n\n## User message\n\n${words}`;
}
