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
    .map((c) => `### ${c.name} (type: ${c.type})\n${JSON.stringify(c.data_snapshot, null, 2)}`)
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
  return `${attachmentSection(chips)}\n\n## User message\n\n${message}`;
}
