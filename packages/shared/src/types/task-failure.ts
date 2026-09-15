// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Why a task failed, for the causes we author (#186 §7.1).
 *
 * A task's `error_message` is read by whoever opens the node's task list, in
 * whatever language they set. A sentence written at the point of failure is
 * frozen into one language at that moment — the server's, or whichever
 * requester happened to trigger it — and every other reader gets that one.
 *
 * So the causes we know are stored as a code and turned into a sentence where
 * the reader is. A provider's own error text is not one of these: it is what
 * the provider said, and it travels as itself.
 */

import {
  INGEST_FAILURE_CODES,
  INGEST_NO_ANSWER,
  INGEST_NOT_STARTED,
  INGEST_REFUSED_UNNAMED,
  INGEST_TYPE_NOT_REPORTED,
} from "@shared/upload/ingest-failure.js";

/** The causes this product recognises. */
export const TASK_FAILURE_REASONS = [
  /** The browser gave up sending, or its own retries ran out. */
  "aborted",
  /** What landed is larger than an upload is allowed to be. */
  "over_cap",
  /** The deadline passed with no result. */
  "expired",
  /** The run finished, and came back with nothing to put on the node. */
  "no_result",
  /** The address would not open. */
  "source_unreachable",
  /** The address was still sending when the time to fetch it ran out. */
  "source_too_slow",
  /** What the address served is not a kind a node can hold. */
  "unsupported_type",
  /** The address answered with nothing in it. */
  "empty",
  /**
   * Something on our side broke. The address was fine; sending it again is
   * what the person does next, and which part broke is in the log.
   */
  "internal",
] as const;

/** One of the causes above. */
export type TaskFailureReason = (typeof TASK_FAILURE_REASONS)[number];

/**
 * The cause each stored code is told to the reader as.
 *
 * There are more codes than causes on purpose. An operator has to tell R2
 * refusing the bytes from the parts refusing to assemble; a person reading
 * the node has the same thing to do either way, and a list of our internals
 * is not what they came for. So the log keeps the code and the reader gets
 * the cause.
 *
 * A code absent from here reaches the reader as itself, in every language —
 * which is what `task-failure.test.ts` holds every lane's codes against.
 */
const CAUSE_OF: ReadonlyMap<string, TaskFailureReason> = new Map([
  ...TASK_FAILURE_REASONS.map((r) => [r, r] as const),
  // Read off the codes themselves, so a rename over there is a compile error
  // here rather than a code that quietly starts reaching readers raw.
  [INGEST_NO_ANSWER, "source_too_slow"],
  [INGEST_REFUSED_UNNAMED, "internal"],
  [INGEST_TYPE_NOT_REPORTED, "internal"],
  [INGEST_NOT_STARTED, "internal"],
  ...INGEST_FAILURE_CODES.map(
    (code) =>
      [
        code,
        // The Worker's own two names for what our storage did; the other three
        // describe the address, and are causes in their own right.
        code === "store_failed" || code === "assemble_failed" ? "internal" : code,
      ] as const,
  ),
] as ReadonlyArray<readonly [string, TaskFailureReason]>);

/**
 * Read a stored `error_message` as one of our causes.
 * @param message - What the row holds, or null.
 * @returns The cause, or null when this is not one of ours.
 */
export function asTaskFailureReason(
  message: string | null,
): TaskFailureReason | null {
  return message !== null ? (CAUSE_OF.get(message) ?? null) : null;
}
