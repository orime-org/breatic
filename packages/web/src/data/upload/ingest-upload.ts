// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * What the ticket endpoint answers (#173, design §4.2).
 *
 * The sending itself is `sendBytesToIngest` in `@breatic/shared`: the backend
 * uploads its own output through the same three Worker endpoints (#181), and
 * one implementation is what makes that one path rather than two that drift.
 * What stays here is the shape our own ticket endpoint answers with, which
 * only the browser asks for.
 */


/** What the ticket endpoint hands back when bytes have to move. */
export interface UploadTicket {
  /** The signed permission slip the Worker verifies. */
  ticket: string;
  /** The key the bytes land under — the server minted it. */
  storageKey: string;
  /** The ingest Worker's base address. */
  uploadUrl: string;
  /** The asset kind the server filed this under. */
  kind: string;
  /** How long every part but the last must be. */
  partSize: number;
  /** How many parts the file was cut into. */
  totalParts: number;
  /**
   * The task row this upload opened on its node (#186). A failed upload's
   * File is stashed under it, so two uploads onto one node each keep their
   * own for a retry. Absent on an upload with no node behind it.
   */
  taskId?: string;
}

/**
 * The ticket endpoint's other answer: this studio already holds this content,
 * so nothing moves and the existing URL is reused.
 */
export interface UploadAlreadyStored {
  alreadyExists: true;
  fileUrl: string;
  kind: string;
}

/** Either answer the ticket endpoint can give. */
export type UploadTicketResponse = UploadTicket | UploadAlreadyStored;

/**
 * Tell the two ticket answers apart.
 * @param res - What the ticket endpoint answered.
 * @returns True when nothing needs uploading.
 */
export function isAlreadyStored(
  res: UploadTicketResponse,
): res is UploadAlreadyStored {
  return 'alreadyExists' in res && res.alreadyExists;
}
