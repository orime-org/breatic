// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * One user message as the model is sent it.
 *
 * Only the server builds this text: the browser measures the attachments
 * against their limit with `attachmentSection`, which stays shared, but never
 * the whole turn.
 */

import type { ChatAttachedChip } from "@breatic/shared";
import { attachmentSection, attachmentTitle, writeReferences } from "@breatic/shared";

/** What one user message is made of. */
export interface UserTurn {
  /** What the user attached to the message, in order. */
  chips: readonly ChatAttachedChip[];
  /** What the user typed. */
  message: string;
}

/**
 * One user message as the model is sent it: the attachments, then the words.
 * @param turn - What the message is made of.
 * @returns The typed words alone when nothing is attached.
 * @throws {never} Never.
 */
export function userTurnForModel(turn: UserTurn): string {
  const { chips, message } = turn;
  if (chips.length === 0) return message;
  const words = writeReferences(chips, message, (chip, n) => `[Attachment ${String(n)}: ${attachmentTitle(chip)}]`);
  return `${attachmentSection(chips)}\n\n## User message\n\n${words}`;
}
