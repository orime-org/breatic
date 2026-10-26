// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The error an upload our server could not open is thrown as (inner#1595).
 *
 * By the time an upload is opened its grant and its task row exist, so the
 * opener settles them as aborted before throwing; the callers only write down
 * what settling decided and answer. They tell this apart with `instanceof`.
 */

import type { IngestReportOutcome } from "@domain/asset/ingest-report.service.js";

/** What the opener knows when it gives up. */
export interface UploadOpenFailure {
  /** The key the upload would have written. */
  storageKey: string;
  /**
   * Why it was not opened, as reported when settling; past the task's
   * deadline, registration records the grant and task row as expired instead.
   */
  reason: string;
  /** What settling decided, when settling went through. */
  settled?: IngestReportOutcome;
  /** The error settling threw, when it did. */
  settleError?: unknown;
  /** What opening threw. */
  cause: unknown;
}

/** An upload our server could not open, already settled as aborted. */
export class UploadOpenFailed extends Error {
  readonly storageKey: string;
  readonly reason: string;
  // Declared only: each is set when known, and absent otherwise.
  declare readonly settled?: IngestReportOutcome;
  declare readonly settleError?: unknown;

  /**
   * Describe an upload that was not opened.
   * @param failure - The key, the reason and how settling went.
   */
  constructor(failure: UploadOpenFailure) {
    super(`upload open failed: ${failure.storageKey} (${failure.reason})`, {
      cause: failure.cause,
    });
    this.name = "UploadOpenFailed";
    this.storageKey = failure.storageKey;
    this.reason = failure.reason;
    if (failure.settled !== undefined) this.settled = failure.settled;
    if (failure.settleError !== undefined) this.settleError = failure.settleError;
  }
}
