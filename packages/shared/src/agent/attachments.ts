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

/**
 * Rewrite each marker that points at one of this message's attachments.
 * Markers for anything else stay as the text they are.
 * @param chips - What the user attached to the message, in order.
 * @param message - What the user typed.
 * @param write - What a marker becomes, given its attachment and its place.
 * @returns The rewritten words.
 */
function rewriteMarkers(
  chips: readonly ChatAttachedChip[],
  message: string,
  write: (chip: ChatAttachedChip, n: number) => string,
): string {
  if (chips.length === 0) return message;
  return message.replace(MARKER, (marker, id: string) => {
    const at = chips.findIndex((c) => c.id === id);
    const chip = chips[at];
    return chip === undefined ? marker : write(chip, at + 1);
  });
}

/**
 * The typed words with each reference read as its attachment's name.
 * @param chips - What the user attached to the message.
 * @param message - What the user typed.
 * @returns The words as plain text.
 */
export function messageWithNames(chips: readonly ChatAttachedChip[], message: string): string {
  return rewriteMarkers(chips, message, (chip) => titleOf(chip));
}

/**
 * How long the typed words are, counting each reference as one character, the
 * way the reader sees it in the box.
 * @param chips - What the user attached to the message.
 * @param message - What the user typed.
 * @returns The length.
 */
export function messageLength(chips: readonly ChatAttachedChip[], message: string): number {
  return rewriteMarkers(chips, message, () => "@").length;
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
  const words = rewriteMarkers(chips, message, (chip, n) => `[Attachment ${String(n)}: ${titleOf(chip)}]`);
  return `${attachmentSection(chips)}\n\n## User message\n\n${words}`;
}
