// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * One user message as the model is sent it.
 *
 * Only the server builds this text: the browser measures the attachments
 * against their limit with `attachmentSection`, which stays shared, but never
 * the whole turn.
 */

import { createHash } from "node:crypto";
import type { ChatAttachedChip, ChatCanvasDetail, ChatCurrentSpace, ChatSpace, ChatSpaceContext } from "@breatic/shared";
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
 * What stands in for an open Space whose content is what the history last
 * sent of it in full (inner#1549): the content once, then this line for as
 * long as it stays the same, so every turn does not carry it again.
 */
export const UNCHANGED_SPACE_NOTE = "Unchanged since the most recent message above that shows its content.";

/**
 * What the open Space holds, or why it holds nothing the model can read.
 *
 * A document's text is quoted, so a heading in it is not read as a heading of
 * the turn; a canvas's text is JSON on one line and goes in as it is.
 * @param current - The Space the reader has open.
 * @param unchanged - Its content is what the history last sent of it in full.
 * @returns The section.
 * @throws {never} Never.
 */
function openSpaceSection(current: ChatCurrentSpace, unchanged = false): string {
  const heading = `## The Space the reader has open: ${JSON.stringify(current.name)} (${current.kind})`;
  if (current.state === "loading") return `${heading}\n\nIts content has not loaded yet.`;
  if (current.state === "unreadable") return `${heading}\n\nThe content of a ${current.kind} Space cannot be read.`;
  if (current.content === "") return `${heading}\n\nThis Space is empty.`;
  if (unchanged) return `${heading}\n\n${UNCHANGED_SPACE_NOTE}`;
  const isDocument = current.kind === "document";
  const body = isDocument ? JSON.stringify(current.content) : current.content;
  const shown = `${String(current.content.length)} of ${String(current.total_chars)} characters`;
  const cut =
    current.total_chars <= current.content.length
      ? ""
      : current.detail === undefined
        ? `\n(Showing the first ${shown}.)`
        : `\n${canvasNote(shown, current.detail)}`;
  return `${heading}\n\n${body}${cut}`;
}

/**
 * What the open Space would be sent as, hashed, to tell whether it is what
 * the history last sent of it in full.
 *
 * Taken over the whole section, heading and note on what was cut included:
 * a renamed Space or a different cut is not the copy above.
 * @param current - The Space the reader has open, if any.
 * @returns The Space and the hash, or undefined when its section is already
 *   one line.
 * @throws {never} Never.
 */
export function openSpaceKey(current: ChatCurrentSpace | undefined): { spaceId: string; key: string } | undefined {
  if (current?.state !== "loaded" || current.content === "") return undefined;
  return { spaceId: current.id, key: createHash("sha256").update(openSpaceSection(current)).digest("hex") };
}

/**
 * What was done to fit an open canvas, one sentence per step actually taken.
 * @param shown - How many of how many characters went.
 * @param detail - What was done.
 * @returns The note.
 * @throws {never} Never.
 */
function canvasNote(shown: string, detail: ChatCanvasDetail): string {
  const { selected_total: total, selected_attached: attached, selected_whole: whole } = detail;
  const parts = [`(The canvas is over the limit, so it is shown in less detail: ${shown}.`];
  if (total > 0) {
    const inAttachments = attached > 0 ? ` and ${String(attached)} are complete in the attachments` : "";
    parts.push(` The reader selected ${String(total)} nodes; ${String(whole)} of them are complete here${inAttachments}.`);
  }
  if (detail.slim) {
    parts.push(
      " Nodes that are not complete carry at most their id, type, name, group and texts, the media and nodes they refer to, who wrote their replies, how long their shots are, and the mode, model and settings they would run.",
    );
  }
  const counted: Array<[number, string]> = [
    [detail.texts_cut, ' texts are cut short; each ends with "…[+N]", N being the characters left out.'],
    [detail.names_only, " nodes show only their id, type, name and group."],
    [detail.edges_not_listed, " links are not listed."],
    [detail.nodes_not_listed, " nodes are not listed."],
    [detail.groups_not_listed, " groups are not listed; nodes inside them still name them as parentId."],
  ];
  for (const [n, sentence] of counted) if (n > 0) parts.push(` ${String(n)}${sentence}`);
  // Selecting a node shows it whole only when the canvas fitted once its
  // nodes went slim and every selected node there was whole.
  const fitAtSlim = counted.every(([n]) => n === 0) && whole + attached === total;
  parts.push(
    fitAtSlim
      ? " To see nodes in full, ask the reader to select them or add them to the Agent.)"
      : " To see nodes in full, ask the reader to add them to the Agent.)",
  );
  return parts.join("");
}

/**
 * The Spaces a message carries: the project's list, then the one open.
 * @param space - The reader's Spaces.
 * @param spaceUnchanged - The open Space is what the history last sent of it
 *   in full, so it goes as one line.
 * @returns The sections, in order; none when there are no Spaces.
 * @throws {never} Never.
 */
function spaceSections(space: ChatSpaceContext, spaceUnchanged: boolean): string[] {
  const { spaces = [], spaces_total: spacesTotal = spaces.length, current_space: current } = space;
  const sections: string[] = [];
  if (spaces.length > 0) sections.push(spaceListSection(spaces, spacesTotal, current?.id));
  if (current) sections.push(openSpaceSection(current, spaceUnchanged));
  return sections;
}

/**
 * One user message as the model is sent it: the Spaces, the attachments, then
 * the words under their own heading.
 * @param turn - What the message is made of.
 * @param spaceUnchanged - The open Space is what the history last sent of it
 *   in full, so it goes as one line.
 * @returns The typed words alone when there is no Space and nothing attached.
 * @throws {never} Never.
 */
export function userTurnForModel(turn: UserTurn, spaceUnchanged = false): string {
  const { chips, message } = turn;
  const sections = spaceSections(turn, spaceUnchanged);
  if (chips.length > 0) sections.push(attachmentSection(chips));
  if (sections.length === 0) return message;
  const words = writeReferences(chips, message, (chip, n) => `[Attachment ${String(n)}: ${attachmentTitle(chip)}]`);
  return `${sections.join("\n\n")}\n\n## User message\n\n${words}`;
}

/**
 * The reminder each user message closes with.
 *
 * The rule is in the system prompt. From there alone, DeepSeek wrote the
 * proposal prompts in the reader's language in 14 of 18 runs; with this line
 * under the reader's own words (before the exceptions clause was added), Claude
 * Opus 5.5 did in 27 of 27 (inner#1447). Written into the message, it is
 * stored and replayed with it, so it never changes a prefix the provider has
 * cached. The product terms ride along for the same reason: from the system
 * prompt alone, the model echoed a translated term the reader had just typed
 * (inner#1600).
 */
export const READER_LANGUAGE_REMINDER =
  "(Reply and write every text the user will read or edit in the language this message is written in, " +
  "unless the user has asked for a specific language or the work itself sets one. " +
  "Keep the product terms the system prompt lists in English, even where this message translates them.)";

/**
 * One user message exactly as the turn sends it: the reader's clock, the
 * message itself, then the reminder of the reader's language.
 * @param clockNote - The line that says what time it is for the reader.
 * @param turn - What the message is made of.
 * @param spaceUnchanged - The open Space goes as one line.
 * @returns The message text.
 * @throws {never} Never.
 */
export function userMessageForModel(clockNote: string, turn: UserTurn, spaceUnchanged = false): string {
  return `${clockNote}\n\n${userTurnForModel(turn, spaceUnchanged)}\n\n${READER_LANGUAGE_REMINDER}`;
}

/**
 * The message a segment resumed after a questionnaire opens with: the
 * reader's clock and Spaces as they were when the answer was sent. It carries
 * no words of the reader's -- the answer is the call's result -- so it has no
 * heading for them and no reminder about their language.
 * @param clockNote - The line saying what time it is for the reader.
 * @param space - The reader's Spaces when they answered.
 * @param spaceUnchanged - The open Space is what the history last sent of it
 *   in full, so it goes as one line.
 * @returns The message's text.
 * @throws {never} Never.
 */
export function continuationMessageForModel(clockNote: string, space: ChatSpaceContext, spaceUnchanged = false): string {
  return [clockNote, ...spaceSections(space, spaceUnchanged)].join("\n\n");
}
