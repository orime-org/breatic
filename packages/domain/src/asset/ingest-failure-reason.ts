// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The reason a failed call to the ingest Worker is settled with.
 *
 * Finishing an upload, pulling a reader's link and opening an upload all read
 * a failure the same way; only the word for "nothing answered" differs, and
 * each caller passes its own.
 */

import { INGEST_REFUSED_UNNAMED, UploadHttpError } from "@breatic/shared";

/**
 * Name why a call to the Worker failed.
 *
 * An `UploadHttpError` exists only because an answer arrived, so a missing
 * name on it is the Worker refusing without saying why. Anything else means
 * no answer arrived, and the caller says what that is on its lane.
 * @param err - What the call threw.
 * @param noAnswer - The reason when no answer arrived.
 * @returns The Worker's named refusal, the unnamed sentinel, or `noAnswer`.
 */
export function ingestFailureReason(err: unknown, noAnswer: string): string {
  return err instanceof UploadHttpError ? (err.code ?? INGEST_REFUSED_UNNAMED) : noAnswer;
}
