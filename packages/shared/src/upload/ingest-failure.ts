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
