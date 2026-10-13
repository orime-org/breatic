// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * What every lane that fetches somebody's link into storage agrees on (#207):
 * the canvas paste through the worker's queue, and the agent's save
 * (inner#1315) in the request that asked for it.
 */

import { canonicalMediaType, isUploadableMediaType, reduceMediaType } from "@breatic/shared";

/**
 * Refusals that come from the link the reader handed us: it would not answer,
 * it held a kind we do not take, it was larger than the ticket allows, or it
 * sent nothing.
 */
const READER_SOURCE_REFUSALS: ReadonlySet<string> = new Set([
  "source_unreachable",
  "unsupported_type",
  "over_cap",
  "empty",
]);

/**
 * Whether a failed transfer is the link's own doing, as the one who handed it
 * over is told: it would not answer, held a kind we do not take, was larger
 * than the ticket allows, or sent nothing. No answer from the Worker at all is
 * the Worker or the line to it going away, which is ours (inner#1367).
 * @param reason - The failure reason recorded on the transfer.
 * @returns True where the link is at fault.
 * @throws {never} Never.
 */
export function isReaderLinkFault(reason: string): boolean {
  return READER_SOURCE_REFUSALS.has(reason);
}

/**
 * The log level a failed transfer is recorded at.
 *
 * Error logs become error-monitoring events, so a link the reader got wrong
 * is a warning; a failure on our side stays an error.
 * @param reason - The failure reason recorded on the task.
 * @returns `warn` for the reader's own link, `error` otherwise.
 * @throws {never} Never.
 */
export function urlIngestFailureLevel(reason: string): "warn" | "error" {
  return isReaderLinkFault(reason) ? "warn" : "error";
}

/**
 * What is signed into the ticket, for want of anything measured.
 *
 * Nobody here has seen a byte of what is behind the address, so this stands in
 * the type's place until the Worker reads the source's own answer. It is never
 * what gets stored: the ticket also carries the flag that makes the Worker
 * take the type off the source and refuse anything that is not uploadable.
 */
export const TYPE_UNKNOWN = "application/octet-stream";

/**
 * The type to register this answer under, or null when there is none.
 *
 * One test covers both ways this can go wrong, because the placeholder the
 * ticket carries is itself outside the uploadable formats: a Worker that did
 * not take the type off the source hands `application/octet-stream` back and
 * is refused by the same line that refuses a format no model reads.
 *
 * What comes back is the judged value rather than a yes, because that value is
 * the only one that may be stored: a yes would leave the caller holding a
 * spelling nothing checked, which is exactly the case this guard exists for.
 * @param contentType - What the Worker reported.
 * @returns The type to store, or null when this answer cannot be registered.
 * @throws {never} Never.
 */
export function storedTypeOf(contentType: string): string | null {
  const name = canonicalMediaType(reduceMediaType(contentType));
  return isUploadableMediaType(name) ? name : null;
}
