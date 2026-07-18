// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * Guards for the Generate panel's execute action.
 */

/** Everything the execute gate must weigh before a task may be submitted. */
export interface ExecuteGateInput {
  /** The current prompt's plain text (rich-text prompt projected to text). */
  promptText: string;
  /** The effective model id; empty when the catalog is unavailable. */
  model: string;
  /** The target node's display status (`idle` / `handling` / `error`). */
  nodeStatus: string | undefined;
  /** Whether a submission is already in flight (front-end idempotency). */
  isSubmitting: boolean;
}

/**
 * Whether Generate may be executed. Requires visible prompt text AND a selected
 * model (an empty catalog leaves no model, so submitting would send an invalid
 * task), the node must still exist (`nodeStatus` is undefined once a collaborator
 * deletes it — never submit against a deleted node), and no submission may be in
 * flight (front-end idempotency — the backend lock is the airtight guard, but the
 * button must not invite a double-submit). A prior failure (`error`) stays
 * executable so a user can retry.
 *
 * `handling` and `locked` are NOT weighed here (user 2026-07-18): the button
 * stays clickable and the node-state gate in the execute handler surfaces a
 * `warnNodeGate` toast on click — the same feedback pattern as a locked node,
 * instead of a silently-greyed button. The gate still blocks the actual submit.
 * @param input - The current prompt, model, node status, and submitting flag.
 * @returns True only when every execute precondition holds.
 */
export function canExecuteGenerate(input: ExecuteGateInput): boolean {
  return (
    input.promptText.trim().length > 0 &&
    input.model.length > 0 &&
    input.nodeStatus != null &&
    !input.isSubmitting
  );
}
