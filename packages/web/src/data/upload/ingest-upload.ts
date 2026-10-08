// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * What the ticket endpoint answers (#173, design §4.2).
 *
 * The sending itself is `sendBytesToIngest` in `@breatic/shared`: the backend
 * sends its own output the same way (#181), and one implementation is what
 * makes that one path rather than two that drift. Finishing is not shared —
 * the Worker asks for a secret a page cannot hold, so the browser hands what
 * it collected to our server (`sendFileAndFinish`) and our server finishes on
 * its behalf. What stays here is the shape our own ticket endpoint answers
 * with, which only the browser asks for.
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
 * Where an upload lands, and what a picture is uploaded to become (filed as
 * the asset's source): a project, which may be uploading its cover, or a
 * studio, which uploads nothing but its avatar.
 */
export type UploadTargetParams =
  | { projectId: string; studioId?: never; purpose?: 'project_cover' }
  | { studioId: string; projectId?: never; purpose: 'studio_avatar' };

/**
 * Where an upload lands and what it is for.
 *
 * All of it is checked against this user's access when the ticket is issued
 * and then stored on the grant, so what the Worker reports back is read
 * against context we hold rather than context a client could restate.
 */
export type UploadContext = UploadTargetParams & {
  /** The node the bytes land on, when this upload has one. */
  nodeId?: string;
  /** The space that node lives in. */
  spaceId?: string;
  /** `mini_tool` for a mini-tool product. */
  source?: 'mini_tool';
  /** The mini-tool's name when `source` says so. */
  toolName?: string;
  /** True for a byproduct, registered without an activity-feed row of its own. */
  derived?: true;
};

/**
 * What a browser mini-tool's export carries on its ticket, so the task row
 * reads as that tool (inner#888 §7.5).
 */
export interface MiniToolUploadTag {
  source: 'mini_tool';
  toolName: string;
}

/** A ticket request: where the upload lands, and the file it is for. */
export type UploadTicketRequest = UploadContext & {
  filename: string;
  contentType: string;
  size: number;
  /** Mandatory — a hashless upload is refused before it is asked for. */
  hash: string;
};

/**
 * The ticket endpoint's other answer: this studio already holds this content,
 * so nothing moves and the existing URL is reused.
 */
export interface UploadAlreadyStored {
  alreadyExists: true;
  /** The ledger row being reused. */
  assetId: string;
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
