// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * A Document body media upload's result, written into the body by collab (breatic#1574).
 *
 * The block's address lives in the Document's Yjs document, so the backend
 * announces the upload on the task-events stream and collab writes the block,
 * the way a canvas node receives its upload (`node-task-counts`). The browser
 * that uploaded the bytes never writes the result.
 */

import * as Y from "yjs";

import type { TaskFailureReason } from "@shared/types/task-failure.js";

/** Why an upload did not finish, in the words its block has for it. */
export type PendingFailureReason =
  | "failed"
  | "storageFull"
  | "rateLimited"
  | "hashUnavailable"
  | "unsupportedType"
  | "tooLarge"
  | "empty"
  | "unreachable"
  /** The Space could not take an add when the upload was asked for (inner#1790). */
  | "spaceFull";

/** Why an upload did not finish, and whether running it again can help. */
export interface UploadFailure {
  readonly reason: PendingFailureReason;
  readonly retryable: boolean;
}

/** What a finished upload hands its block. */
export interface DocumentUploadResult {
  readonly url: string;
  readonly mediaWidth?: number;
  readonly mediaHeight?: number;
}

/** The backend took over, finished or failed one Document body upload. */
export interface DocumentUploadEvent {
  type: "document-upload";
  /** Yjs doc name of the Document the block lives in. */
  docName: string;
  /** The block's `uploadId`. */
  uploadId: string;
  state: "processing" | "completed" | "failed";
  /** On `processing`: epoch ms after which the block reads as timed out. */
  deadline?: number;
  /** On `completed`. */
  result?: DocumentUploadResult;
  /** On `failed`: the normalised cause. */
  reason?: TaskFailureReason;
}

/** Block attribute: the Document the upload belongs to. */
export const UPLOAD_HOME_ATTR = "uploadHome";
/** Block attribute: `processing` or `failed`, written by collab. */
export const UPLOAD_STATE_ATTR = "uploadState";
/** Block attribute: epoch ms after which a `processing` block reads as timed out. */
export const UPLOAD_DEADLINE_ATTR = "uploadDeadline";
/** Block attribute: the {@link UploadFailure} of a `failed` block. */
export const UPLOAD_FAILURE_ATTR = "uploadFailure";

const MEDIA_BLOCKS: ReadonlySet<string> = new Set(["image", "video", "audio"]);

/**
 * How an upload that ended in each cause fails: what the block says and
 * whether running it again can end differently. A cause added to the
 * vocabulary does not compile until it is placed here.
 */
const UPLOAD_FAILURE: Readonly<Record<TaskFailureReason, UploadFailure>> = {
  internal: { reason: "failed", retryable: true },
  expired: { reason: "failed", retryable: true },
  aborted: { reason: "failed", retryable: true },
  source_unreachable: { reason: "unreachable", retryable: true },
  source_cut_off: { reason: "failed", retryable: true },
  unsupported_type: { reason: "unsupportedType", retryable: false },
  over_cap: { reason: "tooLarge", retryable: false },
  empty: { reason: "empty", retryable: false },
  understand_over_cap: { reason: "failed", retryable: false },
  no_result: { reason: "failed", retryable: false },
  understand_unsupported_type: { reason: "failed", retryable: false },
  no_credits: { reason: "failed", retryable: false },
  declined: { reason: "failed", retryable: false },
  tool_failed: { reason: "failed", retryable: false },
  media_refused: { reason: "failed", retryable: false },
  no_audio_track: { reason: "failed", retryable: false },
  credits_held: { reason: "failed", retryable: false },
  cut_short: { reason: "failed", retryable: false },
  // An upload is not a task the running-slot cancel reaches; running it again starts over.
  cancelled: { reason: "failed", retryable: true },
  input_refused: { reason: "failed", retryable: false },
  model_not_configured: { reason: "failed", retryable: false },
};

/**
 * What the block says for an upload that ended in this cause.
 * @param cause - The normalised cause, or nothing when none was recorded.
 * @returns The block's reason and whether running it again can help.
 */
export function documentUploadFailure(cause: TaskFailureReason | null | undefined): UploadFailure {
  return cause === null || cause === undefined ? { reason: "failed", retryable: true } : UPLOAD_FAILURE[cause];
}

/**
 * Every media block in the body waiting for this upload.
 * @param fragment - The Document body.
 * @param event - The upload's event.
 * @returns The blocks whose id and home match and that hold no address.
 */
function targets(fragment: Y.XmlFragment, event: DocumentUploadEvent): Y.XmlElement[] {
  const out: Y.XmlElement[] = [];
  /**
   * Walks one level.
   * @param parent - The parent.
   */
  const walk = (parent: Y.XmlFragment | Y.XmlElement): void => {
    for (const child of parent.toArray()) {
      if (!(child instanceof Y.XmlElement)) continue;
      if (
        MEDIA_BLOCKS.has(child.nodeName)
        && child.getAttribute("uploadId") === event.uploadId
        && child.getAttribute(UPLOAD_HOME_ATTR) === event.docName
        && !child.getAttribute("url")
      ) out.push(child);
      walk(child);
    }
  };
  walk(fragment);
  return out;
}

/**
 * Write one upload's event into the blocks waiting for it.
 *
 * An address, once written, is never changed; an ending replaces
 * `processing`, and `processing` never replaces a failure. One grant ends
 * once, so any order or repetition of its events lands the same body.
 * @param fragment - The Document body.
 * @param event - The upload's event.
 * @returns How many blocks it wrote.
 */
export function applyDocumentUpload(fragment: Y.XmlFragment, event: DocumentUploadEvent): number {
  const blocks = targets(fragment, event).filter((block) =>
    event.state !== "processing" || block.getAttribute(UPLOAD_STATE_ATTR) === undefined);
  if (blocks.length === 0) return 0;
  /** Sets each block's attributes for this event. */
  const write = (): void => {
    for (const block of blocks) {
      if (event.state === "processing") {
        block.setAttribute(UPLOAD_STATE_ATTR, "processing");
        block.setAttribute(UPLOAD_DEADLINE_ATTR, event.deadline as never);
      } else if (event.state === "completed" && event.result !== undefined) {
        block.setAttribute("url", event.result.url);
        if (event.result.mediaWidth !== undefined) block.setAttribute("mediaWidth", event.result.mediaWidth as never);
        if (event.result.mediaHeight !== undefined) block.setAttribute("mediaHeight", event.result.mediaHeight as never);
        block.setAttribute("uploadId", "");
        block.removeAttribute(UPLOAD_STATE_ATTR);
        block.removeAttribute(UPLOAD_DEADLINE_ATTR);
        block.removeAttribute(UPLOAD_FAILURE_ATTR);
      } else if (event.state === "failed") {
        block.setAttribute(UPLOAD_STATE_ATTR, "failed");
        block.setAttribute(UPLOAD_FAILURE_ATTR, documentUploadFailure(event.reason) as never);
      }
    }
  };
  if (fragment.doc === null) write();
  else fragment.doc.transact(write);
  return blocks.length;
}
