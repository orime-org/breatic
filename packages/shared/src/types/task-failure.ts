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
  /** What landed has no bytes in it, so there is no asset to show. */
  "empty",
] as const;

/** One of the causes above. */
export type TaskFailureReason = (typeof TASK_FAILURE_REASONS)[number];

const KNOWN: ReadonlySet<string> = new Set(TASK_FAILURE_REASONS);

/**
 * Read a stored `error_message` as one of our causes.
 * @param message - What the row holds, or null.
 * @returns The cause, or null when this is not one of ours.
 */
export function asTaskFailureReason(
  message: string | null,
): TaskFailureReason | null {
  return message !== null && KNOWN.has(message)
    ? (message as TaskFailureReason)
    : null;
}
