// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Why the ingest Worker refused, in a token the caller can act on (#207
 * design §7.6.4).
 *
 * The status alone does not carry it. Four separate failures answer 502 — the
 * source could not be read, R2 would not take the bytes, the parts would not
 * assemble, the object could not be hashed — and telling a caller that its
 * source was unreachable when our own storage was the thing that broke is a
 * false statement about somebody else's service.
 *
 * The tokens live here rather than on either side because both sides need the
 * same list: the Worker writes one, the client reads it, and a second copy is
 * a second place for the vocabulary to drift.
 */

/** The header the Worker names its refusal in. */
export const INGEST_FAILURE_HEADER = "x-ingest-failure";

/** Every refusal the Worker can name. */
export const INGEST_FAILURE_CODES = [
  /** The source did not answer, or answered with a status of its own. */
  "source_unreachable",
  /** What the source served is not one of the kinds a node can hold. */
  "unsupported_type",
  /** The transfer ran past what the ticket allows. */
  "over_cap",
  /** R2 would not take the bytes. */
  "store_failed",
  /** The parts would not assemble into an object, or it would not hash. */
  "assemble_failed",
] as const;

/**
 * What a caller records when the Worker refused and named nothing.
 *
 * It answered, so the transfer reached it and neither the address nor its
 * source is what went wrong — a route that threw and a deployment missing a
 * binding both land here. Reading the missing name as "nothing answered"
 * instead would report our own fault as somebody else's service.
 */
export const INGEST_REFUSED_UNNAMED = "ingest_refused";

/**
 * What a caller records when no answer arrived at all.
 *
 * The deadline for one call is set under what the platform itself allows, so
 * a transfer that ran out of time ends here rather than in a platform
 * refusal.
 */
export const INGEST_NO_ANSWER = "source_too_slow";

/**
 * What a caller records when the Worker reported a type it never read.
 *
 * The ticket asked it to take the type off the source; an answer carrying
 * back something no model can be given means it did not.
 */
export const INGEST_TYPE_NOT_REPORTED = "type_not_reported";

/**
 * What a caller records for a transfer that never began.
 *
 * The grant and the row were opened and then something before the first byte
 * failed — signing the ticket, or reaching the queue. Nothing was fetched, so
 * neither the address nor its source is what to report.
 */
export const INGEST_NOT_STARTED = "not_started";

/** One of {@link INGEST_FAILURE_CODES}. */
export type IngestFailureCode = (typeof INGEST_FAILURE_CODES)[number];

/**
 * Read a refusal token, if what arrived is one we know.
 *
 * Anything else is treated as absent: the header is read off a response, and a
 * value invented elsewhere says nothing this caller can act on.
 * @param value - What the header carried, or null when it carried nothing.
 * @returns The token, or null.
 */
export function readIngestFailureCode(
  value: string | null | undefined,
): IngestFailureCode | null {
  return INGEST_FAILURE_CODES.includes(value as IngestFailureCode)
    ? (value as IngestFailureCode)
    : null;
}
