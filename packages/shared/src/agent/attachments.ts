// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import type { ChatAttachedChip } from "@shared/schemas/api.js";

/**
 * The name an attached item travels under on the chat wire.
 *
 * A data part, the one channel the SDK's protocol leaves open for what it does
 * not define. The browser writes it on the message it sends and reads it back
 * from history; the server hands stored attachments out under it.
 */
export const ATTACHMENT_DATA_PART = "data-attachment";

/** One attached item as a data part on the chat wire. */
export interface AttachmentDataPart {
  type: typeof ATTACHMENT_DATA_PART;
  data: ChatAttachedChip;
}

/**
 * Put an attached item on the wire.
 * @param chip - The item.
 * @returns Its data part.
 */
export function attachmentPart(chip: ChatAttachedChip): AttachmentDataPart {
  return { type: ATTACHMENT_DATA_PART, data: chip };
}

/**
 * Read an attached item back off the wire.
 * @param part - Any part of a message.
 * @param part.type - What kind of part it is.
 * @returns The item, or undefined for a part of another kind.
 */
export function chipOfPart(part: { type: string }): ChatAttachedChip | undefined {
  return part.type === ATTACHMENT_DATA_PART ? (part as AttachmentDataPart).data : undefined;
}

/**
 * What an item's section is headed with: its name, or for several canvas
 * nodes picked together, how many there are.
 * @param chip - The item.
 * @returns The heading.
 */
function titleOf(chip: ChatAttachedChip): string {
  if (chip.name) return chip.name;
  const nodes = chip.data_snapshot.nodes;
  return Array.isArray(nodes) ? `${chip.type}, ${nodes.length} nodes` : chip.type;
}

/** Where a reference to an attachment sits in the typed words. */
const MARKER = /@\[attachment:([^\]\s]+)\]/g;

/**
 * A reference to an attachment, as it is written into the typed words.
 * @param id - The attachment it points at.
 * @returns The marker.
 */
export function attachmentMarker(id: string): string {
  return `@[attachment:${id}]`;
}

/** One run of the typed words: plain text, or a reference to an attachment. */
export type MessageSegment = { kind: "text"; text: string } | { kind: "reference"; id: string };

/**
 * The typed words split around their references, in order.
 * @param message - What the user typed.
 * @returns The runs; empty for an empty message.
 */
export function messageSegments(message: string): MessageSegment[] {
  const out: MessageSegment[] = [];
  let at = 0;
  for (const match of message.matchAll(MARKER)) {
    if (match.index > at) out.push({ kind: "text", text: message.slice(at, match.index) });
    out.push({ kind: "reference", id: match[1] ?? "" });
    at = match.index + match[0].length;
  }
  if (at < message.length) out.push({ kind: "text", text: message.slice(at) });
  return out;
}

/**
 * One run of the typed words with its reference matched: plain text, a
 * reference to one of the message's attachments (with its place among them,
 * from 1), or a marker for anything the message did not carry.
 */
export type ResolvedSegment<C> =
  | { kind: "text"; text: string }
  | { kind: "reference"; chip: C; n: number }
  | { kind: "unattached"; marker: string };

/**
 * The typed words split around their references, each matched to the
 * attachment it points at. The one place a marker is matched to an
 * attachment.
 * @param chips - What the user attached to the message, in order.
 * @param message - What the user typed.
 * @returns The runs.
 */
export function resolvedSegments<C extends { readonly id: string }>(
  chips: readonly C[],
  message: string,
): ResolvedSegment<C>[] {
  const byId = new Map<string, { chip: C; n: number }>();
  chips.forEach((chip, i) => {
    if (!byId.has(chip.id)) byId.set(chip.id, { chip, n: i + 1 });
  });
  return messageSegments(message).map((segment): ResolvedSegment<C> => {
    if (segment.kind === "text") return segment;
    const hit = byId.get(segment.id);
    return hit ? { kind: "reference", ...hit } : { kind: "unattached", marker: attachmentMarker(segment.id) };
  });
}

/**
 * The typed words with each reference written out; a marker for anything the
 * message did not carry stays the text it is.
 * @param chips - What the user attached to the message, in order.
 * @param message - What the user typed.
 * @param write - What a reference becomes, given its attachment and its place.
 * @returns The words.
 */
export function writeReferences<C extends { readonly id: string }>(
  chips: readonly C[],
  message: string,
  write: (chip: C, n: number) => string,
): string {
  return resolvedSegments(chips, message)
    .map((s) => (s.kind === "text" ? s.text : s.kind === "reference" ? write(s.chip, s.n) : s.marker))
    .join("");
}

/**
 * The typed words for a conversation's name: a reference to a named
 * attachment reads as that name, one to an unnamed attachment as nothing.
 * The model's own headings are English and stay out of what a reader sees.
 * @param chips - What the user attached to the message.
 * @param message - What the user typed.
 * @returns The words.
 */
export function wordsForTitle(chips: readonly ChatAttachedChip[], message: string): string {
  return writeReferences(chips, message, (chip) => chip.name);
}

/**
 * How long the typed words are, counting each reference as one character, the
 * way the reader sees it in the box.
 * @param chips - What the user attached to the message; only their ids are read.
 * @param message - What the user typed.
 * @returns The length.
 */
export function messageLength(chips: ReadonlyArray<{ readonly id: string }>, message: string): number {
  return writeReferences(chips, message, () => "@").length;
}

/**
 * How many references in the typed words point at this message's attachments.
 * @param chips - What the user attached to the message; only their ids are read.
 * @param message - What the user typed.
 * @returns The count.
 */
export function referenceCount(chips: ReadonlyArray<{ readonly id: string }>, message: string): number {
  return resolvedSegments(chips, message).filter((s) => s.kind === "reference").length;
}

/**
 * The attached items, laid out the way the model reads them.
 *
 * Shared because the browser and the server measure this same text against
 * one limit: a browser measuring its own layout would let through what the
 * server then refuses.
 * @param chips - What the user attached to one message, in order.
 * @returns The section, or an empty string when nothing is attached.
 */
export function attachmentSection(chips: readonly ChatAttachedChip[]): string {
  if (chips.length === 0) return "";
  const items = chips
    .map(
      (c, i) =>
        `### Attachment ${String(i + 1)}: ${titleOf(c)} (type: ${c.type})\n${JSON.stringify(c.data_snapshot, null, 2)}`,
    )
    .join("\n\n");
  return `## Attached content (a snapshot taken when it was attached)\n\n${items}`;
}

/**
 * One user message as the model is sent it: the attachments, then the words.
 * @param chips - What the user attached to the message.
 * @param message - What the user typed.
 * @returns The typed words alone when nothing is attached.
 */
export function userTurnForModel(chips: readonly ChatAttachedChip[], message: string): string {
  if (chips.length === 0) return message;
  const words = writeReferences(chips, message, (chip, n) => `[Attachment ${String(n)}: ${titleOf(chip)}]`);
  return `${attachmentSection(chips)}\n\n## User message\n\n${words}`;
}
