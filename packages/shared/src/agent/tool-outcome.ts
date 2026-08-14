// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * Telling a tool that failed from one that never finished.
 *
 * A stored tool part has three states and only two of them are terminal:
 * nothing on record may still say "running", so a call that was in flight
 * when the turn stopped is swept to `error` on its way to storage. That makes
 * two different endings share one state. They are not the same thing — one is
 * something going wrong, the other is the user pressing stop — and both a
 * reader and the model need to tell them apart.
 *
 * What separates them is whether a reason came with it: a failure says why,
 * an unfinished call has nothing to say because nothing went wrong. This
 * lives here rather than in either consumer because both the server (which
 * decides what to replay to the model) and the panel (which decides what to
 * show a person) have to judge it the same way, and a second copy of the rule
 * is a second chance for the two to drift apart.
 */

/** The part of a stored tool use this judgement reads. */
export interface ToolOutcomeFields {
  /** How far this use of the tool got. */
  status: "pending" | "success" | "error";
  /** Why it failed, when it did. */
  errorMessage?: string;
}

/**
 * Whether this use of the tool got far enough to report anything.
 * @param part - The stored tool use
 * @returns True when the call has an outcome; false when it never finished
 */
export function toolCallHasOutcome(part: ToolOutcomeFields): boolean {
  if (part.status === "success") return true;
  if (part.status === "error") return part.errorMessage !== undefined;
  return false;
}
